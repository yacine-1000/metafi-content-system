'use strict';

const { ScriptLibraryWriteError } = require('./scriptLibraryWriteService');
const { InjectionRequestStoreError } = require('./injectionRequestStore');
const { InjectionCampaignRequestError, createInjectionCampaignRequestService } = require('./injectionCampaignRequestService');
const { ApprovedTaxonomyError } = require('./approvedTaxonomyService');

function createInjectionHandlers(options = {}) {
  const { writeService, taxonomyService, requestStore, getCampaign, listCampaigns } = options;
  if (!writeService) throw new Error('writeService is required');
  const campaignRequests = requestStore && getCampaign
    ? createInjectionCampaignRequestService({ writeService, requestStore, getCampaign })
    : null;
  const respond = (res, error) => {
    if (error instanceof ScriptLibraryWriteError || error instanceof InjectionRequestStoreError || error instanceof InjectionCampaignRequestError || error instanceof ApprovedTaxonomyError) return res.status(400).json({ error: error.message });
    console.error(`[injection] request failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to process Injection request' });
  };
  return {
    async taxonomy(_req, res) {
      try { return res.json(await (taxonomyService || writeService).getTaxonomy()); } catch (error) { return respond(res, error); }
    },
    sourceSets(req, res) {
      try { return res.json(writeService.listRecentSourceSets(req.query && req.query.limit)); } catch (error) { return respond(res, error); }
    },
    availableSourceSets(_req, res) {
      try { return res.json(writeService.listSourceSets()); } catch (error) { return respond(res, error); }
    },
    createSourceSet(req, res) {
      try {
        const sourceSet = writeService.createSourceSet(req.body);
        return res.status(201).json({ source_set: sourceSet });
      } catch (error) { return respond(res, error); }
    },
    activeCampaigns(_req, res) {
      try { return res.json((listCampaigns ? listCampaigns() : []).filter((campaign) => campaign.status === 'active')); } catch (error) { return respond(res, error); }
    },
    requests(_req, res) {
      if (!campaignRequests) return res.status(500).json({ error: 'Injection request store is unavailable' });
      try { return res.json(campaignRequests.list().slice().reverse()); } catch (error) { return respond(res, error); }
    },
    createCampaignRequest(req, res) {
      if (!campaignRequests) return res.status(500).json({ error: 'Injection request store is unavailable' });
      try { return res.status(201).json({ request: campaignRequests.create(req.body) }); } catch (error) { return respond(res, error); }
    },
  };
}

module.exports = { createInjectionHandlers };
