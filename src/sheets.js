'use strict';
// Minimal Google Sheets REST client using a service account.
const { GoogleAuth } = require('google-auth-library');

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

class Sheets {
  constructor(spreadsheetId, credentials) {
    this.id = spreadsheetId;
    this.auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  async request(method, path, body) {
    const client = await this.auth.getClient();
    const url = BASE + encodeURIComponent(this.id) + path;
    const res = await client.request({ url, method, data: body, retry: true });
    return res.data;
  }

  /** { timeZone, sheets: [{title, sheetId, hidden}] } */
  async meta() {
    const d = await this.request('GET', '?fields=properties.timeZone,sheets.properties(title,sheetId,hidden)');
    return {
      timeZone: d.properties && d.properties.timeZone,
      sheets: (d.sheets || []).map(s => s.properties),
    };
  }

  /** Read many A1 ranges at once. Returns arrays of rows in the same order. */
  async batchGet(ranges) {
    if (!ranges.length) return [];
    const q = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
    const d = await this.request('GET',
      '/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
    return (d.valueRanges || []).map(v => v.values || []);
  }

  /** Write many ranges at once. data: [{range, values}] */
  async batchUpdate(data, valueInputOption = 'USER_ENTERED') {
    if (!data.length) return;
    await this.request('POST', '/values:batchUpdate', { valueInputOption, data });
  }

  async clear(range) {
    await this.request('POST', '/values/' + encodeURIComponent(range) + ':clear', {});
  }

  async addHiddenSheet(title) {
    await this.request('POST', ':batchUpdate', {
      requests: [{ addSheet: { properties: { title, hidden: true } } }],
    });
  }
}

module.exports = { Sheets };
