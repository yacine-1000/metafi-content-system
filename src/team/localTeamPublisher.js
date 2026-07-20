'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const { createServerSupabaseClient } = require('../persistence/serverSupabaseClient');
const { SupabaseRepository } = require('../persistence/supabaseRepository');
const { renderedOutputBasePath } = require('../generation/renderedOutputStorage');

class TeamPublishError extends Error {
  constructor(message, code = 'TEAM_PUBLISH_FAILED') { super(message); this.name = 'TeamPublishError'; this.code = code; }
}

function teamEnvironment(root, env = process.env) {
  const values = { ...env, METAFI_PERSISTENCE_MODE: 'supabase' };
  const filename = path.join(root, '.env.supabase.local');
  if (fs.existsSync(filename)) {
    const local = dotenv.parse(fs.readFileSync(filename));
    for (const [name, value] of Object.entries(local)) if (value || values[name] == null) values[name] = value;
  }
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET']) {
    if (!String(values[name] || '').trim()) throw new TeamPublishError(`${name} is required to publish to the team portal`, 'TEAM_PUBLISH_CONFIGURATION_MISSING');
  }
  return values;
}

function readJson(filename, label) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new TeamPublishError(`${label} is missing or invalid`, 'TEAM_PUBLISH_LOCAL_POST_INVALID'); }
}

