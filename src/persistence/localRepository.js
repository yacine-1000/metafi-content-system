'use strict';

// The local adapter intentionally delegates to the existing JSON services.
// It is the default mode and makes no database calls.
const accounts = require('../accounts/accountService');
const campaigns = require('../campaigns/campaignService');
const { readPublicationHistory } = require('../publication/publicationService');

class LocalRepository {
  constructor({ root } = {}) { this.root = root; this.mode = 'local'; }

  async listAccounts() { return accounts.listAccounts(); }
  async getAccount(legacyAccountId) { return accounts.getAccount(legacyAccountId); }
  async createAccount(input) { return accounts.createAccount(input); }
  async updateAccount(legacyAccountId, changes) { return accounts.updateAccount(legacyAccountId, changes); }

  async listCampaigns() { return campaigns.listCampaigns(); }
  async getCampaign(legacyCampaignId) { return campaigns.getCampaign(legacyCampaignId); }
  async createCampaign(input) { return campaigns.createCampaign(input); }
  async updateCampaign(legacyCampaignId, changes) { return campaigns.updateCampaign(legacyCampaignId, changes); }
  async deleteCampaign(legacyCampaignId) { return campaigns.deleteCampaign(legacyCampaignId); }

  async listPublicationHistory() { return readPublicationHistory({ root: this.root }).publications; }

  // These methods are intentionally no-ops in local mode. Existing filesystem
  // writers remain the source of truth until an operator selects supabase mode.
  async upsertAccount(input) { return { mode: this.mode, record: input, skipped: true }; }
  async upsertCampaign(input) { return { mode: this.mode, record: input, skipped: true }; }
  async upsertCampaignSlots(input) { return { mode: this.mode, records: input, skipped: true }; }
  async upsertPost(input) { return { mode: this.mode, record: input, skipped: true }; }
  async upsertGenerationJob(input) { return { mode: this.mode, record: input, skipped: true }; }
  async upsertPublication(input) { return { mode: this.mode, record: input, skipped: true }; }
  async upsertAccountAsset(input) { return { mode: this.mode, record: input, skipped: true }; }
}

module.exports = { LocalRepository };
