'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PortalSupabaseService, QuickSaveOutputError } = require('../../src/persistence/portalSupabaseService');

function fixture() {
  const campaign = { id: 'campaign-uuid', legacy_campaign_id: 'campaign-test', account_id: 'account-uuid' };
  const slot = { id: 'slot-uuid', legacy_slot_id: 'slot-test', campaign_id: campaign.id, account_id: campaign.account_id };
  const base = 'campaign/campaign-test/slots/slot-test/posts/post-test/ar';
  const post = { id: 'post-uuid', legacy_post_id: 'post-test', campaign_id: campaign.id, campaign_slot_id: slot.id, account_id: campaign.account_id, language: 'ar',
    asset_manifest: { rendered_output: { status: 'complete', storage_provider: 'supabase_storage', bucket: 'private', base_path: base,
      slides: [{ order: 2, storage_key: `${base}/slides/slide-02.png` }, { order: 1, storage_key: `${base}/slides/slide-01.png` }], zip: { storage_key: `${base}/post-test-slides.zip` } } } };
  return { campaign, slot, post };
}

test('Quick Save validates linkage and derives ordered private output references', () => {
  const service = Object.create(PortalSupabaseService.prototype); service.renderedOutputStorage = { bucket: 'private' }; const { campaign, slot, post } = fixture();
  const output = service.validatedRenderedOutput(campaign, slot, post);
  assert.deepEqual(output.slides.map((slide) => slide.order), [1, 2]);
  assert.throws(() => service.validatedRenderedOutput(campaign, { ...slot, account_id: 'other-account' }, post),
    (error) => error instanceof QuickSaveOutputError && error.code === 'QUICK_SAVE_ACCESS_DENIED');
  assert.throws(() => service.validatedRenderedOutput(campaign, slot, { ...post, asset_manifest: {} }),
    (error) => error instanceof QuickSaveOutputError && error.code === 'QUICK_SAVE_OUTPUT_MISSING');
  const foreign = fixture(); foreign.post.asset_manifest.rendered_output.slides[0].storage_key = 'campaign/other/slides/slide.png';
  assert.throws(() => service.validatedRenderedOutput(foreign.campaign, foreign.slot, foreign.post),
    (error) => error instanceof QuickSaveOutputError && error.code === 'QUICK_SAVE_ACCESS_DENIED');
});

test('Quick Save accepts complete slide-only output without a ZIP', () => {
  const service = Object.create(PortalSupabaseService.prototype); service.renderedOutputStorage = { bucket: 'private' };
  const { campaign, slot, post } = fixture(); delete post.asset_manifest.rendered_output.zip;
  const output = service.validatedRenderedOutput(campaign, slot, post);
  assert.equal(output.zip, undefined);
  assert.deepEqual(output.slides.map((slide) => slide.order), [1, 2]);
});

test('team campaigns use complete durable output as readiness and calculate counts', async () => {
  const service = Object.create(PortalSupabaseService.prototype); service.renderedOutputStorage = { bucket: 'private' };
  service.signed = async (asset) => `https://signed.invalid/${asset.storage_key}`;
  const { campaign, slot, post } = fixture(); Object.assign(campaign, { name: 'Launch', start_date: '2026-07-20', duration_days: 3 });
  Object.assign(post, { generation_status: 'queued', saved_at: '2026-07-20T10:00:00Z', publication_status: 'published' });
  const incomplete = { ...post, id: 'post-2', legacy_post_id: 'post-2', asset_manifest: {} };
  service.repository = {
    listCampaigns: async () => [campaign], listAccounts: async () => [{ id: campaign.account_id, legacy_account_id: 'account-test', display_name: 'Metafi', username: '@metafi.app' }],
    listCampaignSlots: async () => [slot], listPosts: async () => [post, incomplete],
    listAccountAssets: async (accountId) => accountId === 'account-test' ? [{ asset_type: 'profile', active: true, storage_key: 'accounts/account-test/profile/avatar.png' }] : [],
  };
  assert.deepEqual(await service.teamCampaigns(), { campaigns: [{ campaign_id: 'campaign-test', name: 'Launch', account_id: 'account-test', account: 'Metafi',
    account_handle: '@metafi.app', account_profile_url: 'https://signed.invalid/accounts/account-test/profile/avatar.png',
    start_date: '2026-07-20', end_date: '2026-07-22', ready_count: 1, saved_count: 1, posted_count: 1 }] });
});

test('team account identity normalizes handles, falls back to account name, and scopes profile lookup', async () => {
  const service = Object.create(PortalSupabaseService.prototype); const requested = [];
  service.repository = { listAccountAssets: async (accountId) => { requested.push(accountId); return []; } };
  assert.deepEqual(await service.teamAccountIdentity({ legacy_account_id: 'account-a', username: '@@metafi.app', display_name: 'Metafi' }),
    { account_handle: '@metafi.app', account_profile_url: null });
  assert.deepEqual(await service.teamAccountIdentity({ legacy_account_id: 'account-b', username: '', display_name: 'Founding Team' }),
    { account_handle: 'Founding Team', account_profile_url: null });
  assert.deepEqual(requested, ['account-a', 'account-b']);
});

test('team UI falls back to account initials when a profile image is missing or fails', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/ui/team.html'), 'utf8');
  assert.match(html, /function avatarFallback\(image\)/);
  assert.match(html, /onerror="avatarFallback\(this\)"/);
  assert.match(html, /data-initials=/);
});

test('team mark-posted validates campaign linkage, blocks Buffer state, and is idempotent', async () => {
  const service = Object.create(PortalSupabaseService.prototype);
  service.quickSavePost = async (campaignId) => campaignId === 'campaign-test' ? { post: { id: 'post-uuid', buffer_status: 'not_sent', buffer_post_id: null } } : null;
  service.client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
  service.markQuickSavePosted = async () => ({ publication: { id: 'publication-uuid' }, existing: false });
  assert.equal(await service.markTeamPostPosted('other-campaign', 'post-test'), null);
  assert.equal((await service.markTeamPostPosted('campaign-test', 'post-test')).existing, false);
  service.quickSavePost = async () => ({ post: { id: 'post-uuid', buffer_status: 'buffered', buffer_post_id: 'buffer-id' } });
  await assert.rejects(() => service.markTeamPostPosted('campaign-test', 'post-test'),
    (error) => error instanceof QuickSaveOutputError && error.code === 'QUICK_SAVE_ALREADY_PUBLISHED');
  service.client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'publication-uuid' }, error: null }) }) }) }) };
  assert.equal((await service.markTeamPostPosted('campaign-test', 'post-test')).existing, true);
});
