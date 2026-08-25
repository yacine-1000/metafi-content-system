'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { uploadApprovedCampaignPosts } = require('../../src/campaigns/campaignExecutor');

function fixture(postIds) {
  const postsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-upload-'));
  for (const postId of postIds) {
    const folder = path.join(postsDir, postId);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({
      post_id: postId, campaign_id: 'campaign-test', upload_status: 'not_started',
      statuses: { generation: 'completed', review: 'approved', upload: 'not_started' }, errors: [],
    }));
  }
  return {
    postsDir,
    metadata(postId) { return JSON.parse(fs.readFileSync(path.join(postsDir, postId, 'metadata.json'), 'utf8')); },
  };
}

function options(postsDir, uploadPostToR2) {
  return { postsDir, uploadPostToR2, getCampaign: () => ({ campaign_id: 'campaign-test', publishing_mode: 'automatic' }) };
}

test('successful approved upload preserves uploaded state', async () => {
  const value = fixture(['post-success']);
  const result = await uploadApprovedCampaignPosts('campaign-test', options(value.postsDir, async () => {}));
  assert.equal(result.uploaded_count, 1);
  assert.equal(value.metadata('post-success').upload_status, 'uploaded');
  assert.equal(value.metadata('post-success').statuses.upload, 'uploaded');
});

test('failed approved upload persists a retryable upload failure', async () => {
  const value = fixture(['post-failure']);
  const result = await uploadApprovedCampaignPosts('campaign-test', options(value.postsDir, async () => { throw new Error('R2 unavailable'); }));
  const metadata = value.metadata('post-failure');
  assert.equal(result.failed_count, 1);
  assert.equal(result.failed_posts[0].stage, 'upload');
  assert.equal(metadata.upload_status, 'failed');
  assert.equal(metadata.statuses.upload, 'failed');
  assert.deepEqual(metadata.errors.at(-1).stage, 'upload');
  assert.match(metadata.errors.at(-1).message, /R2 unavailable/);
});

test('a failed approved upload can succeed on a later retry', async () => {
  const value = fixture(['post-retry']);
  await uploadApprovedCampaignPosts('campaign-test', options(value.postsDir, async () => { throw new Error('temporary failure'); }));
  const result = await uploadApprovedCampaignPosts('campaign-test', options(value.postsDir, async () => {}));
  assert.equal(result.uploaded_count, 1);
  assert.equal(value.metadata('post-retry').upload_status, 'uploaded');
});

test('one failed upload does not stop sibling approved uploads', async () => {
  const value = fixture(['post-failed', 'post-succeeded']);
  const result = await uploadApprovedCampaignPosts('campaign-test', options(value.postsDir, async (folder) => {
    if (path.basename(folder) === 'post-failed') throw new Error('temporary failure');
  }));
  assert.equal(result.failed_count, 1);
  assert.equal(result.uploaded_count, 1);
  assert.equal(value.metadata('post-failed').upload_status, 'failed');
  assert.equal(value.metadata('post-succeeded').upload_status, 'uploaded');
});
