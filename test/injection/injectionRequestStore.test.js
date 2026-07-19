'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInjectionRequestStore, InjectionRequestStoreError } = require('../../src/injection/injectionRequestStore');

test('persists the standalone injection-request schema and rejects duplicate IDs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-request-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createInjectionRequestStore({ filePath: path.join(root, 'requests.json') });
  const input = {
    injection_id: 'INJ-test-001', source_set_id: 'SET-045', campaign_id: null,
    account_id: null, status: 'pending', priority: 'normal',
    requested_at: '2026-07-19T00:00:00.000Z', target_date: '2026-07-20', consumed_by_slot_id: null,
  };
  assert.deepEqual(store.save(input), input);
  assert.deepEqual(store.list(), [input]);
  assert.throws(() => store.save(input), InjectionRequestStoreError);
});
