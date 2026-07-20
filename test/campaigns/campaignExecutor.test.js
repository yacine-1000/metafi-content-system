'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CampaignExecutionError, executeCampaignWindow } = require('../../src/campaigns/campaignExecutor');
const { AccountAssetValidationError } = require('../../src/generation/resolvePostAssets');

function fixture(startDate = '2026-07-19') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-campaign-'));
  fs.mkdirSync(path.join(root, 'data', 'campaigns'), { recursive: true });
  const campaign = {
    campaign_id: 'campaign-test-window', account_id: 'account-test', buffer_channel_id: 'channel-test',
    account_internal_name: 'Test', account_username: 'test', account_language: 'ar', account_timezone: 'Asia/Riyadh',
    language: 'ar', timezone: 'Asia/Riyadh', status: 'active', start_date: startDate,
    duration_days: 1, posts_per_day: 1, pillars: [{ pillar_id: 'p2', percentage: 100 }],
    hook_types: ['listicle'], posting_time_mode: 'manual', posting_times: ['12:00'], publishing_mode: 'automatic',
  };
  return { root, campaign, planPath: path.join(root, 'data', 'campaigns', `${campaign.campaign_id}-plan.json`) };
}

function options(root, campaign) {
  return {
    root,
    getCampaign: () => campaign,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    injectionRequestStore: { list: () => [], claim: () => null },
    validateAccountVisualBanks: () => {},
  };
}

test('missing plan returns a structured actionable error and no failed slot', async () => {
  const { root, campaign } = fixture();
  await assert.rejects(
    () => executeCampaignWindow(campaign.campaign_id, options(root, campaign)),
    (error) => error instanceof CampaignExecutionError
      && error.code === 'PLAN_FILE_MISSING'
      && error.message.includes('No campaign plan exists')
      && error.details.plan_path.endsWith('-plan.json'),
  );
});

test('empty plan is blocked explicitly instead of becoming Failed 1', async () => {
  const { root, campaign, planPath } = fixture();
  fs.writeFileSync(planPath, JSON.stringify({ campaign_id: campaign.campaign_id, slots: [] }));
  await assert.rejects(
    () => executeCampaignWindow(campaign.campaign_id, options(root, campaign)),
    (error) => error.code === 'PLAN_ZERO_SLOTS' && error.details.expected_slots === 1,
  );
});

test('no eligible slots is a successful no-work result', async () => {
  const { root, campaign, planPath } = fixture('2026-07-25');
  fs.writeFileSync(planPath, JSON.stringify({
    campaign_id: campaign.campaign_id,
    slots: [{ slot_id: 'future-slot', date: '2026-07-25', time: '12:00', status: 'planned', post_id: null }],
  }));
  const result = await executeCampaignWindow(campaign.campaign_id, options(root, campaign));
  assert.equal(result.outcome, 'no_work');
  assert.equal(result.reason_code, 'NO_SLOTS_CURRENT_WINDOW');
  assert.equal(result.failed_count, 0);
});

test('account asset failure is retryable and only the failed slot runs after upload', async () => {
  const { root, campaign, planPath } = fixture();
  fs.writeFileSync(planPath, JSON.stringify({
    campaign_id: campaign.campaign_id,
    slots: [{
      slot_id: 'asset-slot', date: '2026-07-19', time: '12:00', status: 'planned', post_id: null,
      language: 'ar', hook_type: 'listicle', pillar_id: 'p2', publishing_mode: 'automatic',
    }],
  }));
  let generationCalls = 0;
  const missingOptions = {
    ...options(root, campaign),
    validateAccountVisualBanks: () => {
      throw new AccountAssetValidationError('ACCOUNT_CTA_MISSING', 'Faisal is missing an Arabic CTA image. Upload it in Accounts and retry.');
    },
    generateSlideshows: () => { generationCalls += 1; throw new Error('renderer must not start'); },
  };
  const failed = await executeCampaignWindow(campaign.campaign_id, missingOptions);
  assert.equal(generationCalls, 0);
  assert.deepEqual(failed.failed_slots[0], {
    slot_id: 'asset-slot',
    reason: 'Faisal is missing an Arabic CTA image. Upload it in Accounts and retry.',
    reason_code: 'ACCOUNT_CTA_MISSING',
    retryable: true,
  });
  assert.equal(JSON.parse(fs.readFileSync(planPath, 'utf8')).slots[0].status, 'failed');

  const uploadedOptions = {
    ...options(root, campaign),
    generateSlideshows: () => {
      generationCalls += 1;
      const folder = path.join(root, 'outputs', 'posts', 'post-retry');
      fs.mkdirSync(folder, { recursive: true });
      return { posts: [{ post_id: 'post-retry', post_folder: path.relative(root, folder), render_result: {
        post_id: 'post-retry', language: 'ar', pillar_id: 'p2', hook_type: 'listicle', caption: '',
        metadata: { post_id: 'post-retry', master_script_id: 'script-retry', topic_id: 'topic-retry', statuses: { generation: 'completed', review: 'pending' } },
        publish_package: {}, post_folder: path.relative(root, folder),
      } }] };
    },
  };
  const retried = await executeCampaignWindow(campaign.campaign_id, uploadedOptions);
  assert.equal(retried.generated_count, 1);
  assert.equal(retried.failed_count, 0);
  assert.equal(generationCalls, 1);
  const retriedSlot = JSON.parse(fs.readFileSync(planPath, 'utf8')).slots[0];
  assert.equal(retriedSlot.status, 'generated');
  assert.equal(retriedSlot.failure_code, undefined);
});
