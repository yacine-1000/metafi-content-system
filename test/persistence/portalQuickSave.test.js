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
