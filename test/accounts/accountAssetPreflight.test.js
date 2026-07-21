'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountAssetValidationError, validateAccountVisualBanks } = require('../../src/generation/resolvePostAssets');

const account = {
  account_id: 'account-fixture',
  internal_name: 'Faisal',
  gender: 'male',
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-assets-'));
  const hookDir = path.join(root, 'assets', 'account-hook-images', account.account_id);
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'hook.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  return root;
}

test('missing localized CTA returns a structured actionable error before rendering', () => {
  const root = fixture();
  assert.throws(
    () => validateAccountVisualBanks(account.account_id, 'ar', 'listicle', { root, account }),
    (error) => error instanceof AccountAssetValidationError
      && error.code === 'ACCOUNT_CTA_MISSING'
      && error.message === 'Faisal is missing an Arabic CTA image. Upload it in Accounts and retry.'
      && error.details.language === 'ar',
  );
});

test('missing or corrupt hook asset returns ACCOUNT_HOOK_ASSET_MISSING', () => {
  const root = fixture();
  const hookPath = path.join(root, 'assets', 'account-hook-images', account.account_id, 'hook.png');
  fs.writeFileSync(hookPath, 'not an image');
  assert.throws(
    () => validateAccountVisualBanks(account.account_id, 'ar', 'listicle', { root, account }),
    (error) => error.code === 'ACCOUNT_HOOK_ASSET_MISSING' && error.details.hook_type === 'listicle',
  );
});

test('uploading a readable localized CTA makes the same preflight retry succeed', () => {
  const root = fixture();
  const ctaDir = path.join(root, 'assets', 'account-app-cta-images', account.account_id, 'ar');
  fs.mkdirSync(ctaDir, { recursive: true });
  fs.writeFileSync(path.join(ctaDir, 'cta.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(validateAccountVisualBanks(account.account_id, 'ar', 'listicle', { root, account }), account);
});

