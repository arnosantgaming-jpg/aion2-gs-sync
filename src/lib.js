'use strict';
// Pure helpers (no network / no Google) so they can be unit-tested.

/** Column number (1-based) -> letter(s). 1 -> A, 27 -> AA */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Quote a sheet name for A1 notation: Main -> 'Main', It's -> 'It''s' */
function quoteSheet(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

/** A1 range for a single column from startRow to the bottom, e.g. 'Main'!H2:H */
function colRange(sheet, col, startRow, endRow) {
  const L = colLetter(col);
  return quoteSheet(sheet) + '!' + L + startRow + ':' + L + (endRow || '');
}

/** Flatten a values column ([[a],[b]] or ragged) into an array of length n. */
function column(values, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = values && values[i];
    out.push(row && row.length ? row[0] : '');
  }
  return out;
}

function clean(v) {
  return String(v == null ? '' : v).replace(/[ ​]/g, ' ').trim();
}

/** Character ID + server ID from a Shugo profile page. */
function parseId(html) {
  if (!html) return null;
  const m = html.match(/&quot;id&quot;:&quot;([^&]+)&quot;,&quot;serverId&quot;:(\d+)/) ||
            html.match(/"id":"([^"]+)","serverId":(\d+)/);
  return m ? { id: m[1], serverId: String(m[2]) } : null;
}

/** { gs, cp, name } from NCSOFT's character/info JSON, or null. GS = 0 if no item level. */
function parseApi(json) {
  const p = json && json.profile;
  if (!p || typeof p.combatPower !== 'number') return null;
  let gs = 0;
  const list = json.stat && json.stat.statList;
  if (Array.isArray(list)) {
    const il = list.find(s => s && s.type === 'ItemLevel');
    if (il) gs = Number(il.value) || 0;
  }
  return { gs, cp: p.combatPower, name: p.characterName || '', level: Number(p.characterLevel) || 0 };
}

function cacheKey(region, server, name) {
  return region + '|' + clean(server).toLowerCase() + '|' + clean(name);
}

/** "2026-10-15 14:32:05" in the given IANA time zone (Sheets parses this as a date-time). */
function formatTimestamp(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}:${parts.second}`;
}

function isGood(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Builds the values to write for one sheet.
 *
 * snapshot: the column values read at the start ({ign, server, gs, cp})
 * results:  Map rowIndex -> { gs, cp } (successful fetches) | 'notfound' | 'tbc'
 * fresh:    the same columns re-read just before writing (rows may have moved/changed)
 *
 * Rules:
 *  - A row is only touched if its IGN+server are still the same as in the snapshot,
 *    so rows inserted/sorted/edited during the run are left alone.
 *  - Success -> new numbers (+ timestamp).
 *  - Not found / TBC -> keep last good numbers, otherwise show invalidText.
 *  - Empty name or server -> clear GS/CP.
 *  - Anything else (network error, skipped) -> keep whatever is there.
 */
function buildWrite({ snapshot, results, fresh, invalidText, stamp }) {
  const n = fresh.ign.length;
  const gs = [], cp = [], upd = [];
  let changed = 0;
  for (let i = 0; i < n; i++) {
    let g = fresh.gs[i], c = fresh.cp[i], u = fresh.upd ? fresh.upd[i] : '';
    const sameRow = i < snapshot.ign.length &&
      clean(fresh.ign[i]) === clean(snapshot.ign[i]) &&
      clean(fresh.server[i]) === clean(snapshot.server[i]);

    if (sameRow) {
      const r = results.get(i);
      const name = clean(fresh.ign[i]), srv = clean(fresh.server[i]);
      if (!name || !srv) {
        g = ''; c = '';
      } else if (r && typeof r === 'object') {
        if (g !== r.gs || c !== r.cp) changed++;
        g = r.gs; c = r.cp;
        if (stamp) u = stamp;
      } else if (r === 'notfound' || r === 'tbc') {
        if (r === 'tbc') { g = invalidText; c = invalidText; }
        else {
          if (!isGood(g)) g = invalidText;
          if (!isGood(c)) c = invalidText;
        }
      }
    }
    gs.push([g === undefined || g === null ? '' : g]);
    cp.push([c === undefined || c === null ? '' : c]);
    upd.push([u === undefined || u === null ? '' : u]);
  }
  return { gs, cp, upd, changed };
}

/** Run async fn over items with at most `limit` in flight. Preserves order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Battleground boosts multiply CP/GS for a while. Decide what to do with a new reading:
 *  - 'accept'             normal change (or a drop, or the filter doesn't apply) -> write it
 *  - 'hold'               huge jump -> keep the old numbers for now
 *  - 'accept-after-hold'  the huge jump has lasted holdHours -> it's real, write it
 * prev: numbers currently in the sheet; now: {gs, cp, level}; held: {firstSeen} if already holding.
 */
function boostVerdict({ prev, now, held, at, f }) {
  if (!f || !f.enabled) return { action: 'accept' };
  if (!isGood(prev.cp) || prev.cp <= 0) return { action: 'accept' };          // nothing to compare with
  if ((now.level || 0) < f.minLevel) return { action: 'accept' };            // levelling up legitimately
  const cpJump = now.cp > prev.cp * f.maxCpRatio;
  const gsJump = isGood(prev.gs) && prev.gs > 0 && now.gs > prev.gs * f.maxGsRatio;
  if (!cpJump && !gsJump) return { action: 'accept' };
  const heldHours = held ? (at - held.firstSeen) / 3600000 : 0;
  if (held && heldHours >= f.holdHours) return { action: 'accept-after-hold', heldHours };
  return { action: 'hold', heldHours };
}

module.exports = {
  boostVerdict,
  colLetter, quoteSheet, colRange, column, clean, parseId, parseApi,
  cacheKey, formatTimestamp, isGood, buildWrite, mapLimit,
};
