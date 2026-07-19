'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getCampaign, resolveCampaignAccount } = require('./campaignService');
const { generateSlideshows } = require('../generation/generateSlideshows');
const { uploadPostToR2 } = require('../generation/uploadToR2');
const { createBufferDraft } = require('../generation/createBufferDraft');
const { scheduleBufferPost } = require('../generation/scheduleBufferPost');
const { validateAccountVisualBanks } = require('../generation/resolvePostAssets');

const ROOT = path.resolve(__dirname, '../..');
const CAMPAIGNS_DIR = path.join(ROOT, 'data', 'campaigns');
const POSTS_DIR = path.join(ROOT, 'outputs', 'posts');

const CAMPAIGN_EXECUTION_CONFIG = Object.freeze({
  execution_window_days: 3,
  slot_claim_lease_ms: 15 * 60 * 1000,
  plan_lock_lease_ms: 30 * 1000,
});

class CampaignExecutionError extends Error {}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new CampaignExecutionError(`${label} is invalid: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, filePath);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 19) {
        try { fs.unlinkSync(temporaryPath); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function isValidLease(claim, now) {
  return Boolean(claim && typeof claim.claim_id === 'string' && claim.claim_id
    && typeof claim.lease_expires_at === 'string' && new Date(claim.lease_expires_at).getTime() > now.getTime());
}

function planLockPath(planPath) {
  return `${planPath}.lock`;
}

function acquirePlanMutationLock(planPath, now, leaseMs) {
  const lockPath = planLockPath(planPath);
  const lock = {
    lock_id: crypto.randomUUID(),
    acquired_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const temporaryPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
      fs.linkSync(temporaryPath, lockPath);
      fs.unlinkSync(temporaryPath);
      return lock;
    } catch (error) {
      try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch {}
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = readJson(lockPath, 'Campaign plan lock'); } catch {
        const invalidPath = `${lockPath}.${crypto.randomUUID()}.invalid`;
        try { fs.renameSync(lockPath, invalidPath); } catch {}
        try { if (fs.existsSync(invalidPath)) fs.unlinkSync(invalidPath); } catch {}
        continue;
      }
      if (isValidLease(existing, now)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      const expiredPath = `${lockPath}.${existing.lock_id || 'expired'}.${crypto.randomUUID()}.expired`;
      try { fs.renameSync(lockPath, expiredPath); } catch { continue; }
      try { fs.unlinkSync(expiredPath); } catch {}
    }
  }
  return null;
}

function releasePlanMutationLock(planPath, lock) {
  const lockPath = planLockPath(planPath);
  try {
    const current = readJson(lockPath, 'Campaign plan lock');
    if (current.lock_id === lock.lock_id) fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') return;
  }
}

function mutatePlan(planPath, now, leaseMs, mutate) {
  const lock = acquirePlanMutationLock(planPath, now, leaseMs);
  if (!lock) return { locked: false };
  try {
    return { locked: true, value: mutate(readJson(planPath, 'Campaign plan')) };
  } finally {
    releasePlanMutationLock(planPath, lock);
  }
}

function claimCampaignSlot(planPath, slotId, { now, leaseMs, planLockLeaseMs, isEligible }) {
  const result = mutatePlan(planPath, now, planLockLeaseMs, (plan) => {
    if (!Array.isArray(plan.slots)) throw new CampaignExecutionError('Campaign plan has an invalid structure');
    const slot = plan.slots.find((item) => item && item.slot_id === slotId);
    if (!slot || !isEligible(slot)) return null;
    if (isValidLease(slot.claim, now)) return null;
    const attemptCount = Number.isInteger(slot.attempt_count) && slot.attempt_count >= 0 ? slot.attempt_count + 1 : 1;
    const claim = {
      claim_id: crypto.randomUUID(),
      claimed_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      attempt_count: attemptCount,
    };
    slot.claim = claim;
    slot.attempt_count = attemptCount;
    writeJsonAtomic(planPath, plan);
    return { slot: { ...slot, claim: { ...claim } }, claim };
  });
  return result.locked ? result.value : null;
}

function completeClaimedSlot(planPath, slotId, claimId, { now, planLockLeaseMs, onComplete }) {
  const result = mutatePlan(planPath, now, planLockLeaseMs, (plan) => {
    if (!Array.isArray(plan.slots)) throw new CampaignExecutionError('Campaign plan has an invalid structure');
    const slot = plan.slots.find((item) => item && item.slot_id === slotId);
    if (!slot || !slot.claim || slot.claim.claim_id !== claimId) return false;
    onComplete(slot);
    delete slot.claim;
    writeJsonAtomic(planPath, plan);
    return true;
  });
  return result.locked && result.value === true;
}

function updateCampaignSlotAtomically(campaignId, slotId, update, options = {}) {
  const root = options.root || ROOT;
  const planPath = path.join(root, 'data', 'campaigns', campaignId, 'plan.json');
  const now = options.now || new Date();
  const result = mutatePlan(planPath, now, options.planLockLeaseMs || CAMPAIGN_EXECUTION_CONFIG.plan_lock_lease_ms, (plan) => {
    if (!Array.isArray(plan.slots)) throw new CampaignExecutionError('Campaign plan has an invalid structure');
    const slot = plan.slots.find((item) => item && item.slot_id === slotId);
    if (!slot) return null;
    const value = update(slot, plan);
    if (value === false || value == null) return null;
    writeJsonAtomic(planPath, plan);
    return value;
  });
  return result.locked ? result.value : null;
}

function localDateInTimezone(timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(date, offset) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + offset));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function failureReason(error) {
  const message = error && error.message ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000) || 'Campaign slot generation failed';
}

function attachCampaignMetadata(postFolder, campaign, slot, now = new Date()) {
  const metadataPath = path.join(postFolder, 'metadata.json');
  if (!fs.existsSync(metadataPath)) throw new Error('Generated post metadata.json is missing');
  const metadata = readJson(metadataPath, 'Generated post metadata.json');
  metadata.campaign_id = campaign.campaign_id;
  metadata.slot_id = slot.slot_id;
  metadata.account_id = campaign.account_id;
  metadata.buffer_channel_id = campaign.buffer_channel_id;
  metadata.account_internal_name = campaign.account_internal_name;
  metadata.account_username = campaign.account_username;
  metadata.account_language = campaign.account_language;
  metadata.account_timezone = campaign.account_timezone;
  metadata.publishing_mode = slot.publishing_mode || campaign.publishing_mode || 'mobile_finish';
  metadata.updated_at = now.toISOString();
  writeJsonAtomic(metadataPath, metadata);
}

function campaignScriptUsage(campaignId, postsDir = POSTS_DIR) {
  const scriptIds = new Set();
  if (!fs.existsSync(postsDir)) return scriptIds;
  for (const entry of fs.readdirSync(postsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(postsDir, entry.name, 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;
    try {
      const metadata = readJson(metadataPath, 'Post metadata.json');
      if (metadata.campaign_id === campaignId && metadata.master_script_id) scriptIds.add(metadata.master_script_id);
    } catch {
      // Invalid unrelated post metadata must not block eligible campaign slots.
    }
  }
  return scriptIds;
}

function executeCampaignWindow(campaignId, options = {}) {
  const root = options.root || ROOT;
  const campaignsDir = path.join(root, 'data', 'campaigns');
  const postsDir = path.join(root, 'outputs', 'posts');
  const readCampaign = options.getCampaign || getCampaign;
  const generate = options.generateSlideshows || generateSlideshows;
  const validateVisualBanks = options.validateAccountVisualBanks || validateAccountVisualBanks;
  const nowFor = options.now || (() => new Date());
  const campaign = readCampaign(campaignId);
  if (!campaign) return null;

  const executionWindowDays = options.execution_window_days == null
    ? CAMPAIGN_EXECUTION_CONFIG.execution_window_days
    : options.execution_window_days;
  if (!Number.isInteger(executionWindowDays) || executionWindowDays <= 0) {
    throw new CampaignExecutionError('execution_window_days must be a positive integer');
  }
  const slotClaimLeaseMs = options.slot_claim_lease_ms == null
    ? CAMPAIGN_EXECUTION_CONFIG.slot_claim_lease_ms
    : options.slot_claim_lease_ms;
  if (!Number.isInteger(slotClaimLeaseMs) || slotClaimLeaseMs <= 0) {
    throw new CampaignExecutionError('slot_claim_lease_ms must be a positive integer');
  }

  const planPath = path.join(campaignsDir, `${campaign.campaign_id}-plan.json`);
  if (!fs.existsSync(planPath)) throw new CampaignExecutionError('Campaign plan does not exist');
  let plan = readJson(planPath, 'Campaign plan');
  if (plan.campaign_id !== campaign.campaign_id || !Array.isArray(plan.slots)) {
    throw new CampaignExecutionError('Campaign plan has an invalid structure');
  }
  const accountFields = {
    account_id: campaign.account_id,
    buffer_channel_id: campaign.buffer_channel_id,
    account_internal_name: campaign.account_internal_name,
    account_username: campaign.account_username,
    account_language: campaign.account_language,
    account_timezone: campaign.account_timezone,
  };
  const accountContextMutation = mutatePlan(planPath, nowFor(), CAMPAIGN_EXECUTION_CONFIG.plan_lock_lease_ms, (latestPlan) => {
    if (latestPlan.campaign_id !== campaign.campaign_id || !Array.isArray(latestPlan.slots)) {
      throw new CampaignExecutionError('Campaign plan has an invalid structure');
    }
    Object.assign(latestPlan, accountFields);
    latestPlan.slots.forEach((slot) => Object.assign(slot, accountFields));
    writeJsonAtomic(planPath, latestPlan);
    return latestPlan;
  });
  if (!accountContextMutation.locked) return {
    campaign_id: campaign.campaign_id,
    execution_window_days: executionWindowDays,
    window_start: localDateInTimezone(campaign.timezone),
    window_end: addCalendarDays(localDateInTimezone(campaign.timezone), executionWindowDays - 1),
    generated_count: 0,
    failed_count: 0,
    skipped_claimed_count: 0,
    generated_post_ids: [],
    failed_slots: [],
    updated_at: nowFor().toISOString(),
  };
  plan = accountContextMutation.value;

  const windowStart = localDateInTimezone(campaign.timezone);
  const windowEnd = addCalendarDays(windowStart, executionWindowDays - 1);
  const isEligibleSlot = (slot) => (
    ['planned', 'failed'].includes(slot.status)
    && !slot.post_id
    && slot.date >= windowStart
    && slot.date <= windowEnd
  );
  const eligibleSlotIds = plan.slots.filter(isEligibleSlot).map((slot) => slot.slot_id);
  const generatedPostIds = [];
  const failedSlots = [];
  let skippedClaimedCount = 0;
  const usedScriptIds = campaignScriptUsage(campaign.campaign_id, postsDir);
  const batchSourceSetIds = new Set();

  for (const slotId of eligibleSlotIds) {
    const claimResult = claimCampaignSlot(planPath, slotId, {
      now: nowFor(),
      leaseMs: slotClaimLeaseMs,
      planLockLeaseMs: CAMPAIGN_EXECUTION_CONFIG.plan_lock_lease_ms,
      isEligible: isEligibleSlot,
    });
    if (!claimResult) {
      skippedClaimedCount += 1;
      continue;
    }
    const { slot, claim } = claimResult;
    try {
      validateVisualBanks(campaign.account_id, slot.language);
      const postId = `post-${slot.slot_id}`;
      const generation = generate({
        pillar: slot.pillar_id,
        hook: slot.hook_type,
        languages: [slot.language],
        postId,
        usedScriptIds: [...usedScriptIds],
        avoidedSourceSetIds: [...batchSourceSetIds],
        accountId: campaign.account_id,
      });
      if (!generation.posts || generation.posts.length !== 1) {
        throw new Error('Generation did not return exactly one post');
      }
      const generatedPost = generation.posts[0];
      const postFolder = path.resolve(root, generatedPost.post_folder);
      const generatedMetadata = readJson(path.join(postFolder, 'metadata.json'), 'Generated post metadata.json');
      attachCampaignMetadata(postFolder, campaign, slot, nowFor());
      if (generatedMetadata.master_script_id) usedScriptIds.add(generatedMetadata.master_script_id);
      if (generatedMetadata.topic_id) batchSourceSetIds.add(generatedMetadata.topic_id);
      if (completeClaimedSlot(planPath, slot.slot_id, claim.claim_id, {
        now: nowFor(),
        planLockLeaseMs: CAMPAIGN_EXECUTION_CONFIG.plan_lock_lease_ms,
        onComplete: (currentSlot) => {
          currentSlot.post_id = generatedPost.post_id;
          currentSlot.status = 'generated';
          delete currentSlot.failure_reason;
        },
      })) generatedPostIds.push(generatedPost.post_id);
    } catch (error) {
      const reason = failureReason(error);
      if (completeClaimedSlot(planPath, slot.slot_id, claim.claim_id, {
        now: nowFor(),
        planLockLeaseMs: CAMPAIGN_EXECUTION_CONFIG.plan_lock_lease_ms,
        onComplete: (currentSlot) => {
          currentSlot.status = 'failed';
          currentSlot.failure_reason = reason;
        },
      })) failedSlots.push({ slot_id: slot.slot_id, reason });
    }
  }

  const summary = {
    campaign_id: campaign.campaign_id,
    execution_window_days: executionWindowDays,
    window_start: windowStart,
    window_end: windowEnd,
    generated_count: generatedPostIds.length,
    failed_count: failedSlots.length,
    generated_post_ids: generatedPostIds,
    failed_slots: failedSlots,
    skipped_claimed_count: skippedClaimedCount,
    updated_at: nowFor().toISOString(),
  };
  writeJsonAtomic(path.join(campaignsDir, `${campaign.campaign_id}-execution.json`), summary);
  return summary;
}

async function uploadApprovedCampaignPosts(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  const uploadedPostIds = [];
  const failedPosts = [];
  let skippedCount = 0;
  const postFolders = fs.existsSync(POSTS_DIR)
    ? fs.readdirSync(POSTS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(POSTS_DIR, entry.name))
    : [];

  for (const postFolder of postFolders) {
    const metadataPath = path.join(postFolder, 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;
    let metadata;
    try {
      metadata = readJson(metadataPath, 'Post metadata.json');
    } catch {
      continue;
    }
    if (metadata.campaign_id !== campaign.campaign_id || !metadata.statuses || metadata.statuses.review !== 'approved') continue;
    const manifestPath = path.join(postFolder, 'r2-upload.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const existingManifest = readJson(manifestPath, 'R2 manifest');
        if (existingManifest.status === 'uploaded') {
          metadata.upload_status = 'uploaded';
          metadata.r2_manifest = 'r2-upload.json';
          metadata.statuses = { ...metadata.statuses, upload: 'uploaded' };
          metadata.updated_at = new Date().toISOString();
          writeJsonAtomic(metadataPath, metadata);
          skippedCount += 1;
          continue;
        }
      } catch {
        // A missing valid uploaded manifest is handled by the uploader below.
      }
    }
    try {
      await uploadPostToR2(postFolder);
      metadata.upload_status = 'uploaded';
      metadata.r2_manifest = 'r2-upload.json';
      metadata.statuses = { ...metadata.statuses, upload: 'uploaded' };
      metadata.updated_at = new Date().toISOString();
      writeJsonAtomic(metadataPath, metadata);
      uploadedPostIds.push(metadata.post_id || path.basename(postFolder));
    } catch (error) {
      failedPosts.push({
        post_id: metadata.post_id || path.basename(postFolder),
        stage: 'buffer_notification',
        error_message: error && error.message ? String(error.message) : String(error),
        failed_at: new Date().toISOString(),
        retryable: true,
      });
    }
  }

  return {
    campaign_id: campaign.campaign_id,
    uploaded_count: uploadedPostIds.length,
    skipped_count: skippedCount,
    failed_count: failedPosts.length,
    uploaded_post_ids: uploadedPostIds,
    failed_posts: failedPosts,
    updated_at: new Date().toISOString(),
  };
}

async function ensureBufferDraft(postFolder, account) {
  const draftPath = path.join(postFolder, 'buffer-draft.json');
  if (fs.existsSync(draftPath)) {
    const existing = readJson(draftPath, 'Buffer draft manifest');
    if (existing.buffer_post_id) {
      if (existing.channel_id !== account.buffer_channel_id) throw new Error('Existing Buffer draft belongs to a different account channel');
      return existing;
    }
  }
  return createBufferDraft(postFolder, { channelId: account.buffer_channel_id, channelName: account.buffer_channel_name || account.internal_name });
}

async function sendUploadedCampaignPostsToBuffer(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  const account = resolveCampaignAccount(campaign.account_id);
  if (!account.buffer_channel_id) throw new CampaignExecutionError('Campaign account has no Buffer channel configured');
  const planPath = path.join(CAMPAIGNS_DIR, `${campaign.campaign_id}-plan.json`);
  const plan = fs.existsSync(planPath) ? readJson(planPath, 'Campaign plan') : { slots: [] };
  const slotsById = new Map((plan.slots || []).map((slot) => [slot.slot_id, slot]));
  const bufferedPostIds = [];
  const failedPosts = [];
  let skippedCount = 0;
  const postFolders = fs.existsSync(POSTS_DIR)
    ? fs.readdirSync(POSTS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(POSTS_DIR, entry.name))
    : [];

  for (const postFolder of postFolders) {
    const metadataPath = path.join(postFolder, 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;
    let metadata;
    try {
      metadata = readJson(metadataPath, 'Post metadata.json');
    } catch {
      continue;
    }
    if (metadata.campaign_id !== campaign.campaign_id
      || !metadata.statuses || metadata.statuses.review !== 'approved'
      || metadata.upload_status !== 'uploaded') continue;
    const publishingMode = metadata.publishing_mode || campaign.publishing_mode || 'mobile_finish';
    if ((publishingMode === 'automatic' && metadata.buffer_status === 'buffered')
      || (publishingMode === 'mobile_finish' && metadata.buffer_status === 'notification_scheduled')) {
      skippedCount += 1;
      continue;
    }

    try {
      const slot = slotsById.get(metadata.slot_id);
      if (!slot) throw new Error('Linked campaign slot is missing from the plan');
      if (!metadata.buffer_channel_id) throw new Error('Post metadata is missing buffer_channel_id');
      if (metadata.buffer_channel_id !== account.buffer_channel_id) throw new Error('Post Buffer channel does not match the selected campaign account');
      let bufferPostId;
      let scheduledAt;
      let schedulingType;
      if (publishingMode === 'automatic') {
        await ensureBufferDraft(postFolder, account);
        const scheduled = await scheduleBufferPost(postFolder, {
          date: slot.date,
          time: slot.time,
          timezone: campaign.timezone,
          channelId: metadata.buffer_channel_id,
          channelName: account.buffer_channel_name || account.internal_name,
          schedulingType: 'automatic',
        });
        bufferPostId = scheduled.buffer_scheduled_post_id;
        scheduledAt = scheduled.scheduled_at;
        schedulingType = 'automatic';
      } else {
        const scheduled = await scheduleBufferPost(postFolder, {
          date: slot.date,
          time: slot.time,
          timezone: campaign.timezone,
          channelId: metadata.buffer_channel_id,
          channelName: account.buffer_channel_name || account.internal_name,
          schedulingType: 'notification',
        });
        bufferPostId = scheduled.buffer_scheduled_post_id;
        scheduledAt = scheduled.scheduled_at;
        schedulingType = 'notification';
      }
      if (!bufferPostId) throw new Error('Buffer response is missing the post ID');
      metadata = readJson(metadataPath, 'Post metadata.json');
      metadata.buffer_status = publishingMode === 'mobile_finish' ? 'notification_scheduled' : 'buffered';
      metadata.buffer_post_id = bufferPostId;
      metadata.buffered_at = new Date().toISOString();
      metadata.scheduled_at = scheduledAt;
      metadata.scheduling_type = schedulingType;
      metadata.publishing_mode = publishingMode;
      metadata.statuses = { ...(metadata.statuses || {}), buffer: metadata.buffer_status };
      metadata.updated_at = metadata.buffered_at;
      writeJsonAtomic(metadataPath, metadata);
      bufferedPostIds.push(metadata.post_id || path.basename(postFolder));
    } catch (error) {
      failedPosts.push({ post_id: metadata.post_id || path.basename(postFolder), reason: failureReason(error) });
    }
  }

  const executionPath = path.join(CAMPAIGNS_DIR, `${campaign.campaign_id}-execution.json`);
  if (fs.existsSync(executionPath)) {
    const execution = readJson(executionPath, 'Campaign execution summary');
    const confirmedBufferPostIds = new Set();
    execution.buffered_count = postFolders.reduce((count, postFolder) => {
      const metadataPath = path.join(postFolder, 'metadata.json');
      if (!fs.existsSync(metadataPath)) return count;
      try {
        const metadata = readJson(metadataPath, 'Post metadata.json');
        const confirmed = metadata.campaign_id === campaign.campaign_id && ['buffered', 'notification_scheduled'].includes(metadata.buffer_status);
        if (confirmed) confirmedBufferPostIds.add(metadata.post_id || path.basename(postFolder));
        return count + (confirmed ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
    const failuresByPostId = new Map((execution.buffer_failures || []).map((failure) => [failure.post_id, failure]));
    failedPosts.forEach((failure) => failuresByPostId.set(failure.post_id, failure));
    confirmedBufferPostIds.forEach((postId) => failuresByPostId.delete(postId));
    execution.buffer_failures = Array.from(failuresByPostId.values());
    execution.updated_at = new Date().toISOString();
    writeJsonAtomic(executionPath, execution);
  }

  return {
    campaign_id: campaign.campaign_id,
    buffered_count: bufferedPostIds.length,
    skipped_count: skippedCount,
    failed_count: failedPosts.length,
    buffered_post_ids: bufferedPostIds,
    failed_posts: failedPosts,
    updated_at: new Date().toISOString(),
  };
}

async function retryBufferNotificationPost(campaignId, postId, { local_date: date, local_time: time, timezone }) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  if (typeof postId !== 'string' || !/^post-[a-zA-Z0-9_-]+$/.test(postId)) throw new CampaignExecutionError('Invalid post ID');
  const postFolder = path.resolve(POSTS_DIR, postId);
  if (path.dirname(postFolder) !== path.resolve(POSTS_DIR) || !fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new CampaignExecutionError('Campaign post not found');
  }
  const metadataPath = path.join(postFolder, 'metadata.json');
  if (!fs.existsSync(metadataPath)) throw new CampaignExecutionError('Post metadata is missing');
  let metadata = readJson(metadataPath, 'Post metadata.json');
  if (metadata.campaign_id !== campaign.campaign_id) throw new CampaignExecutionError('Post does not belong to this campaign');
  if (metadata.publishing_mode !== 'mobile_finish') throw new CampaignExecutionError('Only Mobile Finish notification posts can be retried');
  if (metadata.buffer_status === 'notification_scheduled' || metadata.buffer_post_id) throw new CampaignExecutionError('Successful Buffer posts cannot be retried');

  const executionPath = path.join(CAMPAIGNS_DIR, `${campaign.campaign_id}-execution.json`);
  if (!fs.existsSync(executionPath)) throw new CampaignExecutionError('Campaign execution summary is missing');
  const execution = readJson(executionPath, 'Campaign execution summary');
  const persistedFailure = (execution.buffer_failures || []).find((failure) => failure.post_id === postId && failure.retryable === true);
  if (metadata.buffer_status !== 'not_sent' && !persistedFailure) throw new CampaignExecutionError('Post is not eligible for Buffer retry');

  const account = resolveCampaignAccount(campaign.account_id);
  if (!account.buffer_channel_id) throw new CampaignExecutionError('Campaign account has no Buffer channel configured');
  if (!metadata.buffer_channel_id) throw new CampaignExecutionError('Post metadata is missing buffer_channel_id');
  if (metadata.buffer_channel_id !== account.buffer_channel_id) throw new CampaignExecutionError('Post Buffer channel does not match the selected campaign account');

  try {
    const scheduled = await scheduleBufferPost(postFolder, {
      date,
      time,
      timezone,
      channelId: metadata.buffer_channel_id,
      channelName: account.buffer_channel_name || account.internal_name,
      schedulingType: 'notification',
    });
    metadata = readJson(metadataPath, 'Post metadata.json');
    metadata.buffer_status = 'notification_scheduled';
    metadata.buffer_post_id = scheduled.buffer_scheduled_post_id;
    metadata.buffered_at = new Date().toISOString();
    metadata.scheduled_at = scheduled.scheduled_at;
    metadata.scheduling_type = 'notification';
    metadata.publishing_mode = 'mobile_finish';
    metadata.statuses = { ...(metadata.statuses || {}), buffer: 'notification_scheduled' };
    metadata.updated_at = metadata.buffered_at;
    writeJsonAtomic(metadataPath, metadata);
    execution.buffer_failures = (execution.buffer_failures || []).filter((failure) => failure.post_id !== postId);
    execution.buffered_count = Number(execution.buffered_count || 0) + 1;
    execution.updated_at = metadata.buffered_at;
    writeJsonAtomic(executionPath, execution);
    return {
      campaign_id: campaign.campaign_id,
      post_id: metadata.post_id,
      buffer_status: metadata.buffer_status,
      buffer_post_id: metadata.buffer_post_id,
      scheduled_at: metadata.scheduled_at,
      timezone,
    };
  } catch (error) {
    const failure = {
      post_id: metadata.post_id || postId,
      stage: 'buffer_notification',
      error_message: error && error.message ? String(error.message) : String(error),
      failed_at: new Date().toISOString(),
      retryable: true,
    };
    const failuresByPostId = new Map((execution.buffer_failures || []).map((item) => [item.post_id, item]));
    failuresByPostId.set(postId, failure);
    execution.buffer_failures = Array.from(failuresByPostId.values());
    execution.updated_at = failure.failed_at;
    writeJsonAtomic(executionPath, execution);
    throw new CampaignExecutionError(failure.error_message);
  }
}

module.exports = {
  CAMPAIGN_EXECUTION_CONFIG,
  CampaignExecutionError,
  executeCampaignWindow,
  updateCampaignSlotAtomically,
  retryBufferNotificationPost,
  sendUploadedCampaignPostsToBuffer,
  uploadApprovedCampaignPosts,
};
