'use strict';

const fs = require('fs');
const path = require('path');
const { executeCampaignWindow } = require('./campaignExecutor');
const { CampaignValidationError } = require('./campaignService');

const ROOT = path.resolve(__dirname, '../..');
const DAILY_LOCK_LEASE_MS = 30 * 60 * 1000;

function localDateInTimezone(timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function campaignEndDate(campaign) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(campaign.start_date || '') || !Number.isInteger(campaign.duration_days) || campaign.duration_days <= 0) return null;
  const date = new Date(`${campaign.start_date}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + campaign.duration_days - 1);
  return date.toISOString().slice(0, 10);
}

function listStoredCampaigns(root) {
  const directory = path.join(root, 'data', 'campaigns');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^campaign-[a-z0-9][a-z0-9-]*\.json$/.test(entry.name)
      && !entry.name.endsWith('-plan.json') && !entry.name.endsWith('-execution.json'))
    .map((entry) => {
      try { return JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')); }
      catch { return { campaign_id: entry.name.slice(0, -5), invalid: true }; }
    });
}

function acquireDailyLock(lockPath, now, leaseMs) {
  const lock = { pid: process.pid, acquired_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + leaseMs).toISOString() };
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
    return lock;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (new Date(existing.lease_expires_at).getTime() > now.getTime()) return null;
    } catch {}
    try { fs.unlinkSync(lockPath); } catch { return null; }
    return acquireDailyLock(lockPath, now, leaseMs);
  }
}

function releaseDailyLock(lockPath, lock) {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.pid === lock.pid && current.acquired_at === lock.acquired_at) fs.unlinkSync(lockPath);
  } catch {}
}

function runDailyCampaigns(options = {}) {
  const root = options.root || ROOT;
  const now = (options.now || (() => new Date()))();
  const execute = options.executeCampaignWindow || executeCampaignWindow;
  const campaigns = (options.listCampaigns || (() => listStoredCampaigns(root)))();
  const lockPath = options.lockPath || path.join(root, 'data', 'campaigns', 'daily-run.lock');
  const lock = acquireDailyLock(lockPath, now, options.lockLeaseMs || DAILY_LOCK_LEASE_MS);
  if (!lock) return { locked: true, campaigns: [], generated: 0, skipped: 0, failed: 0, updated_at: now.toISOString() };
  const results = [];
  try {
    for (const campaign of campaigns) {
      const campaignId = campaign && campaign.campaign_id;
      const invalid = !campaign || campaign.invalid || typeof campaignId !== 'string' || !campaignId || !campaign.timezone || !campaignEndDate(campaign);
      if (invalid || campaign.status !== 'active') {
        results.push({ campaign_id: campaignId || null, status: 'skipped', reason: invalid ? 'invalid campaign' : `campaign is ${campaign.status || 'not active'}`, generated: 0, skipped: 0, failed: 0 });
        continue;
      }
      if (campaignEndDate(campaign) < localDateInTimezone(campaign.timezone)) {
        results.push({ campaign_id: campaignId, status: 'skipped', reason: 'campaign has ended', generated: 0, skipped: 0, failed: 0 });
        continue;
      }
      try {
        const summary = execute(campaignId, { root });
        results.push({ campaign_id: campaignId, status: 'completed', generated: summary.generated_count || 0, skipped: summary.skipped_claimed_count || 0, failed: summary.failed_count || 0 });
      } catch (error) {
        if (error instanceof CampaignValidationError) {
          results.push({ campaign_id: campaignId, status: 'skipped', reason: 'invalid campaign', generated: 0, skipped: 0, failed: 0 });
        } else {
          results.push({ campaign_id: campaignId, status: 'failed', reason: error.message, generated: 0, skipped: 0, failed: 1 });
        }
      }
    }
  } finally {
    releaseDailyLock(lockPath, lock);
  }
  return {
    locked: false,
    campaigns: results,
    generated: results.reduce((total, item) => total + item.generated, 0),
    skipped: results.reduce((total, item) => total + item.skipped + (item.status === 'skipped' ? 1 : 0), 0),
    failed: results.reduce((total, item) => total + item.failed, 0),
    updated_at: now.toISOString(),
  };
}

if (require.main === module) console.log(JSON.stringify(runDailyCampaigns(), null, 2));

module.exports = { DAILY_LOCK_LEASE_MS, runDailyCampaigns };
