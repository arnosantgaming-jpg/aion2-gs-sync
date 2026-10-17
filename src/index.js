'use strict';
/**
 * AION 2 GS / CP sync
 * Reads IGN + server from the Google Sheet, gets live Gear Score and Combat Power
 * from NCSOFT's official API, and writes them back.
 *
 * Env:
 *   SHEET_ID                  spreadsheet ID (from its URL)
 *   GOOGLE_CREDENTIALS        service-account JSON (the whole file contents)
 *   DRY_RUN=1                 optional: fetch everything but don't write to the sheet
 *   VERBOSE=1                 optional: log every row
 */
const fs = require('fs');
const cfg = require('../config');
const { Sheets } = require('./sheets');
const L = require('./lib');

const API = 'https://aion2.plaync.com/api/character/info';
const UA = 'Mozilla/5.0 (compatible; aion2-gs-sync/1.0; +https://github.com)';
const DRY_RUN = process.env.DRY_RUN === '1';
const VERBOSE = process.env.VERBOSE === '1';

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP

/** GET with timeout + retries (backs off on 429 / 5xx / network errors). */
async function get(url, { json = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html' } });
      clearTimeout(t);
      if (res.status === 404) return { status: 404 };
      if (res.status === 429 || res.status >= 500) {
        lastErr = 'HTTP ' + res.status;
        await sleep(attempt * (res.status === 429 ? 5000 : 2000));
        continue;
      }
      if (!res.ok) return { status: res.status };
      const body = json ? await res.json().catch(() => null) : await res.text();
      return { status: res.status, body };
    } catch (err) {
      clearTimeout(t);
      lastErr = err.name === 'AbortError' ? 'timeout' : String(err.message || err);
      await sleep(attempt * 2000);
    }
  }
  return { status: 0, error: lastErr };
}

const shugoUrl = (name, server) =>
  'https://shugo.gg/character/global/' + cfg.region + '-' +
  encodeURIComponent(L.clean(server).toLowerCase()) + '/' + encodeURIComponent(L.clean(name));

const apiUrl = ref =>
  API + '?lang=en-US&characterId=' + encodeURIComponent(ref.id) +
  '&serverId=' + ref.serverId + '&region=' + cfg.region;

// ---------------------------------------------------------------- ID cache (hidden tab)

async function loadCache(sheets, meta) {
  const exists = meta.sheets.some(s => s.title === cfg.cacheSheet);
  if (!exists) {
    if (DRY_RUN) { log(`(dry run) would create hidden tab "${cfg.cacheSheet}"`); return new Map(); }
    await sheets.addHiddenSheet(cfg.cacheSheet);
    await sheets.batchUpdate([{ range: L.quoteSheet(cfg.cacheSheet) + '!A1:D1', values: [['key', 'characterId', 'serverId', 'name']] }], 'RAW');
    log(`Created hidden tab "${cfg.cacheSheet}" for character IDs`);
    return new Map();
  }
  const [rows] = await sheets.batchGet([L.quoteSheet(cfg.cacheSheet) + '!A2:D']);
  const map = new Map();
  for (const r of rows) if (r[0] && r[1] && r[2]) map.set(String(r[0]), { id: String(r[1]), serverId: String(r[2]) });
  return map;
}

async function saveCache(sheets, cache) {
  if (DRY_RUN) return;
  const rows = [...cache.entries()].sort().map(([k, v]) => [k, v.id, v.serverId, k.split('|').slice(2).join('|')]);
  const range = L.quoteSheet(cfg.cacheSheet) + '!A2:D';
  await sheets.clear(range);
  if (rows.length) await sheets.batchUpdate([{ range: L.quoteSheet(cfg.cacheSheet) + '!A2:D' + (rows.length + 1), values: rows }], 'RAW');
}

// ---------------------------------------------------------------- held boosts (hidden tab)
// key -> { gs, cp, firstSeen (ms) } for characters whose last reading looked like a battleground boost.

