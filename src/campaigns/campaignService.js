'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getAccount, listAccounts } = require('../accounts/accountService');

const ROOT = path.resolve(__dirname, '../..');
const CAMPAIGNS_DIR = path.join(ROOT, 'data', 'campaigns');
const CAMPAIGN_ID_PATTERN = /^campaign-[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/;
const OBJECTIVES = new Set(['brand_awareness', 'app_installs', 'account_warm_up', 'content_testing']);
const LANGUAGES = new Set(['ar', 'en', 'es', 'fr']);
const PILLARS = new Set(['p1', 'p2', 'p3', 'p4']);
const POSTING_TIME_MODES = new Set(['manual', 'random']);
const PUBLISHING_MODES = new Set(['automatic', 'mobile_finish']);
const HOOK_TYPES = new Set([
  'listicle',
  'Contrarian / Warning',
  'How-to',
  'Identity Callout',
  'Mistakes',
  'Original',
  'POV / Question',
  'Story / Regret / Realization',
  'Tips / Things',
]);

class CampaignValidationError extends Error {}
class CampaignConflictError extends Error {}

function resolveCampaignAccount(accountId) {
  let account;
  try {
    account = getAccount(accountId);
  } catch {
    throw new CampaignValidationError('Campaign account_id is invalid');
  }
  if (accountId === 'account_1') {
    const candidates = listAccounts().filter((item) => {
      const values = [item.username, item.internal_name, item.display_name, item.buffer_channel_name]
        .map((value) => String(value || '').replace(/^@/, '').trim().toLowerCase());
      return values.includes('metafi.app');
    });
    if (candidates.length === 0) throw new CampaignValidationError('Legacy campaign account_1 cannot be mapped: no metafi.app account exists');
    if (candidates.length > 1) throw new CampaignValidationError('Legacy campaign account_1 cannot be mapped safely: multiple metafi.app accounts exist');
    account = candidates[0];
  }
  if (!account) throw new CampaignValidationError(`Campaign account does not exist: ${accountId}`);
  if (account.active !== true) throw new CampaignValidationError(`Campaign account is inactive: ${account.account_id}`);
  if (account.connection_status !== 'connected') throw new CampaignValidationError(`Campaign account is disconnected: ${account.account_id}`);
  if (!account.buffer_channel_id) throw new CampaignValidationError(`Campaign account is missing buffer_channel_id: ${account.account_id}`);
  return account;
}

function accountSnapshot(account) {
  return {
    account_id: account.account_id,
    buffer_channel_id: account.buffer_channel_id,
    account_internal_name: account.internal_name,
    account_username: account.username,
    account_language: account.language,
    account_timezone: account.timezone,
  };
}

function hydrateCampaign(campaign) {
  const account = resolveCampaignAccount(campaign.account_id);
  return {
    ...campaign,
    ...accountSnapshot(account),
    publishing_mode: campaign.publishing_mode || 'mobile_finish',
  };
}

function ensureCampaignsDir() {
  fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function campaignPath(campaignId) {
  if (typeof campaignId !== 'string' || !CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new CampaignValidationError('Invalid campaign ID');
  }
  const filePath = path.resolve(CAMPAIGNS_DIR, `${campaignId}.json`);
  if (path.dirname(filePath) !== path.resolve(CAMPAIGNS_DIR)) {
    throw new CampaignValidationError('Invalid campaign ID');
  }
  return filePath;
}

function generateCampaignId() {
  ensureCampaignsDir();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const id = `campaign-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
    if (!fs.existsSync(campaignPath(id))) return id;
  }
  throw new CampaignConflictError('Unable to generate a unique campaign ID');
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CampaignValidationError('Campaign body must be a JSON object');
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new CampaignValidationError('name is required');
  }
  if (!OBJECTIVES.has(input.objective)) {
    throw new CampaignValidationError('objective is invalid');
  }
  resolveCampaignAccount(input.account_id);
  if (!LANGUAGES.has(input.language)) {
    throw new CampaignValidationError('language must be ar, en, es, or fr');
  }
  if (!isValidDate(input.start_date)) {
    throw new CampaignValidationError('start_date must be a valid YYYY-MM-DD date');
  }
  if (!Number.isInteger(input.duration_days) || input.duration_days <= 0) {
    throw new CampaignValidationError('duration_days must be a positive integer');
  }
  if (!Number.isInteger(input.posts_per_day) || input.posts_per_day <= 0) {
    throw new CampaignValidationError('posts_per_day must be a positive integer');
  }
  if (!Array.isArray(input.pillars) || input.pillars.length === 0) {
    throw new CampaignValidationError('pillars must be a non-empty array');
  }
  const seenPillars = new Set();
  let percentageTotal = 0;
  for (const pillar of input.pillars) {
    if (!pillar || !PILLARS.has(pillar.pillar_id)) {
      throw new CampaignValidationError('pillar_id must be p1, p2, p3, or p4');
    }
    if (seenPillars.has(pillar.pillar_id)) {
      throw new CampaignValidationError('pillar_id values must be unique');
    }
    if (!Number.isInteger(pillar.percentage) || pillar.percentage <= 0) {
      throw new CampaignValidationError('pillar percentage must be a positive integer');
    }
    seenPillars.add(pillar.pillar_id);
    percentageTotal += pillar.percentage;
  }
  if (percentageTotal !== 100) {
    throw new CampaignValidationError('pillar percentages must total exactly 100');
  }
  if (!Array.isArray(input.hook_types) || input.hook_types.length === 0
    || new Set(input.hook_types).size !== input.hook_types.length
    || input.hook_types.some((hookType) => !HOOK_TYPES.has(hookType))) {
    throw new CampaignValidationError('hook_types must contain unique supported hook types');
  }
  if (!POSTING_TIME_MODES.has(input.posting_time_mode)) {
    throw new CampaignValidationError('posting_time_mode must be manual or random');
  }
  if (!PUBLISHING_MODES.has(input.publishing_mode == null ? 'mobile_finish' : input.publishing_mode)) {
    throw new CampaignValidationError('publishing_mode must be automatic or mobile_finish');
  }
  if (input.posting_time_mode === 'manual') {
    if (!Array.isArray(input.posting_times) || input.posting_times.length !== input.posts_per_day) {
      throw new CampaignValidationError('manual mode requires exactly posts_per_day posting times');
    }
    if (input.posting_times.some((time) => typeof time !== 'string' || !isValidTime(time))) {
      throw new CampaignValidationError('posting_times must use HH:mm');
    }
  }
  if (typeof input.timezone !== 'string' || !isValidTimezone(input.timezone)) {
    throw new CampaignValidationError('timezone must be a valid IANA timezone');
  }
  if (input.campaign_id != null && !CAMPAIGN_ID_PATTERN.test(input.campaign_id)) {
    throw new CampaignValidationError('Invalid campaign ID');
  }
}

function createCampaign(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CampaignValidationError('Campaign body must be a JSON object');
  const account = resolveCampaignAccount(input.account_id);
  const normalizedInput = {
    ...input,
    account_id: account.account_id,
    language: input.language || account.language,
    timezone: input.timezone || account.timezone,
    publishing_mode: input.publishing_mode || 'mobile_finish',
  };
  validateInput(normalizedInput);
  ensureCampaignsDir();
  const campaignId = normalizedInput.campaign_id || generateCampaignId();
  const filePath = campaignPath(campaignId);
  if (fs.existsSync(filePath)) throw new CampaignConflictError('Campaign ID already exists');

  const now = new Date().toISOString();
  const campaign = {
    campaign_id: campaignId,
    name: normalizedInput.name.trim(),
    objective: normalizedInput.objective,
    ...accountSnapshot(account),
    language: normalizedInput.language,
    start_date: normalizedInput.start_date,
    duration_days: normalizedInput.duration_days,
    posts_per_day: normalizedInput.posts_per_day,
    pillars: normalizedInput.pillars.map(({ pillar_id, percentage }) => ({ pillar_id, percentage })),
    hook_types: [...normalizedInput.hook_types],
    posting_time_mode: normalizedInput.posting_time_mode,
    posting_times: normalizedInput.posting_time_mode === 'random' ? [] : [...normalizedInput.posting_times],
    publishing_mode: normalizedInput.publishing_mode,
    timezone: normalizedInput.timezone,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
  fs.writeFileSync(filePath, JSON.stringify(campaign, null, 2), { encoding: 'utf8', flag: 'wx' });
  return campaign;
}

function getCampaign(campaignId) {
  ensureCampaignsDir();
  const filePath = campaignPath(campaignId);
  if (!fs.existsSync(filePath)) return null;
  return hydrateCampaign(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function listCampaigns() {
  ensureCampaignsDir();
  return fs.readdirSync(CAMPAIGNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, entry.name), 'utf8')))
    .filter((campaign) => campaign && typeof campaign.name === 'string' && campaign.account_id)
    .map(hydrateCampaign)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function updateCampaign(campaignId, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new CampaignValidationError('Campaign body must be a JSON object');
  }
  const allowed = new Set([
    'name', 'objective', 'start_date', 'duration_days', 'posts_per_day', 'pillars',
    'hook_types', 'posting_time_mode', 'posting_times', 'publishing_mode', 'timezone', 'status',
  ]);
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new CampaignValidationError('No campaign fields supplied');
  if (keys.some((key) => !allowed.has(key))) {
    throw new CampaignValidationError('Campaign contains a locked or unsupported field');
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'status') && !['active', 'paused'].includes(changes.status)) {
    throw new CampaignValidationError('status must be active or paused');
  }

  const existing = getCampaign(campaignId);
  if (!existing) return null;
  const account = resolveCampaignAccount(existing.account_id);
  const updated = { ...existing, ...changes, ...accountSnapshot(account), campaign_id: existing.campaign_id, language: existing.language };
  validateInput(updated);
  updated.name = updated.name.trim();
  updated.pillars = updated.pillars.map(({ pillar_id, percentage }) => ({ pillar_id, percentage }));
  updated.hook_types = [...updated.hook_types];
  updated.posting_times = updated.posting_time_mode === 'random' ? [] : [...updated.posting_times];
  updated.created_at = existing.created_at;
  updated.updated_at = new Date().toISOString();
  fs.writeFileSync(campaignPath(campaignId), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

function deleteCampaign(campaignId) {
  ensureCampaignsDir();
  const filePath = campaignPath(campaignId);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

module.exports = {
  CampaignConflictError,
  CampaignValidationError,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  resolveCampaignAccount,
  updateCampaign,
};
