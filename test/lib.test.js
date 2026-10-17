'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/lib');

test('colLetter', () => {
  assert.equal(L.colLetter(1), 'A');
  assert.equal(L.colLetter(9), 'I');
  assert.equal(L.colLetter(13), 'M');
  assert.equal(L.colLetter(27), 'AA');
});

test('colRange quotes sheet names', () => {
  assert.equal(L.colRange('Main', 8, 2), "'Main'!H2:H");
  assert.equal(L.colRange("It's", 2, 2, 10), "'It''s'!B2:B10");
});

test('parseId reads Shugo meta tag', () => {
  const html = '<meta name="shugo-character" content="{&quot;id&quot;:&quot;nJOC5G0srR3cLYkKRj4zDyRm4KmPMp6T1ZPowrx91JI=&quot;,&quot;serverId&quot;:1501,&quot;region&quot;:&quot;GLOBAL&quot;}">';
  assert.deepEqual(L.parseId(html), { id: 'nJOC5G0srR3cLYkKRj4zDyRm4KmPMp6T1ZPowrx91JI=', serverId: '1501' });
  assert.equal(L.parseId('<html>nothing</html>'), null);
});

test('parseApi reads NCSOFT JSON', () => {
  const j = { profile: { characterName: 'Arno', combatPower: 101799 },
    stat: { statList: [{ type: 'STR', value: 14 }, { type: 'ItemLevel', value: 2177 }] } };
  assert.deepEqual(L.parseApi(j), { gs: 2177, cp: 101799, name: 'Arno', level: 0 });
  assert.deepEqual(L.parseApi({ profile: { combatPower: 1832, characterLevel: 1 } }), { gs: 0, cp: 1832, name: '', level: 1 });
  assert.equal(L.parseApi({}), null);
  assert.equal(L.parseApi(null), null);
});

test('formatTimestamp uses sheet time zone', () => {
  const d = new Date('2026-10-15T09:00:05Z');
  assert.equal(L.formatTimestamp(d, 'Asia/Singapore'), '2026-10-15 17:00:05');
  assert.equal(L.formatTimestamp(d, 'Asia/Colombo'), '2026-10-15 14:30:05');
});

test('buildWrite: success, keep-last-good, invalid, empty, tbc', () => {
  const snapshot = {
    ign:    ['Arno', 'Ghost', 'Newbie', '', 'TBC', 'Fail'],
    server: ['siel', 'siel',  'siel',   '', 'siel', 'siel'],
    gs:     [2135,   1500,    '',       5,  '',     900],
    cp:     [102641, 70000,   '',       5,  '',     40000],
  };
  const fresh = { ...snapshot, upd: ['', '', '', '', '', 'old'] };
  const results = new Map([
    [0, { gs: 2177, cp: 101799 }],
    [1, 'notfound'],   // had good numbers -> keep them
    [2, 'notfound'],   // never had numbers -> Invalid IGN
    [4, 'tbc'],
    // row 5: network failure -> no result -> untouched
  ]);
  const w = L.buildWrite({ snapshot, results, fresh, invalidText: 'Invalid IGN', stamp: 'NOW' });
  assert.deepEqual(w.gs.map(r => r[0]), [2177, 1500, 'Invalid IGN', '', 'Invalid IGN', 900]);
  assert.deepEqual(w.cp.map(r => r[0]), [101799, 70000, 'Invalid IGN', '', 'Invalid IGN', 40000]);
  assert.deepEqual(w.upd.map(r => r[0]), ['NOW', '', '', '', '', 'old']);
  assert.equal(w.changed, 1);
});

test('buildWrite: rows that moved during the run are left alone', () => {
  const snapshot = { ign: ['Arno', 'Zen'], server: ['siel', 'siel'], gs: [1, 2], cp: [10, 20] };
  // Someone sorted the sheet while we were fetching: Zen is now first.
  const fresh = { ign: ['Zen', 'Arno', 'New'], server: ['siel', 'siel', 'siel'], gs: [2, 1, ''], cp: [20, 10, ''], upd: null };
  const results = new Map([[0, { gs: 2177, cp: 101799 }], [1, { gs: 1733, cp: 76123 }]]);
  const w = L.buildWrite({ snapshot, results, fresh, invalidText: 'Invalid IGN', stamp: null });
  // Nothing matched its original row, so existing values are kept (fixed next run).
  assert.deepEqual(w.gs.map(r => r[0]), [2, 1, '']);
  assert.deepEqual(w.cp.map(r => r[0]), [20, 10, '']);
});

test('mapLimit respects the limit and keeps order', async () => {
  let inFlight = 0, peak = 0;
  const out = await L.mapLimit([5, 1, 4, 2, 3], 2, async x => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, x * 5));
    inFlight--; return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.ok(peak <= 2);
});

test('boostVerdict: battleground jumps are held, real changes accepted', () => {
  const f = { enabled: true, maxCpRatio: 1.5, maxGsRatio: 1.25, holdHours: 12, minLevel: 45 };
  const prev = { gs: 2323, cp: 111000 };
  const H = 3600000, at = 100 * H;
  const v = (now, held) => L.boostVerdict({ prev, now: { level: 45, ...now }, held, at, f }).action;
  assert.equal(v({ gs: 2330, cp: 112046 }), 'accept', 'normal upgrade');
  assert.equal(v({ gs: 2500, cp: 150000 }), 'accept', '+35% CP is still a plausible upgrade');
  assert.equal(v({ gs: 2323, cp: 300000 }), 'hold', 'battleground CP');
  assert.equal(v({ gs: 3000, cp: 112000 }), 'hold', 'battleground GS');
  assert.equal(v({ gs: 2323, cp: 300000 }, { firstSeen: at - 5 * H }), 'hold', 'still within 12h');
  assert.equal(v({ gs: 2323, cp: 300000 }, { firstSeen: at - 13 * H }), 'accept-after-hold', 'lasted 12h+');
  assert.equal(v({ gs: 2000, cp: 90000 }), 'accept', 'drops always written');
  assert.equal(L.boostVerdict({ prev, now: { level: 40, gs: 2323, cp: 300000 }, at, f }).action, 'accept', 'levelling chars not filtered');
  assert.equal(L.boostVerdict({ prev: { gs: 'Invalid IGN', cp: '' }, now: { level: 45, gs: 2323, cp: 300000 }, at, f }).action, 'accept', 'no previous numbers');
  assert.equal(L.boostVerdict({ prev, now: { level: 45, gs: 2323, cp: 300000 }, at, f: { ...f, enabled: false } }).action, 'accept', 'filter off');
});
