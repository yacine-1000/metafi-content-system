'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { sendUploadedCampaignPostsToBuffer } = require('../../src/campaigns/campaignExecutor');

function fixture(postIds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-buffer-'));
  const postsDir = path.join(root, 'posts'); const campaignsDir = path.join(root, 'campaigns');
  fs.mkdirSync(postsDir); fs.mkdirSync(campaignsDir);
  fs.writeFileSync(path.join(campaignsDir, 'campaign-test-plan.json'), JSON.stringify({ slots: postIds.map((postId, index) => ({ slot_id: `slot-${index + 1}`, date: '2030-01-01', time: `1${index}:00` })) }));
  for (const [index, postId] of postIds.entries()) {
    const folder = path.join(postsDir, postId); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({
      post_id: postId, campaign_id: 'campaign-test', slot_id: `slot-${index + 1}`, buffer_channel_id: 'channel-test',
      publishing_mode: 'mobile_finish', upload_status: 'uploaded', buffer_status: 'not_sent', errors: [],
      statuses: { generation: 'completed', review: 'approved', upload: 'uploaded', buffer: 'not_sent' },
    }));
  }
  return { postsDir, campaignsDir, metadata(postId) { return JSON.parse(fs.readFileSync(path.join(postsDir, postId, 'metadata.json'), 'utf8')); } };
}

function options(value, scheduleBufferPost) {
  return {
    postsDir: value.postsDir, campaignsDir: value.campaignsDir, scheduleBufferPost,
    getCampaign: () => ({ campaign_id: 'campaign-test', account_id: 'account-test', timezone: 'Asia/Riyadh', publishing_mode: 'mobile_finish' }),
    resolveCampaignAccount: () => ({ buffer_channel_id: 'channel-test', buffer_channel_name: 'Channel' }),
  };
}

function scheduled(postId) { return { buffer_scheduled_post_id: `buffer-${postId}`, scheduled_at: '2030-01-01T10:00:00.000Z' }; }

test('successful Buffer send preserves scheduled state', async () => {
  const value = fixture(['post-success']);
  const result = await sendUploadedCampaignPostsToBuffer('campaign-test', options(value, async (folder) => scheduled(path.basename(folder))));
  assert.equal(result.buffered_count, 1);
  assert.equal(value.metadata('post-success').buffer_status, 'notification_scheduled');
});

test('terminal Buffer failure persists a retryable buffer error', async () => {
  const value = fixture(['post-failure']);
  const result = await sendUploadedCampaignPostsToBuffer('campaign-test', options(value, async () => { throw new Error('Buffer unavailable'); }));
  const metadata = value.metadata('post-failure');
  assert.equal(result.failed_count, 1);
  assert.equal(result.failed_posts[0].stage, 'buffer');
  assert.equal(result.failed_posts[0].retryable, true);
  assert.equal(metadata.buffer_status, 'failed');
  assert.equal(metadata.statuses.buffer, 'failed');
  assert.equal(metadata.errors.at(-1).stage, 'buffer');
  assert.match(metadata.errors.at(-1).message, /Buffer unavailable/);
});

test('a failed Buffer post can succeed on a later retry', async () => {
  const value = fixture(['post-retry']);
  await sendUploadedCampaignPostsToBuffer('campaign-test', options(value, async () => { throw new Error('temporary Buffer failure'); }));
  const result = await sendUploadedCampaignPostsToBuffer('campaign-test', options(value, async (folder) => scheduled(path.basename(folder))));
  assert.equal(result.buffered_count, 1);
  assert.equal(value.metadata('post-retry').buffer_status, 'notification_scheduled');
});

test('one Buffer failure does not stop sibling uploaded posts', async () => {
  const value = fixture(['post-failed', 'post-succeeded']);
  const result = await sendUploadedCampaignPostsToBuffer('campaign-test', options(value, async (folder) => {
    if (path.basename(folder) === 'post-failed') throw new Error('temporary Buffer failure');
    return scheduled(path.basename(folder));
  }));
  assert.equal(result.failed_count, 1);
  assert.equal(result.buffered_count, 1);
  assert.equal(value.metadata('post-failed').buffer_status, 'failed');
  assert.equal(value.metadata('post-succeeded').buffer_status, 'notification_scheduled');
});
