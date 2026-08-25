'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { executeCampaignWindow } = require('../../src/campaigns/campaignExecutor');
const { AccountAssetValidationError } = require('../../src/generation/resolvePostAssets');

function fixture(slots) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-generation-chain-'));
  const campaign = {
    campaign_id: 'campaign-reliability', account_id: 'account-test', buffer_channel_id: 'channel-test',
    account_internal_name: 'Test', account_username: 'test', account_language: 'ar', account_timezone: 'UTC',
    language: 'ar', timezone: 'UTC', status: 'active', start_date: '2030-01-01', duration_days: 1,
    posts_per_day: slots.length, pillars: [{ pillar_id: 'p2', percentage: 100 }], hook_types: ['listicle'],
    posting_time_mode: 'manual', posting_times: ['12:00'], publishing_mode: 'automatic',
  };
  const planPath = path.join(root, 'data', 'campaigns', `${campaign.campaign_id}-plan.json`);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify({ campaign_id: campaign.campaign_id, slots: slots.map((slot) => ({
    slot_id: slot, date: '2030-01-01', time: '12:00', status: 'planned', post_id: null,
    language: 'ar', hook_type: 'listicle', pillar_id: 'p2', publishing_mode: 'automatic',
  })) }));
  return { root, campaign, planPath };
}

function generated(root, postId) {
  const folder = path.join(root, 'outputs', 'posts', postId);
  fs.mkdirSync(folder, { recursive: true });
  return { posts: [{ post_id: postId, post_folder: folder, render_result: {
    post_id: postId, language: 'ar', pillar_id: 'p2', hook_type: 'listicle', caption: 'Caption', post_folder: folder,
    metadata: { post_id: postId, master_script_id: `script-${postId}`, topic_id: `topic-${postId}`, statuses: { generation: 'completed', review: 'pending' }, asset_manifest: {} },
    publish_package: {},
  } }] };
}

function options(value, generateSlideshows, validateAccountVisualBanks = () => {}) {
  return {
    root: value.root, getCampaign: () => value.campaign, now: () => new Date('2030-01-01T08:00:00.000Z'),
    injectionRequestStore: { list: () => [], claim: () => null }, validateAccountVisualBanks, generateSlideshows,
  };
}

test('campaign generation chain persists generated slots or explicit retryable failures', async (t) => {
  await t.test('happy path produces a generated post', async () => {
    const value = fixture(['happy']);
    const result = await executeCampaignWindow(value.campaign.campaign_id, options(value, ({ postId }) => generated(value.root, postId)));
    assert.deepEqual(result.generated_post_ids, ['post-happy']);
    assert.equal(JSON.parse(fs.readFileSync(value.planPath, 'utf8')).slots[0].status, 'generated');
  });

  await t.test('generation failure persists an explicit retryable failed slot', async () => {
    const value = fixture(['generation-fail']);
    const result = await executeCampaignWindow(value.campaign.campaign_id, options(value, () => { throw new Error('generation unavailable'); }));
    assert.equal(result.failed_slots[0].retryable, true);
    assert.match(result.failed_slots[0].reason, /generation unavailable/);
    assert.equal(JSON.parse(fs.readFileSync(value.planPath, 'utf8')).slots[0].status, 'failed');
  });

  await t.test('asset-resolution failure persists an explicit retryable failed slot', async () => {
    const value = fixture(['asset-fail']);
    const result = await executeCampaignWindow(value.campaign.campaign_id, options(value, () => { throw new Error('must not generate'); }, () => {
      throw new AccountAssetValidationError('ACCOUNT_ASSET_MISSING', 'Account visual asset is missing');
    }));
    assert.equal(result.failed_slots[0].reason_code, 'ACCOUNT_ASSET_MISSING');
    assert.equal(result.failed_slots[0].retryable, true);
  });

  await t.test('renderer failure persists an explicit retryable failed slot', async () => {
    const value = fixture(['render-fail']);
    const result = await executeCampaignWindow(value.campaign.campaign_id, options(value, () => { throw new Error('renderer unavailable'); }));
    assert.match(result.failed_slots[0].reason, /renderer unavailable/);
    assert.equal(result.failed_slots[0].retryable, true);
  });

  await t.test('transient failure retries successfully and does not regenerate a successful sibling', async () => {
    const value = fixture(['failed-slot', 'successful-slot']);
    const calls = new Map();
    const generateSlideshows = ({ postId }) => {
      calls.set(postId, (calls.get(postId) || 0) + 1);
      if (postId === 'post-failed-slot' && calls.get(postId) === 1) throw new Error('temporary renderer failure');
      return generated(value.root, postId);
    };
    const first = await executeCampaignWindow(value.campaign.campaign_id, options(value, generateSlideshows));
    assert.equal(first.generated_count, 1);
    assert.equal(first.failed_count, 1);
    const second = await executeCampaignWindow(value.campaign.campaign_id, options(value, generateSlideshows));
    assert.equal(second.generated_count, 1);
    assert.equal(second.failed_count, 0);
    assert.equal(calls.get('post-failed-slot'), 2);
    assert.equal(calls.get('post-successful-slot'), 1);
    const statuses = new Map(JSON.parse(fs.readFileSync(value.planPath, 'utf8')).slots.map((slot) => [slot.slot_id, slot.status]));
    assert.equal(statuses.get('failed-slot'), 'generated');
    assert.equal(statuses.get('successful-slot'), 'generated');
  });
});
