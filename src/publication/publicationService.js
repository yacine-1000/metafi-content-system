'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '../..');
const POST_ID_PATTERN = /^post-[A-Za-z0-9_-]+$/;

class PublicationValidationError extends Error {}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new PublicationValidationError(`${label} is missing`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new PublicationValidationError(`${label} is invalid: ${error.message}`);
  }
}

function historyPath(root) {
  return path.join(root, 'data', 'publication-history.json');
}

function readPublicationHistory({ root = DEFAULT_ROOT } = {}) {
  const filePath = historyPath(root);
  if (!fs.existsSync(filePath)) return { publications: [] };
  const history = readJson(filePath, 'Publication history');
  if (!history || !Array.isArray(history.publications)) {
    throw new PublicationValidationError('Publication history must contain a publications array');
  }
  return history;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function requiredIdentity(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new PublicationValidationError(`${label} is missing`);
  return value;
}

function safeFileIdentity(value, label) {
  const identity = requiredIdentity(value, label);
  if (!/^[A-Za-z0-9_-]+$/.test(identity)) throw new PublicationValidationError(`${label} is invalid`);
  return identity;
}

function derivePostIdentity(postId, root) {
  if (typeof postId !== 'string' || !POST_ID_PATTERN.test(postId)) {
    throw new PublicationValidationError('Invalid post ID');
  }
  const postsDir = path.resolve(root, 'outputs', 'posts');
  const postDir = path.resolve(postsDir, postId);
  if (path.dirname(postDir) !== postsDir || !fs.existsSync(postDir) || !fs.statSync(postDir).isDirectory()) {
    throw new PublicationValidationError('Post not found');
  }
  const metadata = readJson(path.join(postDir, 'metadata.json'), 'Post metadata');
  if (metadata.post_id && metadata.post_id !== postId) throw new PublicationValidationError('Post metadata ID does not match the requested post');

  const campaignId = safeFileIdentity(metadata.campaign_id, 'Post campaign identity');
  const slotId = requiredIdentity(metadata.slot_id, 'Post slot identity');
  const accountId = safeFileIdentity(metadata.account_id, 'Post account identity');
  const scriptId = requiredIdentity(metadata.master_script_id, 'Post script identity');
  const sourceSetId = requiredIdentity(metadata.topic_id, 'Post source-set identity');
  const campaign = readJson(path.join(root, 'data', 'campaigns', `${campaignId}.json`), 'Campaign');
  if (campaign.campaign_id !== campaignId) throw new PublicationValidationError('Campaign identity does not match the post');
  if (campaign.account_id !== accountId) throw new PublicationValidationError('Campaign account does not match the post');

  const plan = readJson(path.join(root, 'data', 'campaigns', `${campaignId}-plan.json`), 'Campaign plan');
  if (plan.campaign_id !== campaignId || !Array.isArray(plan.slots)) throw new PublicationValidationError('Campaign plan has an invalid structure');
  const slot = plan.slots.find((item) => item && item.slot_id === slotId);
  if (!slot) throw new PublicationValidationError('Post slot is missing from the campaign plan');
  if (slot.post_id !== postId) throw new PublicationValidationError('Campaign slot is not linked to this post');
  if (slot.account_id !== accountId) throw new PublicationValidationError('Campaign slot account does not match the post');

  const account = readJson(path.join(root, 'data', 'accounts', `${accountId}.json`), 'Account');
  if (account.account_id !== accountId) throw new PublicationValidationError('Account identity does not match the post');
  return { post_id: postId, campaign_id: campaignId, slot_id: slotId, account_id: accountId, script_id: scriptId, source_set_id: sourceSetId };
}

function validatedTimestamp(value, now) {
  if (value == null || value === '') return now.toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new PublicationValidationError('published_at must be an ISO 8601 UTC timestamp');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new PublicationValidationError('published_at is invalid');
  return parsed.toISOString();
}

function validatedExternalUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new PublicationValidationError('external_url must be a URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw new PublicationValidationError('external_url must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new PublicationValidationError('external_url must be a valid HTTP(S) URL');
  return parsed.toString();
}

function getPublicationForPost(postId, options = {}) {
  return readPublicationHistory(options).publications.find((record) => record.post_id === postId) || null;
}

function markPostPosted(postId, input = {}, { root = DEFAULT_ROOT, now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicationValidationError('Request body must be a JSON object');
  const unsupported = Object.keys(input).filter((key) => !['published_at', 'external_url'].includes(key));
  if (unsupported.length) throw new PublicationValidationError(`Unsupported publication field: ${unsupported[0]}`);

  const history = readPublicationHistory({ root });
  const existing = history.publications.find((record) => record.post_id === postId);
  if (existing) return { publication: existing, existing: true };

  const identity = derivePostIdentity(postId, root);
  if (Number.isNaN(now.getTime())) throw new PublicationValidationError('Confirmation timestamp is invalid');
  const confirmedAt = now.toISOString();
  const publication = {
    publication_id: `publication_${crypto.randomUUID()}`,
    ...identity,
    method: 'manual',
    published_at: validatedTimestamp(input.published_at, now),
    confirmed_at: confirmedAt,
    external_url: validatedExternalUrl(input.external_url),
  };
  writeJsonAtomic(historyPath(root), { publications: [...history.publications, publication] });
  return { publication, existing: false };
}

module.exports = {
  PublicationValidationError,
  getPublicationForPost,
  markPostPosted,
  readPublicationHistory,
};
