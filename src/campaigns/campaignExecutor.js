'use strict';

const fs = require('fs');
const path = require('path');

const { getCampaign, resolveCampaignAccount } = require('./campaignService');
const { generateSlideshows } = require('../generation/generateSlideshows');
const { uploadPostToR2 } = require('../generation/uploadToR2');
const { createBufferDraft } = require('../generation/createBufferDraft');
const { scheduleBufferPost } = require('../generation/scheduleBufferPost');
const { validateAccountVisualBanks } = require('../generation/resolvePostAssets');
const { createInjectionRequestStore } = require('../injection/injectionRequestStore');
const { getSourceSet } = require('../scripts/scriptLibrary');
const { mutatePlan, claimCampaignSlot, completeClaimedSlot } = require('./campaignSlotLockStore');
const { createOperationalRepository } = require('../persistence/operationalRepository');
const { createRenderedOutputStorage } = require('../generation/renderedOutputStorage');

const ROOT = path.resolve(__dirname, '../..');
const CAMPAIGNS_DIR = path.join(ROOT, 'data', 'campaigns');
const POSTS_DIR = path.join(ROOT, 'outputs', 'posts');
const PILLAR_NAMES = Object.freeze({
  p1: 'Changed Week / What Should I Train Today?',
  p2: 'Hybrid Athlete / Sport + Gym Balance',
  p3: 'Workout Programming / Exercise Selection',
  p4: 'Body Transformation / Aesthetic Progress',
});

const CAMPAIGN_EXECUTION_CONFIG = Object.freeze({
  execution_window_days: 3,
  slot_claim_lease_ms: 15 * 60 * 1000,
  plan_lock_lease_ms: 30 * 1000,
});

class CampaignExecutionError extends Error {
  constructor(message, code = 'CAMPAIGN_EXECUTION_ERROR', details = {}) {
    super(message);
    this.name = 'CampaignExecutionError';
    this.code = code;
    this.details = details;
  }
}

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

function updateCampaignSlotAtomically(campaignId, slotId, update, options = {}) {
  const root = options.root || ROOT;
  const planPath = path.join(root, 'data', 'campaigns', `${campaignId}-plan.json`);
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

function localDateInTimezone(timezone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(date, offset) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + offset));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function campaignEndDate(campaign) {
  return addCalendarDays(campaign.start_date, campaign.duration_days - 1);
}

function noWorkSummary(campaign, executionWindowDays, windowStart, windowEnd, code, reason, now, skippedCount = 0) {
  return {
    campaign_id: campaign.campaign_id,
    outcome: 'no_work',
    reason_code: code,
    reason,
    execution_window_days: executionWindowDays,
    window_start: windowStart,
    window_end: windowEnd,
    generated_count: 0,
    skipped_count: skippedCount,
    skipped_claimed_count: 0,
    failed_count: 0,
    generated_post_ids: [],
    failed_slots: [],
    updated_at: now.toISOString(),
  };
}

function failureReason(error) {
  const message = error && error.message ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000) || 'Campaign slot generation failed';
}

function compatibleInjectionRequest(requestStore, sourceSetFor, campaign, slot, now, publicationRoot, coolingOverride = null) {
  if (slot.language !== 'ar') return null;
  const cooling = coolingOverride || new Set();
  for (const request of requestStore.list()) {
    if (!request || request.status !== 'pending' || request.campaign_id !== campaign.campaign_id || request.account_id !== campaign.account_id) continue;
    if (request.target_date && request.target_date !== slot.date) continue;
    let sourceSet;
    try { sourceSet = sourceSetFor(request.source_set_id); } catch { continue; }
    if (!sourceSet || sourceSet.pillar !== PILLAR_NAMES[slot.pillar_id] || !Array.isArray(sourceSet.scripts)) continue;
    const compatible = sourceSet.scripts.some((script) => script && !cooling.has(script.script_id)
      && (String(script.hook_type).toLowerCase() === String(slot.hook_type).toLowerCase()
        || String(script.format).toLowerCase() === String(slot.hook_type).toLowerCase()));
    if (compatible) return request;
  }
  return null;
}

