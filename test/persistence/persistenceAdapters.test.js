'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPersistenceRepository } = require('../../src/persistence');
const { PersistenceConfigurationError, persistenceMode } = require('../../src/persistence/serverSupabaseClient');
const { SupabaseRepository } = require('../../src/persistence/supabaseRepository');
const { buildPostRecord } = require('../../src/lib/supabasePostStore');
const { upsertContentPost } = require('../../src/lib/supabasePostStore');
const { collectAccountsOnly, reportAccountsOnly } = require('../../scripts/supabaseBackfill');
const { buildUploadPlan, report: reportUploadPlan } = require('../../scripts/supabaseUploadAssets');

test('local persistence is the default and does not need Supabase credentials', () => {
  const repository = createPersistenceRepository({ env: {} });
  assert.equal(repository.mode, 'local');
  assert.equal(persistenceMode({}), 'local');
});

test('clean-start upload plan uses private deterministic account and global keys without outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-upload-'));
  try {
    const accountId = 'account_fixture';
    fs.mkdirSync(path.join(root, 'data', 'accounts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'account-avatars', accountId), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'account-hook-images', accountId), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'account-app-cta-images', accountId, 'ar'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'body-images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'hook-images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'app-icon-home-screen', 'ar'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'accounts', 'fixture.json'), JSON.stringify({ account_id: accountId, internal_name: 'Fixture', display_name: 'Fixture', username: 'fixture', platform: 'tiktok', language: 'ar', gender: 'male', timezone: 'Asia/Riyadh', active: true, avatar_path: `/assets/account-avatars/${accountId}/avatar.png` }));
    for (const target of [
      path.join(root, 'assets', 'account-avatars', accountId, 'avatar.png'), path.join(root, 'assets', 'account-hook-images', accountId, 'hook.png'),
      path.join(root, 'assets', 'account-app-cta-images', accountId, 'ar', 'cta.jpg'), path.join(root, 'assets', 'body-images', 'body.jpg'),
      path.join(root, 'assets', 'hook-images', 'hook.png'), path.join(root, 'assets', 'app-icon-home-screen', 'ar', 'app.jpeg'),
    ]) fs.writeFileSync(target, 'image');
    const plan = buildUploadPlan(root);
    const output = reportUploadPlan(plan, true);
    assert.equal(output.files_discovered, 6);
    assert.ok(output.destination_keys.includes(`accounts/${accountId}/profile/avatar.png`));
    assert.ok(output.destination_keys.includes('global/body/body_slides/body.jpg'));
    assert.ok(output.destination_keys.includes('global/app-screenshots/ar/app.jpeg'));
    assert.equal(output.blocking_errors.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('supabase mode fails clearly when its server-only configuration is missing', () => {
  assert.throws(
    () => createPersistenceRepository({ env: { METAFI_PERSISTENCE_MODE: 'supabase' } }),
    (error) => error instanceof PersistenceConfigurationError && error.message.includes('SUPABASE_URL'),
  );
  assert.throws(() => persistenceMode({ METAFI_PERSISTENCE_MODE: 'remote' }), /local.*supabase/);
});

test('Supabase account adapter uses a deterministic legacy-ID upsert', async () => {
  const calls = [];
  const client = {
    from(table) {
      return {
        upsert(row, options) {
          calls.push({ table, row, options });
          return { select() { return { single: async () => ({ data: { id: 'uuid-account', ...row }, error: null }) }; } };
        },
      };
    },
  };
  const repository = new SupabaseRepository(client);
  const saved = await repository.upsertAccount({
    account_id: 'account_fixture', internal_name: 'Fixture', display_name: 'Fixture', username: 'fixture',
    language: 'ar', gender: 'male', timezone: 'Asia/Riyadh', connection_status: 'manual_only', active: true,
  });
  assert.equal(saved.id, 'uuid-account');
  assert.deepEqual(calls[0].options, { onConflict: 'legacy_account_id' });
  assert.equal(calls[0].row.legacy_account_id, 'account_fixture');
});

test('post records preserve local metadata while normalizing the repository input', () => {
  const record = buildPostRecord({
    postId: 'post_fixture', metadata: { account_id: 'account_fixture', statuses: { generation: 'completed', buffer: 'not_started' } },
    publishPackage: { caption: 'Caption' }, localPath: 'outputs/posts/post_fixture',
  });
  assert.equal(record.post_id, 'post_fixture');
  assert.equal(record.account_id, 'account_fixture');
  assert.equal(record.statuses.generation, 'completed');
  assert.equal(record.local_path, 'outputs/posts/post_fixture');
});

test('post sync reports missing Supabase configuration instead of falling back to local', async () => {
  await assert.rejects(
    () => upsertContentPost({ postId: 'post_fixture' }, { env: { METAFI_PERSISTENCE_MODE: 'supabase' } }),
    /SUPABASE_URL/,
  );
});

test('accounts-only backfill imports only explicit valid account assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-backfill-'));
  try {
    const accountId = 'account_fixture';
    fs.mkdirSync(path.join(root, 'data', 'accounts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'account-avatars', accountId), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'account-hook-images', accountId), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'account-app-cta-images', accountId, 'ar'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'accounts', `${accountId}.json`), JSON.stringify({
      account_id: accountId, internal_name: 'Fixture', display_name: 'Fixture', username: 'fixture',
      platform: 'tiktok', language: 'ar', gender: 'male', timezone: 'Asia/Riyadh', active: true,
      avatar_path: `/assets/account-avatars/${accountId}/avatar.png`,
    }));
    fs.writeFileSync(path.join(root, 'assets', 'account-avatars', accountId, 'avatar.png'), 'image');
    fs.writeFileSync(path.join(root, 'assets', 'account-hook-images', accountId, 'hook.png'), 'image');
    fs.writeFileSync(path.join(root, 'assets', 'account-app-cta-images', accountId, 'ar', 'cta.jpg'), 'image');
    fs.writeFileSync(path.join(root, 'assets', 'account-hook-images', accountId, 'readme.txt'), 'not an image');
    fs.mkdirSync(path.join(root, 'data', 'campaigns'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'campaigns', 'campaign-ignored.json'), '{ bad json');

    const snapshot = collectAccountsOnly(root);
    const output = reportAccountsOnly(snapshot, true, root);
    assert.equal(output.accounts_to_import, 1);
    assert.equal(output.account_profile_assets_to_import, 1);
    assert.equal(output.account_hook_assets_to_import, 1);
    assert.equal(output.account_localized_cta_assets_to_import, 1);
    assert.equal(output.global_body_assets_to_import, 0);
    assert.equal(output.global_shared_hook_assets_to_import, 0);
    assert.equal(output.excluded_invalid_account_asset_count, 1);
    assert.equal(output.blocking_errors.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
