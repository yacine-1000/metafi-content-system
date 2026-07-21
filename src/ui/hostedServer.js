'use strict';

const express = require('express');
const path = require('path');
const { PortalSupabaseService, QuickSaveOutputError } = require('../persistence/portalSupabaseService');

const app = express();
const IMAGE_TYPES = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
]);

function portal() { return new PortalSupabaseService(process.env); }
function quickSaveError(res, error, fallback) {
  if (error instanceof QuickSaveOutputError) return res.status(error.code === 'QUICK_SAVE_ACCESS_DENIED' ? 403 : 409).json({ error: error.message, reason_code: error.code });
  console.error(`[hosted-portal] ${fallback}: ${error.message}`);
  return res.status(500).json({ error: fallback });
}

app.use(express.json());

app.get('/api/health', async (_req, res) => {
  try { return res.json(await portal().health()); }
  catch (error) {
    console.error(`[health] dependency check failed: ${error.message}`);
    return res.status(503).json({ status: 'degraded', persistence_mode: 'supabase', database: 'unreachable', checked_at: new Date().toISOString() });
  }
});

app.get('/api/team/campaigns', async (_req, res) => {
  try { return res.json(await portal().teamCampaigns()); }
  catch (error) { console.error(`[team] campaign list failed: ${error.message}`); return res.status(500).json({ error: 'Unable to load team campaigns' }); }
});
app.get('/api/team/campaigns/:campaignId', async (req, res) => {
  try { const data = await portal().teamCampaign(req.params.campaignId); return data ? res.json(data) : res.status(404).json({ error: 'Campaign not found' }); }
  catch (error) { return quickSaveError(res, error, 'Unable to load team campaign'); }
});
app.post('/api/team/campaigns/:campaignId/posts/:postId/mark-posted', async (req, res) => {
  try { const data = await portal().markTeamPostPosted(req.params.campaignId, req.params.postId); return data ? res.status(data.existing ? 200 : 201).json(data) : res.status(404).json({ error: 'Campaign post not found' }); }
  catch (error) { return quickSaveError(res, error, 'Unable to mark team post as posted'); }
});

