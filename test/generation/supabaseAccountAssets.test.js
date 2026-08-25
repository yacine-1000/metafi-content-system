'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccountAssetValidationError, materializeSupabaseAccountAssets, validateAccountVisualBanks } = require('../../src/generation/resolvePostAssets');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
function account() { return { account_id: 'account-supabase', internal_name: 'Aziz', gender: 'male' }; }
function fetchBytes(bytes) { return async () => ({ ok: true, arrayBuffer: async () => bytes }); }

test('Supabase hook assets validate without pre-existing local folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-supabase-assets-')); const value = account();
  await materializeSupabaseAccountAssets(value, [
    { id: 'hook', active: true, asset_type: 'hook', storage_key: 'accounts/account-supabase/hooks/hook.png', signed_url: 'https://signed/hook' },
    { id: 'cta', active: true, asset_type: 'localized_cta', language: 'ar', storage_key: 'accounts/account-supabase/cta/ar/cta.jpg', signed_url: 'https://signed/cta' },
  ], { root, fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => url.endsWith('hook') ? png : jpg }) });
  assert.equal(validateAccountVisualBanks(value.account_id, 'ar', 'Original', { root, account: value }), value);
});

test('Supabase account with no hook assets fails explicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-supabase-assets-')); const value = account();
  assert.throws(() => validateAccountVisualBanks(value.account_id, 'ar', 'Original', { root, account: value }),
    (error) => error instanceof AccountAssetValidationError && error.code === 'ACCOUNT_HOOK_ASSET_MISSING');
});

test('Supabase CTA assets validate without local copies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-supabase-assets-')); const value = account();
  await materializeSupabaseAccountAssets(value, [
    { active: true, asset_type: 'hook', storage_key: 'hooks/hook.png', signed_url: 'https://signed/hook' },
    { active: true, asset_type: 'localized_cta', language: 'ar', storage_key: 'cta/cta.jpg', signed_url: 'https://signed/cta' },
  ], { root, fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => url.endsWith('hook') ? png : jpg }) });
  assert.equal(validateAccountVisualBanks(value.account_id, 'ar', '', { root, account: value }), value);
});
