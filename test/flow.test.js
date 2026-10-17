'use strict';
// End-to-end test of the sync flow against an in-memory fake sheet and a fake HTTP layer.
const test = require('node:test');
const assert = require('node:assert');

// ---------- fake Google Sheet ----------
function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function parseRange(r) {
  const m = r.match(/^'((?:[^']|'')*)'!(.+)$/);
  const tab = m[1].replace(/''/g, "'");
  const [a, b] = m[2].split(':');
  const cell = s => { const x = s.match(/^([A-Z]*)(\d*)$/); return { c: x[1] ? colNum(x[1]) : null, r: x[2] ? +x[2] : null }; };
  const p = cell(a), q = cell(b || a);
  return { tab, r1: p.r || 1, r2: q.r || Infinity, c1: p.c || 1, c2: q.c || 26 };
}
class FakeSheets {
  constructor(tabs) { this.tabs = tabs; this.hidden = {}; this.writes = 0; }
  async meta() { return { timeZone: 'Asia/Singapore', sheets: Object.keys(this.tabs).map(title => ({ title, hidden: !!this.hidden[title] })) }; }
  async batchGet(ranges) {
    return ranges.map(range => {
      const { tab, r1, r2, c1, c2 } = parseRange(range);
      const grid = this.tabs[tab] || [];
      const out = [];
      for (let r = r1; r <= Math.min(r2, grid.length); r++) {
        const row = grid[r - 1] || [];
        out.push(row.slice(c1 - 1, c2));
      }
      while (out.length && out[out.length - 1].every(v => v === '' || v == null)) out.pop();
      return out;
    });
  }
  async batchUpdate(data) {
    this.writes++;
    for (const { range, values } of data) {
      const { tab, r1, c1 } = parseRange(range);
      const grid = this.tabs[tab];
      values.forEach((row, i) => row.forEach((v, j) => {
        while (grid.length < r1 + i) grid.push([]);
        grid[r1 - 1 + i][c1 - 1 + j] = v;
      }));
    }
  }
  async clear(range) {
    const { tab, r1, c1, c2 } = parseRange(range);
    const grid = this.tabs[tab];
    for (let r = r1; r <= grid.length; r++) for (let c = c1; c <= c2; c++) if (grid[r - 1]) grid[r - 1][c - 1] = '';
  }
  async addHiddenSheet(title) { this.tabs[title] = []; this.hidden[title] = true; }
}

// ---------- fake HTTP ----------
const CHARS = {
  Arno: { id: 'ID_ARNO=', gs: 2177, cp: 101799 },
  Zen:  { id: 'ID_ZEN=',  gs: 1733, cp: 76123 },
  Smol: { id: 'ID_SMOL=', gs: 0,    cp: 1832 },   // low level: no item level
};
let calls;
function installFetch() {
  calls = { shugo: 0, api: 0 };
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'shugo.gg') {
      calls.shugo++;
      const name = decodeURIComponent(u.pathname.split('/').pop());
      const c = CHARS[name];
      if (!c) return { status: 404, ok: false };
      const html = `<meta name="shugo-character" content="{&quot;id&quot;:&quot;${c.id}&quot;,&quot;serverId&quot;:1501,&quot;region&quot;:&quot;GLOBAL&quot;}">`;
      return { status: 200, ok: true, text: async () => html };
    }
    if (u.hostname === 'aion2.plaync.com') {
      calls.api++;
      const id = u.searchParams.get('characterId');
      const [name, c] = Object.entries(CHARS).find(([, v]) => v.id === id) || [];
      if (!c) return { status: 200, ok: true, json: async () => ({ profile: null }) };
      const stat = c.gs ? { statList: [{ type: 'ItemLevel', value: c.gs }] } : { statList: [] };
      return { status: 200, ok: true, json: async () => ({ profile: { characterName: name, combatPower: c.cp, characterLevel: 45 }, stat }) };
    }
    throw new Error('unexpected url ' + url);
  };
}

function makeSheet() {
  //             A         B       C         D        E          F            G        H             I               J  K  L  M
  const mainHdr = ['Discord ID', 'IGN Name', 'Status', 'Legion', 'Region', 'Class', 'Server', 'Gear Score', 'Combat Power', 'Exp', 'Remarks', 'Alts', 'Updated Time'];
  const row = (d, ign, srv, gs = '', cp = '') => [d, ign, '', '', 'Asia', 'Gladiator', srv, gs, cp, '', '', '', ''];
  const altHdr = ['Discord ID', 'IGN Name', 'Region', 'Class', 'Server', 'Gear Score', 'Combat Power'];
  return new FakeSheets({
    Main: [
      mainHdr,
      row('Arno', 'Arno', 'siel', 2135, 102641),
      row('Zen', 'Zen', 'siel'),
      row('Ghost', 'Ghost', 'siel', 1500, 70000),   // deleted char with old good values -> keep
      row('Typo', 'Typoo', 'siel'),                 // never valid -> Invalid IGN
      row('E', 'TBC', 'siel'),
      row('NoSrv', 'Someone', ''),
    ],
    Alt_1: [altHdr, ['Zhalanx', 'Smol', 'SG', 'Cleric', 'siel', '', '']],
    Alt_2: [['Discord ID', 'IGN Name', 'Region', 'Class', 'Oops', 'Gear Score', 'Combat Power'], ['x', 'Zen', 'SG', 'Glad', 'siel', 'keep', 'keep']],
    Alt_3: [altHdr],
  });
}