function checksum(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

async function uploadVerified(storage, key, buffer) {
  const expected = checksum(buffer);
  const uploaded = await storage.upload(key, buffer, { contentType: 'image/png', upsert: true, cacheControl: '3600' });
  if (uploaded.error) throw new TeamPublishError(`Unable to upload ${key}: ${uploaded.error.message}`);
  const verified = await storage.download(key);
  if (verified.error) throw new TeamPublishError(`Unable to verify ${key}: ${verified.error.message}`);
  const downloaded = Buffer.from(await verified.data.arrayBuffer());
  if (downloaded.length !== buffer.length || checksum(downloaded) !== expected) throw new TeamPublishError(`Upload verification failed for ${key}`);
  return { storage_key: key, content_type: 'image/png', byte_size: buffer.length, checksum_sha256: expected };
}

function localGraph(root, campaignId, postId) {
  const campaign = readJson(path.join(root, 'data', 'campaigns', `${campaignId}.json`), 'Campaign');
  const plan = readJson(path.join(root, 'data', 'campaigns', `${campaignId}-plan.json`), 'Campaign plan');
  const slot = (plan.slots || []).find((item) => item.post_id === postId);
  if (!slot || slot.campaign_id && slot.campaign_id !== campaignId) throw new TeamPublishError('Post is not linked to this campaign slot', 'TEAM_PUBLISH_LINKAGE_INVALID');
  const postFolder = path.join(root, 'outputs', 'posts', postId);
  const metadata = readJson(path.join(postFolder, 'metadata.json'), 'Post metadata');
  const publishPackage = readJson(path.join(postFolder, 'publish-package.json'), 'Publish package');
  if (metadata.campaign_id !== campaignId || metadata.slot_id !== slot.slot_id || metadata.account_id !== campaign.account_id) throw new TeamPublishError('Local post linkage is invalid', 'TEAM_PUBLISH_LINKAGE_INVALID');
  if (metadata.statuses?.generation !== 'completed') throw new TeamPublishError('Post generation is not complete', 'TEAM_PUBLISH_NOT_READY');
  const renderedFolder = path.join(postFolder, 'rendered');
  const rendered = fs.existsSync(renderedFolder) ? fs.readdirSync(renderedFolder)
    .filter((name) => /^slide-\d+\.png$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  if (!rendered.length) throw new TeamPublishError('Completed rendered slides are missing', 'TEAM_PUBLISH_NOT_READY');
  const account = readJson(path.join(root, 'data', 'accounts', `${campaign.account_id}.json`), 'Campaign account');
  return { account, campaign, slot, metadata, publishPackage, postFolder, rendered };
}

class LocalTeamPublisher {
  constructor({ root = path.resolve(__dirname, '../..'), env = process.env, client, repository } = {}) {
    this.root = root; this.env = teamEnvironment(root, env);
    this.client = client || createServerSupabaseClient(this.env);
    this.repository = repository || new SupabaseRepository(this.client);
    this.bucket = this.env.SUPABASE_STORAGE_BUCKET;
  }

  async publishPost(campaignId, postId) {
    const graph = localGraph(this.root, campaignId, postId); const { account, campaign, slot, metadata, publishPackage } = graph;
    await this.repository.upsertAccount(account);
    await this.repository.upsertCampaign({ ...campaign, publishing_mode: 'mobile_finish' });
    await this.repository.upsertCampaignSlots(campaignId, [{ ...slot, publishing_mode: 'mobile_finish' }], campaign.account_id);
    const jobId = `job-${slot.slot_id}`;
    await this.repository.upsertGenerationJob({ job_id: jobId, account_id: campaign.account_id, campaign_id: campaignId, slot_id: slot.slot_id,
      state: 'uploading', attempt_count: slot.attempt_count || 1, started_at: metadata.created_at });
    try {
      const basePath = renderedOutputBasePath({ campaignId, slotId: slot.slot_id, postId, language: metadata.language });
      const storage = this.client.storage.from(this.bucket);
      const slides = await Promise.all(graph.rendered.map(async (filename, index) => {
        const buffer = fs.readFileSync(path.join(graph.postFolder, 'rendered', filename));
        const outputName = `slide-${String(index + 1).padStart(2, '0')}.png`;
        return { order: index + 1, filename: outputName, ...(await uploadVerified(storage, `${basePath}/slides/${outputName}`, buffer)) };
      }));
      const now = new Date().toISOString();
      const renderedOutput = { version: 1, status: 'complete', storage_provider: 'supabase_storage', bucket: this.bucket, base_path: basePath,
        campaign_id: campaignId, slot_id: slot.slot_id, post_id: postId, language: metadata.language, generated_at: metadata.updated_at || metadata.created_at,
        uploaded_at: now, slide_count: slides.length, slides };
      const existing = await this.repository.response(this.client.from('posts').select('*').eq('legacy_post_id', postId).maybeSingle(), 'Unable to read existing team post');
      await this.repository.upsertPost({ ...metadata, post_id: postId, job_id: jobId, campaign_id: campaignId, slot_id: slot.slot_id,
        account_id: campaign.account_id, publishing_mode: 'mobile_finish', caption: publishPackage.caption || '', publish_package: publishPackage,
        statuses: { ...(metadata.statuses || {}), publish: existing?.publication_status || 'not_published' }, saved_at: existing?.saved_at || null,
        buffer_status: existing?.buffer_status || metadata.buffer_status, buffer_post_id: existing?.buffer_post_id || null,
        asset_manifest: { ...(existing?.asset_manifest || {}), ...(metadata.assets || {}), ...(metadata.asset_manifest || {}), rendered_output: renderedOutput }, local_path: null });
      await this.repository.upsertGenerationJob({ job_id: jobId, account_id: campaign.account_id, campaign_id: campaignId, slot_id: slot.slot_id,
        state: 'completed', attempt_count: slot.attempt_count || 1, started_at: metadata.created_at, completed_at: now });
      return { campaign_id: campaignId, slot_id: slot.slot_id, post_id: postId, state: 'published', uploaded_slide_count: slides.length, rendered_output: renderedOutput };
    } catch (error) {
      try { await this.repository.upsertGenerationJob({ job_id: jobId, account_id: campaign.account_id, campaign_id: campaignId, slot_id: slot.slot_id,
        state: 'failed', attempt_count: slot.attempt_count || 1, started_at: metadata.created_at, completed_at: new Date().toISOString(), error_code: error.code || 'TEAM_PUBLISH_FAILED', error_message: error.message }); } catch {}
      throw error;
    }
  }

  async publishReady(campaignId) {
    const plan = readJson(path.join(this.root, 'data', 'campaigns', `${campaignId}-plan.json`), 'Campaign plan');
    const postIds = (plan.slots || []).filter((slot) => slot.post_id).map((slot) => slot.post_id); const results = [];
    for (const postId of postIds) {
      try { results.push(await this.publishPost(campaignId, postId)); }
      catch (error) { results.push({ campaign_id: campaignId, post_id: postId, state: 'failed', error: error.message, reason_code: error.code || 'TEAM_PUBLISH_FAILED' }); }
    }
    return { campaign_id: campaignId, published_count: results.filter((item) => item.state === 'published').length,
      failed_count: results.filter((item) => item.state === 'failed').length, results };
  }

  async status(campaignId) {
    const plan = readJson(path.join(this.root, 'data', 'campaigns', `${campaignId}-plan.json`), 'Campaign plan');
    const ids = (plan.slots || []).filter((slot) => slot.post_id).map((slot) => slot.post_id);
    if (!ids.length) return { campaign_id: campaignId, posts: [] };
    const rows = await this.repository.response(this.client.from('posts').select('legacy_post_id,asset_manifest').in('legacy_post_id', ids), 'Unable to read team publish status');
    const byId = new Map(rows.map((row) => [row.legacy_post_id, row]));
    return { campaign_id: campaignId, posts: ids.map((postId) => {
      const output = byId.get(postId)?.asset_manifest?.rendered_output;
      const published = output?.status === 'complete' && Array.isArray(output.slides) && output.slides.length > 0;
      return { post_id: postId, state: published ? 'published' : 'not_published' };
    }) };
  }
}

module.exports = { LocalTeamPublisher, TeamPublishError, localGraph, teamEnvironment, uploadVerified };
