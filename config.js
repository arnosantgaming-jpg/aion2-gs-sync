// =====================================================================
//  SETTINGS — edit this file when your sheet layout changes.
//  Column numbers: A=1, B=2, C=3 ... (updated: 0 = no timestamp column)
// =====================================================================

const ALT_LAYOUT = { ign: 2, server: 5, gs: 6, cp: 7, updated: 0 }; // B, E, F, G

module.exports = {
  // Every tab to sync, with where its columns are.
  layouts: {
    Main:  { ign: 2, server: 7, gs: 8, cp: 9, updated: 13 },         // B, G, H, I, M
    Alt_1: ALT_LAYOUT,
    Alt_2: ALT_LAYOUT,
    Alt_3: ALT_LAYOUT,
  },

  startRow: 2,            // first data row (headers are on startRow - 1)
  region: 'as',           // as / eu / nae / naw
  invalidText: 'Invalid IGN',
  tbcPattern: /tbc/i,     // names matching this are skipped and marked invalid

  // Hidden tab where character IDs are remembered (created automatically).
  cacheSheet: '_id_cache',

  // Battleground filter: battleground mode boosts CP/GS a lot (e.g. 111k -> 300k CP).
  // A reading that jumps more than these ratios is NOT written; the old numbers stay.
  // If the jump is still there after holdHours, it's treated as a real upgrade and written.
  // Drops are always written.
  boostFilter: {
    enabled: true,
    maxCpRatio: 1.5,      // CP more than +50% in one go = suspicious
    maxGsRatio: 1.25,     // GS more than +25% in one go = suspicious
    holdHours: 12,        // how long a jump must last before it's accepted
    minLevel: 45,         // characters below this level aren't filtered (levelling up is legit)
    sheet: '_pending',    // hidden tab that remembers held readings
  },

  // Request tuning
  apiConcurrency: 6,      // parallel NCSOFT API calls
  shugoConcurrency: 3,    // parallel Shugo ID lookups (only for new characters)
  retries: 3,             // attempts per request
  timeoutMs: 15000,       // per request
};
