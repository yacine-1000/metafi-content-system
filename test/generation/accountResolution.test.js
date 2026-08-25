'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateAccountVisualBanks } = require('../../src/generation/resolvePostAssets');

function account(id) { return { account_id: id, internal_name: 'Hosted Account', gender: 'female' }; }

function rootWithAssets(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-account-resolution-'));
  const hook = path.join(root, 'assets', 'account-hook-images', value.account_id);
  const cta = path.join(root, 'assets', 'account-app-cta-images', value.account_id, 'ar');
  fs.mkdirSync(hook, { recursive: true }); fs.mkdirSync(cta, { recursive: true });
  fs.writeFileSync(path.join(hook, 'hook.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(cta, 'cta.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
  return root;
}

test('Supabase campaign account context resolves without consulting local accounts', () => {
  const value = account('account_1e5663e4bb2b6038b81bd37d'); const root = rootWithAssets(value);
  assert.equal(validateAccountVisualBanks(value.account_id, 'ar', 'listicle', {
    root, account: value, resolveAccount: () => { throw new Error('local account lookup should not run'); },
  }), value);
});

test('local mode still resolves an account through the local resolver', () => {
  const value = account('account-local'); const root = rootWithAssets(value); let calls = 0;
  assert.equal(validateAccountVisualBanks(value.account_id, 'ar', 'listicle', {
    root, resolveAccount: (id) => { calls += 1; assert.equal(id, value.account_id); return value; },
  }), value);
  assert.equal(calls, 1);
});

test('a genuinely missing account still fails explicitly', () => {
  assert.throws(() => validateAccountVisualBanks('account-missing', 'ar', 'listicle', {
    resolveAccount: () => { throw new Error('Campaign account does not exist: account-missing'); },
  }), /Campaign account does not exist: account-missing/);
});
