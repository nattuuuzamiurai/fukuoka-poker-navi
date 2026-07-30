'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reportAlert } = require('./dashboard-report');

test('reportAlert: DASHBOARD_WRITE_TOKEN 未設定ならネットワークアクセスせずスキップする', async () => {
  const original = process.env.DASHBOARD_WRITE_TOKEN;
  delete process.env.DASHBOARD_WRITE_TOKEN;
  try {
    const result = await reportAlert({ venueId: 'v40', type: 'missed_deadline', message: 'テスト' });
    assert.deepEqual(result, { skipped: true });
  } finally {
    if (original !== undefined) process.env.DASHBOARD_WRITE_TOKEN = original;
  }
});