async function loadPending(sheets, meta) {
  const f = cfg.boostFilter;
  if (!f || !f.enabled) return new Map();
  if (!meta.sheets.some(s => s.title === f.sheet)) {
    if (DRY_RUN) return new Map();
    await sheets.addHiddenSheet(f.sheet);
    await sheets.batchUpdate([{ range: L.quoteSheet(f.sheet) + '!A1:D1', values: [['key', 'heldGS', 'heldCP', 'firstSeen']] }], 'RAW');
    log(`Created hidden tab "${f.sheet}" for held battleground readings`);
    return new Map();
  }
  const [rows] = await sheets.batchGet([L.quoteSheet(f.sheet) + '!A2:D']);
  const map = new Map();
  for (const r of rows) {
    const t = Date.parse(r[3]);
    if (r[0] && !isNaN(t)) map.set(String(r[0]), { gs: Number(r[1]), cp: Number(r[2]), firstSeen: t });
  }
  return map;
}

async function savePending(sheets, pending) {
  const f = cfg.boostFilter;
  if (DRY_RUN || !f || !f.enabled) return;
  const cutoff = Date.now() - 7 * 86400000;           // forget very old entries
  const rows = [...pending.entries()].filter(([, v]) => v.firstSeen > cutoff).sort()
    .map(([k, v]) => [k, v.gs, v.cp, new Date(v.firstSeen).toISOString()]);
  await sheets.clear(L.quoteSheet(f.sheet) + '!A2:D');
  if (rows.length) await sheets.batchUpdate([{ range: L.quoteSheet(f.sheet) + '!A2:D' + (rows.length + 1), values: rows }], 'RAW');
}

// ---------------------------------------------------------------- per-sheet

function headerOk(name, layout, header) {
  const h = c => L.clean(header[c - 1]);
  const problems = [];
  if (!/server/i.test(h(layout.server))) problems.push(`column ${L.colLetter(layout.server)} is "${h(layout.server)}", expected Server`);
  if (!/gear/i.test(h(layout.gs)))       problems.push(`column ${L.colLetter(layout.gs)} is "${h(layout.gs)}", expected Gear Score`);
  if (!/combat/i.test(h(layout.cp)))     problems.push(`column ${L.colLetter(layout.cp)} is "${h(layout.cp)}", expected Combat Power`);
  if (problems.length) log(`⚠️  SKIPPED "${name}": ${problems.join('; ')}. Update config.js.`);
  return !problems.length;
}

/** Read IGN/server/GS/CP/updated columns for one sheet. */
async function readColumns(sheets, name, layout) {
  const s = cfg.startRow;
  const ranges = [
    L.colRange(name, layout.ign, s), L.colRange(name, layout.server, s),
    L.colRange(name, layout.gs, s), L.colRange(name, layout.cp, s),
  ];
  if (layout.updated) ranges.push(L.colRange(name, layout.updated, s));
  const res = await sheets.batchGet(ranges);
  const n = Math.max(res[0].length, res[1].length);
  return {
    ign: L.column(res[0], n), server: L.column(res[1], n),
    gs: L.column(res[2], n), cp: L.column(res[3], n),
    upd: layout.updated ? L.column(res[4], n) : null,
  };
}

// ---------------------------------------------------------------- main

function sheetsFromEnv() {
  const sheetId = process.env.SHEET_ID;
  const credRaw = process.env.GOOGLE_CREDENTIALS;
  if (!sheetId || !credRaw) throw new Error('Missing SHEET_ID or GOOGLE_CREDENTIALS environment variable');
  let creds;
  try { creds = JSON.parse(credRaw); } catch { throw new Error('GOOGLE_CREDENTIALS is not valid JSON (paste the whole service-account .json file)'); }
  return new Sheets(sheetId, creds);
}

