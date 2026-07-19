'use strict';

const crypto = require('crypto');
const { ScriptLibraryWriteError } = require('./scriptLibraryWriteService');
const { InjectionRequestStoreError } = require('./injectionRequestStore');

class InjectionCampaignRequestError extends Error {}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function campaignEndDate(campaign) {
  const start = new Date(`${campaign.start_date}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + campaign.duration_days - 1);
  return start.toISOString().slice(0, 10);
}

function createInjectionCampaignRequestService({ writeService, requestStore, getCampaign }) {
  if (!writeService || !requestStore || !getCampaign) throw new Error('writeService, requestStore, and getCampaign are required');
  function create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InjectionCampaignRequestError('Request body must be an object');
    const sourceSetId = input.source_set_id;
    const campaignId = input.campaign_id;
    try {
      if (!writeService.getSourceSet(sourceSetId)) throw new InjectionCampaignRequestError(`Source set does not exist: ${sourceSetId}`);
    } catch (error) {
      if (error instanceof InjectionCampaignRequestError) throw error;
      if (error instanceof ScriptLibraryWriteError) throw new InjectionCampaignRequestError(error.message);
      throw error;
    }
    const campaign = getCampaign(campaignId);
    if (!campaign) throw new InjectionCampaignRequestError(`Campaign does not exist: ${campaignId}`);
    if (campaign.status !== 'active') throw new InjectionCampaignRequestError(`Campaign is not active: ${campaignId}`);
    if (!campaign.account_id) throw new InjectionCampaignRequestError(`Campaign has no account: ${campaignId}`);
    const targetDate = input.target_date == null || input.target_date === '' ? null : input.target_date;
    if (targetDate != null) {
      if (!validDate(targetDate)) throw new InjectionCampaignRequestError('target_date must be a valid YYYY-MM-DD date');
      if (targetDate < campaign.start_date || targetDate > campaignEndDate(campaign)) throw new InjectionCampaignRequestError('target_date must be inside the campaign dates');
    }
    if (requestStore.list().some((request) => request.status === 'pending' && request.source_set_id === sourceSetId && request.campaign_id === campaignId)) {
      throw new InjectionCampaignRequestError('A pending request already exists for this source set and campaign');
    }
    try {
      return requestStore.save({
        injection_id: `INJ-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        source_set_id: sourceSetId,
        campaign_id: campaignId,
        account_id: campaign.account_id,
        status: 'pending',
        priority: 'normal',
        requested_at: new Date().toISOString(),
        target_date: targetDate,
        consumed_by_slot_id: null,
      });
    } catch (error) {
      if (error instanceof InjectionRequestStoreError) throw new InjectionCampaignRequestError(error.message);
      throw error;
    }
  }
  return { create, list: () => requestStore.list() };
}

module.exports = { InjectionCampaignRequestError, createInjectionCampaignRequestService };
