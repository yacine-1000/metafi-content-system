'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { uploadApprovedCampaignPosts, sendUploadedCampaignPostsToBuffer } = require('../../src/campaigns/campaignExecutor');
const { scheduleBufferPost } = require('../../src/generation/scheduleBufferPost');

function response(status, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function bufferPost(postId, post) {
  return { id: postId, text: 'Caption', status: 'scheduled', dueAt: '2030-01-01T12:00:00.000Z', sentAt: null,
    channelId: 'channel-test', channelService: 'tiktok', assets: [{ source: `https://example.com/${post}/slide.png` }] };
}

function fixture(postIds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-publishing-chain-'));
  const postsDir = path.join(root, 'posts'); const campaignsDir = path.join(root, 'campaigns');
  fs.mkdirSync(postsDir); fs.mkdirSync(campaignsDir);
  fs.writeFileSync(path.join(campaignsDir, 'campaign-test-plan.json'), JSON.stringify({ slots: postIds.map((postId, index) => ({ slot_id: `slot-${index + 1}`, date: '2030-01-01', time: '12:00' })) }));
  for (const [index, postId] of postIds.entries()) {
    const folder = path.join(postsDir, postId); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'caption.txt'), 'Caption');
    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({
      post_id: postId, campaign_id: 'campaign-test', slot_id: `slot-${index + 1}`, buffer_channel_id: 'channel-test',
      publishing_mode: 'mobile_finish', upload_status: 'not_started', buffer_status: 'not_sent', errors: [],
      statuses: { generation: 'completed', review: 'approved', upload: 'not_started', buffer: 'not_sent' },
    }));
  }
  return { postsDir, campaignsDir, folder: (postId) => path.join(postsDir, postId), metadata(postId) { return JSON.parse(fs.readFileSync(path.join(postsDir, postId, 'metadata.json'), 'utf8')); } };
}

function campaignOptions(value) {
  return {
    postsDir: value.postsDir, campaignsDir: value.campaignsDir,
    getCampaign: () => ({ campaign_id: 'campaign-test', account_id: 'account-test', timezone: 'UTC', publishing_mode: 'mobile_finish' }),
    resolveCampaignAccount: () => ({ buffer_channel_id: 'channel-test', buffer_channel_name: 'Channel' }),
  };
}

async function uploadManifest(folder) {
  fs.writeFileSync(path.join(folder, 'r2-upload.json'), JSON.stringify({ status: 'uploaded', files: [{ slide_number: 1, public_url: `https://example.com/${path.basename(folder)}/slide.png` }] }));
}

function scheduler(fetchImpl) {
  return (folder, args) => scheduleBufferPost(folder, args, { apiKey: 'key', fetchImpl });
}

async function uploadAll(value, uploadPostToR2 = uploadManifest) {
  return uploadApprovedCampaignPosts('campaign-test', { ...campaignOptions(value), uploadPostToR2 });
}

