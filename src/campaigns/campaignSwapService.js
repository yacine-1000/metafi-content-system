'use strict';

const fs = require('fs');
const path = require('path');

const { getCampaign } = require('./campaignService');
const { updateCampaignSlotAtomically } = require('./campaignExecutor');
const { generateSlideshows } = require('../generation/generateSlideshows');

const ROOT = path.resolve(__dirname, '../..');

class CampaignSwapError extends Error {}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new CampaignSwapError(`${label} is invalid: ${error.message}`); }
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function postDirectory(root, postId) {
  if (typeof postId !== 'string' || !/^post-[A-Za-z0-9_-]+$/.test(postId)) throw new CampaignSwapError('Slot has an invalid post ID');
  return path.join(root, 'outputs', 'posts', postId);
}

function isPublished(metadata) {
  return Boolean(metadata.publication) || (metadata.statuses && metadata.statuses.publish === 'published');
}

function isBufferScheduled(metadata) {
  const value = metadata.buffer_status || (metadata.statuses && metadata.statuses.buffer);
  return ['scheduled', 'notification_scheduled', 'buffered'].includes(value);
}

function validateReplacement(slot, current, replacement) {
  for (const field of ['language', 'pillar_id', 'hook_type']) {
    if (replacement[field] !== current[field] || replacement[field] !== slot[field]) {
      throw new CampaignSwapError(`Replacement does not preserve slot ${field}`);
    }
  }
  if (replacement.master_script_id === current.master_script_id) throw new CampaignSwapError('Replacement selected the current script');
  if (!replacement.master_script_id || !replacement.topic_id) throw new CampaignSwapError('Replacement is missing script identity');
}

function swapCampaignPost(campaignId, slotId, options = {}) {
  const root = options.root || ROOT;
  const readCampaign = options.getCampaign || getCampaign;
  const generate = options.generateSlideshows || generateSlideshows;
  const now = options.now || (() => new Date());
  const campaign = readCampaign(campaignId);
  if (!campaign) return null;
  const planPath = path.join(root, 'data', 'campaigns', `${campaignId}-plan.json`);
  const plan = readJson(planPath, 'Campaign plan');
  const slot = Array.isArray(plan.slots) && plan.slots.find((item) => item && item.slot_id === slotId);
  if (!slot || !slot.post_id) throw new CampaignSwapError('Only a generated campaign slot can be swapped');
  const oldPostDir = postDirectory(root, slot.post_id);
  const current = readJson(path.join(oldPostDir, 'metadata.json'), 'Current post metadata.json');
  if (current.campaign_id !== campaignId || current.slot_id !== slotId || current.account_id !== campaign.account_id) {
    throw new CampaignSwapError('Post identity does not match the selected campaign slot');
  }
  if (!current.master_script_id || !current.topic_id) throw new CampaignSwapError('Current post is missing script identity');
  if (isPublished(current)) throw new CampaignSwapError('Published posts cannot be swapped');
  if (isBufferScheduled(current)) throw new CampaignSwapError('Buffer-scheduled posts cannot be swapped');
  if (!current.statuses || current.statuses.generation !== 'completed') throw new CampaignSwapError('Only generated posts can be swapped');

  const rejected = Array.isArray(slot.rejected_script_ids) ? slot.rejected_script_ids.filter((id) => typeof id === 'string') : [];
  const exclusions = Array.from(new Set([current.master_script_id, ...rejected]));
  const generated = generate({
    pillar: slot.pillar_id,
    hook: slot.hook_type,
    languages: [slot.language],
    accountId: campaign.account_id,
    excludedScriptIds: exclusions,
  });
  const replacementInfo = generated && Array.isArray(generated.posts) && generated.posts[0];
  if (!replacementInfo || !replacementInfo.post_id || !replacementInfo.post_folder) {
    throw new CampaignSwapError('Replacement generation did not return a post');
  }
  if (replacementInfo.post_id === current.post_id) throw new CampaignSwapError('Replacement generation reused the current post');
  const replacementDir = path.resolve(root, replacementInfo.post_folder);
  if (path.dirname(replacementDir) !== path.resolve(root, 'outputs', 'posts')) throw new CampaignSwapError('Replacement output path is invalid');
  const replacementPath = path.join(replacementDir, 'metadata.json');
  const replacement = readJson(replacementPath, 'Replacement post metadata.json');
  validateReplacement(slot, current, replacement);
  if (rejected.includes(replacement.master_script_id)) throw new CampaignSwapError('Replacement selected a script rejected for this slot');
  if (!fs.existsSync(path.join(replacementDir, 'publish-package-resolved.json')) || !fs.existsSync(path.join(replacementDir, 'rendered'))) {
    throw new CampaignSwapError('Replacement did not finish resolving and rendering');
  }

  replacement.campaign_id = campaign.campaign_id;
  replacement.slot_id = slot.slot_id;
  replacement.account_id = campaign.account_id;
  replacement.buffer_channel_id = campaign.buffer_channel_id || '';
  replacement.account_internal_name = campaign.account_internal_name;
  replacement.account_username = campaign.account_username;
  replacement.account_language = campaign.account_language;
  replacement.account_timezone = campaign.account_timezone;
  replacement.publishing_mode = slot.publishing_mode || campaign.publishing_mode || 'mobile_finish';
  replacement.campaign_objective = campaign.objective;
  replacement.updated_at = now().toISOString();
  writeJsonAtomic(replacementPath, replacement);

  const swappedAt = now().toISOString();
  const result = updateCampaignSlotAtomically(campaignId, slotId, (liveSlot) => {
    if (liveSlot.post_id !== current.post_id) return false;
    liveSlot.post_id = replacement.post_id;
    liveSlot.status = 'generated';
    liveSlot.rejected_script_ids = Array.from(new Set([...(Array.isArray(liveSlot.rejected_script_ids) ? liveSlot.rejected_script_ids : []), current.master_script_id]));
    liveSlot.replacement_history = [...(Array.isArray(liveSlot.replacement_history) ? liveSlot.replacement_history : []), {
      replaced_post_id: current.post_id,
      replacement_post_id: replacement.post_id,
      swapped_at: swappedAt,
    }];
    return { post_id: replacement.post_id, replaced_post_id: current.post_id, slot_id: slotId };
  }, { root, now: new Date(swappedAt) });
  if (!result) throw new CampaignSwapError('Campaign slot changed during replacement; the original slot was left unchanged');
  return result;
}

module.exports = { CampaignSwapError, swapCampaignPost };
