'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { confirmBufferPublication, getPublicationForPost } = require('./publicationService');

const ROOT = path.resolve(__dirname, '../..');
const BUFFER_API_URL = 'https://api.buffer.com';

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }

function readApiKey(root) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) throw new Error('Buffer API key is unavailable');
  const key = dotenv.parse(fs.readFileSync(envPath)).BUFFER_API_KEY;
  if (!key || !key.trim()) throw new Error('Buffer API key is unavailable');
  return key.trim();
}

async function fetchBufferPostStatus(bufferPostId, { root = ROOT, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(BUFFER_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readApiKey(root)}` },
    body: JSON.stringify({ query: `query Post($input: PostInput!) { post(input: $input) { id status sentAt dueAt channelId } }`, variables: { input: { id: bufferPostId } } }),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`Buffer status response was not JSON (HTTP ${response.status})`); }
  if (!response.ok || (payload.errors && payload.errors.length)) throw new Error(`Buffer status check failed${payload.errors ? `: ${payload.errors.map((item) => item.message).join('; ')}` : ''}`);
  const post = payload.data && payload.data.post;
  if (!post || !post.id || !post.status) throw new Error('Buffer status response is incomplete');
  return post;
}

function isPublishedStatus(status) {
  return ['published', 'sent', 'successful', 'success'].includes(String(status || '').toLowerCase());
}

async function reconcileBufferPublications(options = {}) {
  const root = options.root || ROOT;
  const statusFor = options.fetchBufferPostStatus || ((id) => fetchBufferPostStatus(id, { root, fetchImpl: options.fetchImpl || fetch }));
  const postsDir = path.join(root, 'outputs', 'posts');
  const summary = { checked: 0, confirmed: 0, existing: 0, pending: 0, unavailable: 0, failures: [] };
  if (!fs.existsSync(postsDir)) return summary;
  for (const entry of fs.readdirSync(postsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(postsDir, entry.name, 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;
    let metadata;
    try { metadata = readJson(metadataPath); } catch { continue; }
    const postId = metadata.post_id || entry.name;
    const bufferPostId = metadata.buffer_scheduled_post_id || metadata.buffer_post_id;
    if (!bufferPostId || !metadata.account_id) continue;
    if (getPublicationForPost(postId, { root })) { summary.existing += 1; continue; }
    summary.checked += 1;
    try {
      const status = await statusFor(bufferPostId);
      if (!isPublishedStatus(status.status)) { summary.pending += 1; continue; }
      const result = confirmBufferPublication(postId, {
        buffer_post_id: status.id,
        buffer_status: status.status,
        buffer_channel_id: status.channelId || metadata.buffer_channel_id || null,
        published_at: status.sentAt || undefined,
        sent_at: status.sentAt || null,
      }, { root, now: options.now ? options.now() : new Date() });
      if (result.existing) summary.existing += 1;
      else summary.confirmed += 1;
    } catch (error) {
      summary.unavailable += 1;
      summary.failures.push({ post_id: postId, reason: error.message });
    }
  }
  return summary;
}

if (require.main === module) reconcileBufferPublications().then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => { console.error(`Buffer reconciliation failed: ${error.message}`); process.exitCode = 1; });

module.exports = { fetchBufferPostStatus, isPublishedStatus, reconcileBufferPublications };
