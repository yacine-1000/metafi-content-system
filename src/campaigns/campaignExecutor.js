'use strict';

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
  fs.renameSync(temporaryPath, filePath);
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

function attachCampaignMetadata(postFolder, campaign, slot) {
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
  metadata.updated_at = new Date().toISOString();
  writeJsonAtomic(metadataPath, metadata);
}

function campaignScriptUsage(campaignId) {
  const scriptIds = new Set();
  if (!fs.existsSync(POSTS_DIR)) return scriptIds;
  for (const entry of fs.readdirSync(POSTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(POSTS_DIR, entry.name, 'metadata.json');
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
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;

  const executionWindowDays = options.execution_window_days == null
    ? CAMPAIGN_EXECUTION_CONFIG.execution_window_days
    : options.execution_window_days;
  if (!Number.isInteger(executionWindowDays) || executionWindowDays <= 0) {
    throw new CampaignExecutionError('execution_window_days must be a positive integer');
  }

  const planPath = path.join(CAMPAIGNS_DIR, `${campaign.campaign_id}-plan.json`);
  if (!fs.existsSync(planPath)) throw new CampaignExecutionError('Campaign plan does not exist');
  const plan = readJson(planPath, 'Campaign plan');
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
  Object.assign(plan, accountFields);
  plan.slots.forEach((slot) => Object.assign(slot, accountFields));
  writeJsonAtomic(planPath, plan);

  const windowStart = localDateInTimezone(campaign.timezone);
  const windowEnd = addCalendarDays(windowStart, executionWindowDays - 1);
  const eligibleSlots = plan.slots.filter((slot) => (
    ['planned', 'failed'].includes(slot.status)
    && !slot.post_id
    && slot.date >= windowStart
    && slot.date <= windowEnd
  ));
  const generatedPostIds = [];
  const failedSlots = [];
  const usedScriptIds = campaignScriptUsage(campaign.campaign_id);
  const batchSourceSetIds = new Set();

  for (const slot of eligibleSlots) {
    try {
      validateAccountVisualBanks(campaign.account_id, slot.language);
      const postId = `post-${slot.slot_id}`;
      const generation = generateSlideshows({
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
      const postFolder = path.resolve(ROOT, generatedPost.post_folder);
      const generatedMetadata = readJson(path.join(postFolder, 'metadata.json'), 'Generated post metadata.json');
      attachCampaignMetadata(postFolder, campaign, slot);
      if (generatedMetadata.master_script_id) usedScriptIds.add(generatedMetadata.master_script_id);
      if (generatedMetadata.topic_id) batchSourceSetIds.add(generatedMetadata.topic_id);
      slot.post_id = generatedPost.post_id;
      slot.status = 'generated';
      delete slot.failure_reason;
      writeJsonAtomic(planPath, plan);
      generatedPostIds.push(generatedPost.post_id);
    } catch (error) {
      const reason = failureReason(error);
      slot.status = 'failed';
      slot.failure_reason = reason;
      writeJsonAtomic(planPath, plan);
      failedSlots.push({ slot_id: slot.slot_id, reason });
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
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(CAMPAIGNS_DIR, `${campaign.campaign_id}-execution.json`), summary);
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
  retryBufferNotificationPost,
  sendUploadedCampaignPostsToBuffer,
  uploadApprovedCampaignPosts,
};
