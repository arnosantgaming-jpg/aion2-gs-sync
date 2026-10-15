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

  // Request tuning
  apiConcurrency: 6,      // parallel NCSOFT API calls
  shugoConcurrency: 3,    // parallel Shugo ID lookups (only for new characters)
  retries: 3,             // attempts per request
  timeoutMs: 15000,       // per request
};