test('full sync: writes numbers, keeps last good, marks invalid, caches IDs', async () => {
  installFetch();
  const { main } = require('../src/index');
  const sheets = makeSheet();
  const out = await main(sheets);

  const M = sheets.tabs.Main;
  const gsCp = r => [M[r][7], M[r][8]];
  assert.deepEqual(gsCp(1), [2177, 101799], 'Arno updated');
  assert.deepEqual(gsCp(2), [1733, 76123], 'Zen filled');
  assert.deepEqual(gsCp(3), [1500, 70000], 'Ghost keeps last good values');
  assert.deepEqual(gsCp(4), ['Invalid IGN', 'Invalid IGN'], 'typo marked invalid');
  assert.deepEqual(gsCp(5), ['Invalid IGN', 'Invalid IGN'], 'TBC marked invalid');
  assert.deepEqual(gsCp(6), ['', ''], 'no server -> blank');
  assert.match(M[1][12], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'timestamp written');
  assert.equal(M[3][12], '', 'no timestamp when not refreshed');
  assert.equal(M[1][0], 'Arno'); assert.equal(M[1][10], '', 'other columns untouched');

  assert.deepEqual(sheets.tabs.Alt_1[1].slice(5, 7), [0, 1832], 'low-level alt: GS 0');
  assert.deepEqual(sheets.tabs.Alt_2[1].slice(5, 7), ['keep', 'keep'], 'tab with wrong headers is skipped');

  assert.ok(sheets.tabs._id_cache, 'cache tab created');
  assert.equal(sheets.hidden._id_cache, true);
  assert.equal(sheets.tabs._id_cache.slice(1).filter(r => r[0]).length, 3, '3 IDs cached');
  assert.equal(out.ok, 3);
  assert.equal(calls.shugo, 5, 'ID lookups for Arno, Zen, Ghost, Typoo, Smol');

  // Second run: all IDs known -> no Shugo calls for valid characters.
  installFetch();
  CHARS.Arno.cp = 103000;
  await main(sheets);
  assert.equal(M[1][8], 103000, 'second run picks up new CP');
  assert.equal(calls.shugo, 2, 'only the two unknown names are retried on Shugo');
  assert.equal(calls.api, 3);
});

test('rows inserted during the run are not overwritten wrongly', async () => {
  installFetch();
  const { main } = require('../src/index');
  const sheets = makeSheet();
  // Insert a row above Arno right after the first read.
  const realGet = sheets.batchGet.bind(sheets);
  let reads = 0;
  sheets.batchGet = async (ranges) => {
    const r = await realGet(ranges);
    if (ranges.some(x => x.startsWith("'Main'!B")) && ++reads === 1) {
      sheets.tabs.Main.splice(1, 0, ['New', 'Newbie', '', '', 'SG', 'Glad', 'siel', '', '', '', '', '', '']);
    }
    return r;
  };
  await main(sheets);
  const M = sheets.tabs.Main;
  assert.equal(M[1][1], 'Newbie');
  assert.deepEqual([M[1][7], M[1][8]], ['', ''], 'inserted row not given Arno\'s numbers');
  assert.deepEqual([M[2][7], M[2][8]], [2135, 102641], 'shifted Arno row kept old values this run');
});


test('battleground boost is not written; real value restored; long jumps accepted after 12h', async () => {
  CHARS.Arno.cp = 101799; CHARS.Arno.gs = 2177;
  const { main } = require('../src/index');
  const sheets = makeSheet();                 // Arno starts at GS 2135 / CP 102641
  const M = sheets.tabs.Main;

  // Run 1: Arno is in a battleground -> CP 300k is held, sheet keeps 102641.
  installFetch(); CHARS.Arno.cp = 300000;
  const o1 = await main(sheets);
  assert.deepEqual([M[1][7], M[1][8]], [2135, 102641], 'boosted reading not written');
  assert.equal(o1.held, 1);
  assert.equal(sheets.hidden._pending, true, 'hidden _pending tab created');
  assert.equal(sheets.tabs._pending[1][0], 'as|siel|Arno');

  // Run 2: back out of battleground -> real numbers written, hold cleared.
  installFetch(); CHARS.Arno.cp = 101799;
  const o2 = await main(sheets);
  assert.deepEqual([M[1][7], M[1][8]], [2177, 101799]);
  assert.equal(o2.held, 0);
  assert.equal((sheets.tabs._pending[1] || [])[0] || '', '', 'hold cleared');

  // Run 3: a huge jump that has already lasted 13h (e.g. a real massive upgrade) is accepted.
  installFetch(); CHARS.Arno.cp = 250000;
  sheets.tabs._pending[1] = ['as|siel|Arno', 2177, 250000, new Date(Date.now() - 13 * 3600000).toISOString()];
  const o3 = await main(sheets);
  assert.equal(M[1][8], 250000, 'accepted after the hold time');
  assert.equal(o3.held, 0);
  CHARS.Arno.cp = 101799;
});