test('campaign publishing chain handles success, failures, retries, recovery, and siblings', async (t) => {
  await t.test('happy path reaches uploaded and notification scheduled', async () => {
    const value = fixture(['post-happy']);
    await uploadAll(value);
    const result = await sendUploadedCampaignPostsToBuffer('campaign-test', {
      ...campaignOptions(value), scheduleBufferPost: scheduler(async (_url, request) => response(200, {
        data: { createPost: { __typename: 'PostActionSuccess', post: bufferPost('buffer-happy', path.basename(value.folder('post-happy'))) } },
      })),
    });
    assert.equal(result.buffered_count, 1);
    assert.equal(value.metadata('post-happy').upload_status, 'uploaded');
    assert.equal(value.metadata('post-happy').buffer_status, 'notification_scheduled');
  });

  await t.test('upload failure is retryable and does not call Buffer', async () => {
    const value = fixture(['post-upload-fail']); let calls = 0;
    await uploadAll(value, async () => { throw new Error('R2 unavailable'); });
    const result = await sendUploadedCampaignPostsToBuffer('campaign-test', {
      ...campaignOptions(value), scheduleBufferPost: async () => { calls += 1; },
    });
    assert.equal(calls, 0);
    assert.equal(result.buffered_count, 0);
    assert.equal(value.metadata('post-upload-fail').upload_status, 'failed');
    assert.equal(value.metadata('post-upload-fail').errors.at(-1).stage, 'upload');
  });

  await t.test('Buffer 500 retries then schedules', async () => {
    const value = fixture(['post-transient']); let creates = 0;
    await uploadAll(value);
    await sendUploadedCampaignPostsToBuffer('campaign-test', {
      ...campaignOptions(value), scheduleBufferPost: scheduler(async (_url, request) => {
        if (!JSON.parse(request.body).query.includes('CreateScheduledPost')) throw new Error('unexpected recovery lookup');
        creates += 1;
        return creates === 1 ? response(500) : response(200, { data: { createPost: { __typename: 'PostActionSuccess', post: bufferPost('buffer-transient', 'post-transient') } } });
      }),
    });
    assert.equal(creates, 2);
    assert.equal(value.metadata('post-transient').buffer_status, 'notification_scheduled');
  });

  await t.test('terminal Buffer failure persists a retryable buffer failure', async () => {
    const value = fixture(['post-buffer-fail']);
    await uploadAll(value);
    const result = await sendUploadedCampaignPostsToBuffer('campaign-test', {
      ...campaignOptions(value), scheduleBufferPost: scheduler(async () => response(200, { data: { createPost: { __typename: 'MutationError', message: 'invalid schedule' } } })),
    });
    assert.equal(result.failed_count, 1);
    assert.equal(value.metadata('post-buffer-fail').buffer_status, 'failed');
    assert.equal(value.metadata('post-buffer-fail').errors.at(-1).stage, 'buffer');
    assert.equal(result.failed_posts[0].retryable, true);
  });

  await t.test('ambiguous timeout recovers the provider post without a duplicate create', async () => {
    const value = fixture(['post-ambiguous']); let creates = 0;
    await uploadAll(value);
    await sendUploadedCampaignPostsToBuffer('campaign-test', {
      ...campaignOptions(value), scheduleBufferPost: scheduler(async (_url, request) => {
        const query = JSON.parse(request.body).query;
        if (query.includes('CreateScheduledPost')) {
          creates += 1;
          return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('client timed out'))));
        }
        if (query.includes('BufferOrganizations')) return response(200, { data: { account: { organizations: [{ id: 'organization-1' }] } } });
        return response(200, { data: { posts: { edges: [{ node: bufferPost('buffer-ambiguous', 'post-ambiguous') }] } } });
      }),
    });
    assert.equal(creates, 1);
    assert.equal(value.metadata('post-ambiguous').buffer_post_id, 'buffer-ambiguous');
  });

  await t.test('one Buffer failure does not stop a sibling post', async () => {
    const value = fixture(['post-failed', 'post-succeeded']);
    await uploadAll(value);
    const result = await sendUploadedCampaignPostsToBuffer('campaign-test', {
      ...campaignOptions(value), scheduleBufferPost: scheduler(async (_url, request) => {
        const postId = JSON.parse(request.body).variables.input.assets[0].image.url.split('/')[3];
        if (postId === 'post-failed') return response(200, { data: { createPost: { __typename: 'MutationError', message: 'invalid' } } });
        return response(200, { data: { createPost: { __typename: 'PostActionSuccess', post: bufferPost('buffer-succeeded', postId) } } });
      }),
    });
    assert.equal(result.failed_count, 1);
    assert.equal(result.buffered_count, 1);
    assert.equal(value.metadata('post-failed').buffer_status, 'failed');
    assert.equal(value.metadata('post-succeeded').buffer_status, 'notification_scheduled');
  });
});
