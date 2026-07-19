'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CampaignExecutionError, executeCampaignWindow } = require('../../src/campaigns/campaignExecutor');

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
    injectionRequestStore: { list: () => [], claim: () => null },
    validateAccountVisualBanks: () => {},
  };
}

test('missing plan returns a structured actionable error and no failed slot', () => {
  const { root, campaign } = fixture();
  assert.throws(
    () => executeCampaignWindow(campaign.campaign_id, options(root, campaign)),
    (error) => error instanceof CampaignExecutionError
      && error.code === 'PLAN_FILE_MISSING'
      && error.message.includes('No campaign plan exists')
      && error.details.plan_path.endsWith('-plan.json'),
  );
});

test('empty plan is blocked explicitly instead of becoming Failed 1', () => {
  const { root, campaign, planPath } = fixture();
  fs.writeFileSync(planPath, JSON.stringify({ campaign_id: campaign.campaign_id, slots: [] }));
  assert.throws(
    () => executeCampaignWindow(campaign.campaign_id, options(root, campaign)),
    (error) => error.code === 'PLAN_ZERO_SLOTS' && error.details.expected_slots === 1,
  );
});

test('no eligible slots is a successful no-work result', () => {
  const { root, campaign, planPath } = fixture('2026-07-25');
  fs.writeFileSync(planPath, JSON.stringify({
    campaign_id: campaign.campaign_id,
    slots: [{ slot_id: 'future-slot', date: '2026-07-25', time: '12:00', status: 'planned', post_id: null }],
  }));
  const result = executeCampaignWindow(campaign.campaign_id, options(root, campaign));
  assert.equal(result.outcome, 'no_work');
  assert.equal(result.reason_code, 'NO_SLOTS_CURRENT_WINDOW');
  assert.equal(result.failed_count, 0);
});