async function executeCampaignWindow(campaignId, options = {}) {
  const executionStartedAt = Date.now();
  const logStage = (stage, event, startedAt = executionStartedAt, details = '') => console.error(`[campaign-generation] ${new Date().toISOString()} campaign_id=${campaignId} stage=${stage} event=${event} elapsed_ms=${Date.now() - startedAt}${details ? ` ${details}` : ''}`);
  logStage('execute_campaign_window', 'start');
  const root = options.root || ROOT;
  const operationalRepository = options.operationalRepository || createOperationalRepository({
    root,
    env: options.env || process.env,
    client: options.client,
    repository: options.repository,
  });
  const readCampaign = options.getCampaign || ((id) => operationalRepository.getCampaign(id));
  const generate = options.generateSlideshows || generateSlideshows;
  const validateVisualBanks = options.validateAccountVisualBanks || validateAccountVisualBanks;
  const injectionRequestStore = options.injectionRequestStore || createInjectionRequestStore({ filePath: path.join(root, 'data', 'injection-requests.json') });
  const sourceSetFor = options.getSourceSet || getSourceSet;
  const renderedOutputStorage = operationalRepository.mode === 'supabase'
    ? (options.renderedOutputStorage || createRenderedOutputStorage({
      client: operationalRepository.repository.client,
      root,
      bucket: options.rendered_output_bucket || process.env.METAFI_RENDERED_OUTPUT_BUCKET,
    }))
    : null;
  const nowFor = options.now || (() => new Date());
  const campaignLoadStartedAt = Date.now();
  const campaign = await readCampaign(campaignId);
  logStage('campaign_load', 'complete', campaignLoadStartedAt);
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

  const expectedSlots = campaign.duration_days * campaign.posts_per_day;
  if (expectedSlots <= 0) {
    throw new CampaignExecutionError('Posts per day is zero; update campaign cadence before generating.', 'POSTS_PER_DAY_ZERO', { posts_per_day: campaign.posts_per_day });
  }
  const accountFields = {
    account_id: campaign.account_id,
    buffer_channel_id: campaign.buffer_channel_id,
    account_internal_name: campaign.account_internal_name,
    account_username: campaign.account_username,
    account_language: campaign.account_language,
    account_timezone: campaign.account_timezone,
  };
  const windowStart = localDateInTimezone(campaign.timezone, nowFor());
  const windowEnd = addCalendarDays(windowStart, executionWindowDays - 1);
  const eligibleSlots = await operationalRepository.listEligibleSlots(campaign.campaign_id, {
    start: windowStart,
    end: windowEnd,
    context: accountFields,
  });
  if (eligibleSlots.planExists === false) {
    const details = operationalRepository.mode === 'local'
      ? { plan_path: path.join(root, 'data', 'campaigns', `${campaign.campaign_id}-plan.json`) }
      : {};
    throw new CampaignExecutionError('No campaign plan exists. Activate or plan the campaign before generating.', 'PLAN_FILE_MISSING', details);
  }
  if (eligibleSlots.totalCount === 0) {
    const details = { expected_slots: expectedSlots };
    if (operationalRepository.mode === 'local') details.plan_path = path.join(root, 'data', 'campaigns', `${campaign.campaign_id}-plan.json`);
    throw new CampaignExecutionError('Campaign plan contains zero slots. Re-plan the campaign before generating.', 'PLAN_ZERO_SLOTS', details);
  }
  if (eligibleSlots.locked === false) return {
    campaign_id: campaign.campaign_id,
    execution_window_days: executionWindowDays,
    window_start: windowStart,
    window_end: windowEnd,
    generated_count: 0,
    failed_count: 0,
    skipped_claimed_count: 0,
    generated_post_ids: [],
    failed_slots: [],
    updated_at: nowFor().toISOString(),
  };
  const eligibleSlotIds = eligibleSlots.map((slot) => slot.slot_id || slot.legacy_slot_id);
  if (eligibleSlotIds.length === 0) {
    const ended = campaignEndDate(campaign) < windowStart;
    const slotsInWindowCount = eligibleSlots.windowCount || 0;
    const code = ended ? 'CAMPAIGN_ENDED' : slotsInWindowCount ? 'NO_ELIGIBLE_SLOTS' : 'NO_SLOTS_CURRENT_WINDOW';
    const reason = ended
      ? 'Campaign dates ended; there are no slots to generate.'
      : slotsInWindowCount
        ? 'No eligible slots in the current three-day window; existing slots are already processed or claimed.'
        : 'No slots in the current three-day window.';
    const summary = noWorkSummary(
      campaign,
      executionWindowDays,
      windowStart,
      windowEnd,
      code,
      reason,
      nowFor(),
      slotsInWindowCount,
    );
    await operationalRepository.saveExecutionSummary(campaign.campaign_id, summary);
    return operationalRepository.getExecutionSummary(campaign.campaign_id);
  }
  const generatedPostIds = [];
  const failedSlots = [];
  let skippedClaimedCount = 0;
  const batchSourceSetIds = new Set();
  const publicationHistoryStartedAt = Date.now();
  const executionCoolingScriptIds = await operationalRepository.getCoolingScriptIds(campaign.account_id, {
    now: nowFor(),
    campaignId: campaign.campaign_id,
  });
  const usedScriptIds = new Set(executionCoolingScriptIds);
  logStage('publication_history_loading', 'complete', publicationHistoryStartedAt, `cooling_script_count=${executionCoolingScriptIds.size}`);

  for (const slotId of eligibleSlotIds) {
    const slotStartedAt = Date.now();
    const claimResult = await operationalRepository.claimEligibleSlot(campaign.campaign_id, slotId, nowFor(), slotClaimLeaseMs);
    if (!claimResult) {
      logStage('slot_claim', 'skipped', slotStartedAt, `slot_id=${slotId}`);
      skippedClaimedCount += 1;
      continue;
    }
    const { slot, claim } = claimResult;
    const normalizedSlot = {
      ...slot,
      slot_id: slot.slot_id || slot.legacy_slot_id || slotId,
      date: slot.date || slot.scheduled_date,
      time: slot.time || slot.scheduled_time,
    };
    logStage('slot_claim', 'complete', slotStartedAt, `slot_id=${slotId} claim_id=${claim.claim_id}`);
    let claimedInjection = null;
    const jobId = `job-${normalizedSlot.slot_id}`;
    try {
      await operationalRepository.createGenerationJob({
        job_id: jobId,
        account_id: campaign.account_id,
        campaign_id: campaign.campaign_id,
        slot_id: normalizedSlot.slot_id,
        state: 'claimed',
        attempt_count: normalizedSlot.attempt_count || claim.attempt_count || 1,
        claim_token: claim.claim_id,
        claimed_at: claim.claimed_at || nowFor().toISOString(),
        claim_expires_at: claim.lease_expires_at,
        started_at: nowFor().toISOString(),
      });
      const accountLookupStartedAt = Date.now();
      await validateVisualBanks(campaign.account_id, normalizedSlot.language, normalizedSlot.hook_type);
      logStage('account_lookup', 'complete', accountLookupStartedAt, `slot_id=${normalizedSlot.slot_id}`);
      const injectionLookupStartedAt = Date.now();
      const pendingInjection = compatibleInjectionRequest(injectionRequestStore, sourceSetFor, campaign, normalizedSlot, nowFor(), root, executionCoolingScriptIds);
      logStage('injection_request_lookup', 'complete', injectionLookupStartedAt, `slot_id=${normalizedSlot.slot_id} matched=${Boolean(pendingInjection)}`);
      if (pendingInjection) claimedInjection = injectionRequestStore.claim(pendingInjection.injection_id, normalizedSlot.slot_id);
      const postId = `post-${normalizedSlot.slot_id}`;
      await operationalRepository.updateGenerationJob(jobId, { state: 'rendering' });
      const generation = await generate({
        pillar: normalizedSlot.pillar_id,
        hook: normalizedSlot.hook_type,
        languages: [normalizedSlot.language],
        postId,
        usedScriptIds: [...usedScriptIds],
        avoidedSourceSetIds: [...batchSourceSetIds],
        accountId: campaign.account_id,
        coolingScriptIds: executionCoolingScriptIds,
        ...(claimedInjection ? { requiredSourceSetId: claimedInjection.source_set_id } : {}),
      });
      logStage('slideshow_generation', 'complete', slotStartedAt, `slot_id=${normalizedSlot.slot_id}`);
      if (!generation.posts || generation.posts.length !== 1) {
        throw new Error('Generation did not return exactly one post');
      }
      const generatedPost = generation.posts[0];
      const renderResult = generatedPost.render_result;
      if (!renderResult || !renderResult.metadata) throw new Error('Generation did not return structured render metadata');
      let renderedOutput = null;
      if (renderedOutputStorage) {
        await operationalRepository.updateGenerationJob(jobId, { state: 'uploading' });
        renderedOutput = await renderedOutputStorage.persist({
          campaignId: campaign.campaign_id,
          slotId: normalizedSlot.slot_id,
          postId: generatedPost.post_id || renderResult.post_id,
          language: renderResult.language || normalizedSlot.language,
          postFolder: generatedPost.post_folder || renderResult.post_folder,
          renderedFiles: generatedPost.rendered_files || renderResult.slide_files || [],
          generatedAt: renderResult.metadata.updated_at || renderResult.metadata.created_at || nowFor().toISOString(),
        });
      }
      const persistedPost = {
        ...renderResult.metadata,
        post_id: generatedPost.post_id || renderResult.post_id,
        job_id: jobId,
        campaign_id: campaign.campaign_id,
        slot_id: normalizedSlot.slot_id,
        account_id: campaign.account_id,
        buffer_channel_id: campaign.buffer_channel_id,
        account_internal_name: campaign.account_internal_name,
        account_username: campaign.account_username,
        account_language: campaign.account_language,
        account_timezone: campaign.account_timezone,
        language: renderResult.language || normalizedSlot.language,
        pillar_id: renderResult.pillar_id || normalizedSlot.pillar_id,
        hook_type: renderResult.hook_type || normalizedSlot.hook_type,
        caption: renderResult.caption || '',
        publish_package: renderResult.publish_package || {},
        asset_manifest: renderedOutput
          ? { ...(renderResult.metadata.assets || {}), ...(renderResult.metadata.asset_manifest || {}), rendered_output: renderedOutput }
          : renderResult.metadata.asset_manifest,
        local_path: renderedOutput ? null : (generatedPost.post_folder || renderResult.post_folder),
        publishing_mode: normalizedSlot.publishing_mode || campaign.publishing_mode || 'mobile_finish',
        updated_at: nowFor().toISOString(),
      };
      await operationalRepository.savePost(persistedPost);
      if (renderedOutput) await renderedOutputStorage.cleanupTemporary(generatedPost.post_folder || renderResult.post_folder);
      if (persistedPost.master_script_id) usedScriptIds.add(persistedPost.master_script_id);
      if (persistedPost.topic_id) batchSourceSetIds.add(persistedPost.topic_id);
      const finalized = await operationalRepository.finalizeClaimedSlot(campaign.campaign_id, normalizedSlot.slot_id, claim.claim_id, {
        post_id: persistedPost.post_id,
        status: 'generated',
        failure_reason: null,
        failure_code: null,
      });
      if (finalized) {
        await operationalRepository.updateGenerationJob(jobId, { state: 'completed', completed_at: nowFor().toISOString() });
        logStage('campaign_plan_finalization', 'complete', slotStartedAt, `slot_id=${normalizedSlot.slot_id}`);
        if (claimedInjection && !injectionRequestStore.consume(claimedInjection.injection_id, normalizedSlot.slot_id)) {
          throw new CampaignExecutionError('Injection request could not be marked consumed');
        }
        generatedPostIds.push(persistedPost.post_id);
      }
    } catch (error) {
      logStage('slot', 'failed', slotStartedAt, `slot_id=${normalizedSlot.slot_id} error=${JSON.stringify(failureReason(error))}`);
      const reason = failureReason(error);
      const reasonCode = error && typeof error.code === 'string' ? error.code : 'SLOT_GENERATION_FAILED';
      if (claimedInjection) injectionRequestStore.releaseFailure(claimedInjection.injection_id, normalizedSlot.slot_id, reason, nowFor().toISOString());
      try { await operationalRepository.updateGenerationJob(jobId, { state: 'failed', error_code: reasonCode, error_message: reason, completed_at: nowFor().toISOString() }); } catch {}
      const finalized = await operationalRepository.finalizeClaimedSlot(campaign.campaign_id, normalizedSlot.slot_id, claim.claim_id, {
        status: 'failed',
        failure_reason: reason,
        failure_code: reasonCode,
      });
      if (finalized) failedSlots.push({ slot_id: normalizedSlot.slot_id, reason, reason_code: reasonCode, retryable: true });
    }
  }

  const summary = {
    campaign_id: campaign.campaign_id,
    outcome: failedSlots.length ? 'completed_with_failures' : 'completed',
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
  await operationalRepository.saveExecutionSummary(campaign.campaign_id, summary);
  logStage('execute_campaign_window', 'complete', executionStartedAt, `generated=${generatedPostIds.length} failed=${failedSlots.length}`);
  return operationalRepository.getExecutionSummary(campaign.campaign_id);
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
  claimCampaignSlot,
  completeClaimedSlot,
  retryBufferNotificationPost,
  sendUploadedCampaignPostsToBuffer,
  uploadApprovedCampaignPosts,
};