app.get('/api/accounts', async (_req, res) => {
  try { return res.json(await portal().listAccounts()); }
  catch (error) { console.error(`[accounts] list failed: ${error.message}`); return res.status(500).json({ error: 'Unable to list accounts' }); }
});
app.get('/api/accounts/:accountId', async (req, res) => {
  try { const account = await portal().getAccount(req.params.accountId); return account ? res.json(account) : res.status(404).json({ error: 'Account not found' }); }
  catch (error) { console.error(`[accounts] read failed: ${error.message}`); return res.status(500).json({ error: 'Unable to load account' }); }
});
app.post('/api/accounts', async (req, res) => {
  try { return res.status(201).json(await portal().createAccount(req.body)); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.patch('/api/accounts/:accountId', async (req, res) => {
  try { const account = await portal().updateAccount(req.params.accountId, req.body); return account ? res.json(account) : res.status(404).json({ error: 'Account not found' }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});

function imageUpload(assetType, languageFromRequest = false) {
  return [express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '10mb' }), async (req, res) => {
    try {
      const mimeType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      const extension = IMAGE_TYPES.get(mimeType);
      if (!extension || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(415).json({ error: 'Image must be JPG, PNG, or WEBP' });
      const language = languageFromRequest ? String(req.params.language || '').toLowerCase() : null;
      if (languageFromRequest && !['ar', 'en', 'es', 'fr'].includes(language)) return res.status(400).json({ error: 'App CTA language must be ar, en, es, or fr' });
      const filename = `${assetType}-${Date.now()}-${process.hrtime.bigint()}.${extension}`;
      const asset = await portal().uploadAccountAsset(req.params.accountId, assetType, language, req.body, mimeType, filename);
      if (!asset) return res.status(404).json({ error: 'Account not found' });
      return res.status(201).json({ account_id: req.params.accountId, language, uploaded_files: [{ filename, url: asset.url }], rejected_files: [], image_count: 1, images: [{ filename, url: asset.url }] });
    } catch (error) { console.error(`[accounts] asset upload failed: ${error.message}`); return res.status(500).json({ error: 'Unable to upload account asset' }); }
  }];
}
app.post('/api/accounts/:accountId/avatar', ...imageUpload('profile'));
app.post('/api/accounts/:accountId/hook-images', ...imageUpload('hook'));
app.post('/api/accounts/:accountId/app-cta-images/:language', ...imageUpload('localized_cta', true));

app.get('/api/campaigns', async (_req, res) => {
  try { return res.json(await portal().listCampaigns()); }
  catch (error) { console.error(`[campaigns] list failed: ${error.message}`); return res.status(500).json({ error: 'Unable to list campaigns' }); }
});
app.get('/api/campaigns/:campaignId', async (req, res) => {
  try { const campaign = await portal().getCampaign(req.params.campaignId); return campaign ? res.json(campaign) : res.status(404).json({ error: 'Campaign not found' }); }
  catch (error) { console.error(`[campaigns] read failed: ${error.message}`); return res.status(500).json({ error: 'Unable to load campaign' }); }
});
app.post('/api/campaigns', async (req, res) => {
  try { return res.status(201).json(await portal().createCampaign(req.body)); }
  catch (error) { console.error(`[campaigns] creation failed: ${error.message}`); return res.status(400).json({ error: error.message }); }
});
app.patch('/api/campaigns/:campaignId', async (req, res) => {
  try { const campaign = await portal().updateCampaign(req.params.campaignId, req.body || {}); return campaign ? res.json(campaign) : res.status(404).json({ error: 'Campaign not found' }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.delete('/api/campaigns/:campaignId', async (req, res) => {
  try { const campaign = await portal().deleteCampaign(req.params.campaignId); return campaign ? res.json({ campaign_id: req.params.campaignId, status: 'deleted' }) : res.status(404).json({ error: 'Campaign not found' }); }
  catch (error) { console.error(`[campaigns] deletion failed: ${error.message}`); return res.status(500).json({ error: 'Unable to delete campaign' }); }
});

app.get('/api/campaigns/:campaignId/quick-save', async (req, res) => {
  try { const data = await portal().quickSaveData(req.params.campaignId); return data ? res.json(data) : res.status(404).json({ error: 'Campaign not found' }); }
  catch (error) { return quickSaveError(res, error, 'Unable to load Quick Save'); }
});
app.post('/api/campaigns/:campaignId/posts/:postId/mark-saved', async (req, res) => {
  try { const data = await portal().setQuickSaveSaved(req.params.campaignId, req.params.postId, req.body?.saved !== false); return data ? res.json(data) : res.status(404).json({ error: 'Campaign post not found' }); }
  catch (error) { return quickSaveError(res, error, 'Unable to update Quick Save state'); }
});
app.get('/api/campaigns/:campaignId/posts/:postId/slides.zip', async (req, res) => {
  try { const url = await portal().quickSaveZipUrl(req.params.campaignId, req.params.postId); return url ? res.redirect(302, url) : res.status(404).json({ error: 'Campaign post not found' }); }
  catch (error) { return quickSaveError(res, error, 'Unable to download Quick Save package'); }
});
app.post('/api/posts/:postId/mark-posted', async (req, res) => {
  try { const data = await portal().markQuickSavePosted(req.params.postId, req.body || {}); return data ? res.status(data.existing ? 200 : 201).json(data) : res.status(404).json({ error: 'Post not found' }); }
  catch (error) { return quickSaveError(res, error, 'Unable to confirm publication'); }
});

app.all('/api/*', (_req, res) => res.status(503).json({ error: 'This action requires the separate Metafi rendering/publication worker', reason_code: 'WORKER_NOT_DEPLOYED' }));
app.get(['/team', '/team/campaign/:campaignId'], (_req, res) => res.sendFile(path.join(__dirname, 'team.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.all('*', (_req, res) => res.status(503).json({ error: 'This action requires the separate Metafi rendering/publication worker', reason_code: 'WORKER_NOT_DEPLOYED' }));

module.exports = { app };
