'use strict';

const assert = require('node:assert/strict');
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

test('team campaigns include only complete durable outputs and calculate counts', async () => {
  const service = Object.create(PortalSupabaseService.prototype); service.renderedOutputStorage = { bucket: 'private' };
  const { campaign, slot, post } = fixture(); Object.assign(campaign, { name: 'Launch', start_date: '2026-07-20', duration_days: 3 });
  Object.assign(post, { generation_status: 'completed', saved_at: '2026-07-20T10:00:00Z', publication_status: 'published' });
  const incomplete = { ...post, id: 'post-2', legacy_post_id: 'post-2', asset_manifest: {} };
  service.repository = {
    listCampaigns: async () => [campaign], listAccounts: async () => [{ id: campaign.account_id, legacy_account_id: 'account-test', display_name: 'Metafi' }],
    listCampaignSlots: async () => [slot], listPosts: async () => [post, incomplete],
  };
  assert.deepEqual(await service.teamCampaigns(), { campaigns: [{ campaign_id: 'campaign-test', name: 'Launch', account_id: 'account-test', account: 'Metafi',
    start_date: '2026-07-20', end_date: '2026-07-22', ready_count: 1, saved_count: 1, posted_count: 1 }] });
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