async function main(sheets) {
  const t0 = Date.now();
  const meta = await sheets.meta();
  log(`===== SYNC START ${new Date().toISOString()} ${DRY_RUN ? '(DRY RUN)' : ''} =====`);
  log(`Sheet time zone: ${meta.timeZone}`);

  const cache = await loadCache(sheets, meta);
  log(`Known character IDs: ${cache.size}`);
  const pending = await loadPending(sheets, meta);
  if (pending.size) log(`Held battleground readings from earlier runs: ${pending.size}`);

  // 1) Read every configured tab.
  const tabs = [];
  for (const [name, layout] of Object.entries(cfg.layouts)) {
    if (!meta.sheets.some(s => s.title === name)) { log(`⚠️  Tab "${name}" not found, skipping`); continue; }
    const [hdr] = await sheets.batchGet([L.quoteSheet(name) + '!' + (cfg.startRow - 1) + ':' + (cfg.startRow - 1)]);
    if (!headerOk(name, layout, hdr[0] || [])) continue;
    tabs.push({ name, layout, snap: await readColumns(sheets, name, layout), results: new Map() });
  }

  // 2) Build the job list (one per distinct character, shared across tabs).
  const jobs = new Map(); // key -> { name, server, rows: [{tab, i}] }
  const stats = { rows: 0, tbc: 0, incomplete: 0 };
  for (const tab of tabs) {
    tab.snap.ign.forEach((ign, i) => {
      const name = L.clean(ign), srv = L.clean(tab.snap.server[i]);
      if (!name && !srv) return;
      stats.rows++;
      if (!name || !srv) { stats.incomplete++; if (name && VERBOSE) log(`[${tab.name}] row ${i + cfg.startRow} "${name}": no server`); return; }
      if (cfg.tbcPattern.test(name)) { stats.tbc++; tab.results.set(i, 'tbc'); return; }
      const key = L.cacheKey(cfg.region, srv, name);
      if (!jobs.has(key)) jobs.set(key, { key, name, server: srv, rows: [] });
      jobs.get(key).rows.push({ tab, i });
    });
  }
  const all = [...jobs.values()];
  const known = all.filter(j => cache.has(j.key)).length;
  log(`Rows: ${stats.rows} | characters to fetch: ${all.length} (${known} with known ID) | TBC: ${stats.tbc} | incomplete: ${stats.incomplete}`);

  const where = j => j.rows.map(r => `${r.tab.name}!${r.i + cfg.startRow}`).join(',');
  const outcome = { ok: 0, notFound: 0, failed: 0, held: 0, idLookups: 0, idsSaved: 0, renamed: 0 };
  const setResult = (j, r) => j.rows.forEach(({ tab, i }) => tab.results.set(i, r));

  // 3) Look up missing IDs via Shugo (only new characters).
  async function lookupId(j) {
    outcome.idLookups++;
    const r = await get(shugoUrl(j.name, j.server));
    if (r.status === 404) return 'notfound';
    if (r.status !== 200) return { error: r.error || 'Shugo HTTP ' + r.status };
    const ref = L.parseId(r.body);
    if (!ref) return { error: 'ID not found on Shugo page' };
    cache.set(j.key, ref); outcome.idsSaved++;
    return ref;
  }

  const needId = all.filter(j => !cache.has(j.key));
  if (needId.length) {
    log(`Looking up ${needId.length} new character ID(s) on Shugo...`);
    await L.mapLimit(needId, cfg.shugoConcurrency, async j => {
      const r = await lookupId(j);
      if (r === 'notfound') { j.done = true; outcome.notFound++; setResult(j, 'notfound'); log(`❌ ${where(j)} "${j.name}" on ${j.server}: not found (check spelling/capitals/server)`); }
      else if (r.error) { j.error = r.error; }
    });
    await saveCache(sheets, cache); // save immediately so progress is never lost
  }

  // 4) Live GS/CP from NCSOFT.
  async function fetchStats(j, allowRelookup = true) {
    const ref = cache.get(j.key);
    if (!ref) return { error: j.error || 'no character ID' };
    const r = await get(apiUrl(ref), { json: true });
    if (r.status !== 200) return { error: r.error || 'NCSOFT API HTTP ' + r.status };
    const v = L.parseApi(r.body);
    const nameMismatch = v && v.name && v.name.toLowerCase() !== j.name.toLowerCase();
    if (!v || nameMismatch) {
      // Stale ID (character deleted/renamed and the name reused): look it up again once.
      cache.delete(j.key); outcome.renamed++;
      if (!allowRelookup) return { error: 'API returned no matching character' };
      const again = await lookupId(j);
      if (again === 'notfound') return 'notfound';
      if (again.error) return again;
      return fetchStats(j, false);
    }
    return v;
  }

  const toFetch = all.filter(j => !j.done);
  log(`Fetching live stats for ${toFetch.length} character(s) from NCSOFT...`);
  await L.mapLimit(toFetch, cfg.apiConcurrency, async j => {
    const r = await fetchStats(j);
    if (r === 'notfound') { outcome.notFound++; setResult(j, 'notfound'); log(`❌ ${where(j)} "${j.name}": not found`); }
    else if (r.error) { outcome.failed++; log(`⚠️  ${where(j)} "${j.name}" on ${j.server}: ${r.error} (kept existing values)`); }
    else {
      const first = j.rows[0];
      const prev = { gs: first.tab.snap.gs[first.i], cp: first.tab.snap.cp[first.i] };
      const verdict = L.boostVerdict({ prev, now: r, held: pending.get(j.key), at: Date.now(), f: cfg.boostFilter });
      if (verdict.action === 'hold') {
        outcome.held++;
        if (!pending.has(j.key)) pending.set(j.key, { gs: r.gs, cp: r.cp, firstSeen: Date.now() });
        log(`⏸️  ${where(j)} "${j.name}": GS ${prev.gs} → ${r.gs}, CP ${prev.cp} → ${r.cp} looks like a battleground boost; ` +
            `not written (held ${verdict.heldHours.toFixed(1)}h of ${cfg.boostFilter.holdHours}h)`);
        return;
      }
      if (verdict.action === 'accept-after-hold') log(`✅ ${where(j)} "${j.name}": big jump lasted ${cfg.boostFilter.holdHours}h+, accepting GS ${r.gs}, CP ${r.cp}`);
      if (pending.has(j.key) && verdict.action === 'accept') log(`   ${where(j)} "${j.name}": back to normal (GS ${r.gs}, CP ${r.cp}), boost discarded`);
      pending.delete(j.key);
      outcome.ok++; setResult(j, { gs: r.gs, cp: r.cp });
      if (VERBOSE) log(`   ${where(j)} "${j.name}": GS ${r.gs}, CP ${r.cp}`);
    }
  });
  await savePending(sheets, pending);
  if (outcome.renamed) await saveCache(sheets, cache);

  // 5) Re-read and write back (only rows whose IGN/server didn't change meanwhile).
  const stamp = L.formatTimestamp(new Date(), meta.timeZone);
  const data = [];
  for (const tab of tabs) {
    const fresh = await readColumns(sheets, tab.name, tab.layout);
    const w = L.buildWrite({ snapshot: tab.snap, results: tab.results, fresh, invalidText: cfg.invalidText, stamp: tab.layout.updated ? stamp : null });
    const n = w.gs.length;
    if (!n) continue;
    const end = cfg.startRow + n - 1;
    data.push({ range: L.colRange(tab.name, tab.layout.gs, cfg.startRow, end), values: w.gs });
    data.push({ range: L.colRange(tab.name, tab.layout.cp, cfg.startRow, end), values: w.cp });
    if (tab.layout.updated) data.push({ range: L.colRange(tab.name, tab.layout.updated, cfg.startRow, end), values: w.upd });

    // Log changes for this tab.
    for (let i = 0; i < n; i++) {
      const oldG = tab.snap.gs[i], oldC = tab.snap.cp[i], g = w.gs[i][0], c = w.cp[i][0];
      if (L.isGood(g) && (oldG !== g || oldC !== c)) log(`[${tab.name}] row ${i + cfg.startRow} "${L.clean(fresh.ign[i])}": GS ${oldG} → ${g}, CP ${oldC} → ${c}`);
    }
    log(`[${tab.name}] ${n} rows written, ${w.changed} changed`);
  }
  if (DRY_RUN) log('(dry run) skipping write');
  else await sheets.batchUpdate(data);

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = `✅ ${outcome.ok} updated | ⏸️ ${outcome.held} held (battleground?) | ❌ ${outcome.notFound} not found | ⚠️ ${outcome.failed} failed | ` +
    `${outcome.idLookups} ID lookups (${outcome.idsSaved} saved) | ${secs}s`;
  log(`===== SYNC DONE: ${summary} =====`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    let md = `### AION 2 GS/CP sync\n\n| Updated | Held (battleground?) | Not found | Failed | ID lookups | Time |\n|---|---|---|---|---|---|\n` +
      `| ${outcome.ok} | ${outcome.held} | ${outcome.notFound} | ${outcome.failed} | ${outcome.idLookups} | ${secs}s |\n`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  // Fail the run only if nothing at all worked (so you get GitHub's failure email).
  if (all.length && outcome.ok === 0 && outcome.notFound < all.length) process.exitCode = 1;
  return outcome;
}

module.exports = { main };

if (require.main === module) {
  Promise.resolve().then(() => main(sheetsFromEnv())).catch(err => {
    console.error('❌ FATAL:', err && err.response && err.response.data ? JSON.stringify(err.response.data) : (err.stack || err));
    process.exit(1);
  });
}
