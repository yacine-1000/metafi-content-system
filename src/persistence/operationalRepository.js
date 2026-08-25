'use strict';

// Async operational-state boundary. Local implementations preserve the existing
// JSON layout; Supabase implementations never consult those files.
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { createPersistenceRepository } = require('./index');
const { mutatePlan, claimCampaignSlot, completeClaimedSlot } = require('../campaigns/campaignSlotLockStore');
const { getCoolingScriptIds, SCRIPT_ROTATION_CONFIG } = require('../publication/publicationService');

const ROOT = path.resolve(__dirname, '../..');
const campaignFile = (root, id) => path.join(root, 'data', 'campaigns', `${id}.json`);
const planFile = (root, id) => path.join(root, 'data', 'campaigns', `${id}-plan.json`);
const executionFile = (root, id) => path.join(root, 'data', 'campaigns', `${id}-execution.json`);
async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.rename(tmp, file); }
function writeSync(file, value) { const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; fsSync.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8'); for (let attempt = 0; attempt < 20; attempt += 1) { try { fsSync.renameSync(tmp, file); return; } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 19) { try { fsSync.unlinkSync(tmp); } catch {} throw error; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } } }

class LocalOperationalRepository {
  constructor({ root = ROOT } = {}) { this.mode = 'local'; this.root = root; }
  async getCampaign(id) { return json(campaignFile(this.root, id)); }
  async saveCampaign(campaign) { await write(campaignFile(this.root, campaign.campaign_id), campaign); return campaign; }
  async getSlots(id) { return (await json(planFile(this.root, id)))?.slots || []; }
  async saveSlots(id, slots, context = {}) { const prior = await json(planFile(this.root, id)) || {}; await write(planFile(this.root, id), { ...prior, ...context, campaign_id: id, slots }); return slots; }
  async getExecution(id) { return json(executionFile(this.root, id)); }
  async saveExecution(id, summary) { await write(executionFile(this.root, id), summary); return summary; }
  async saveJob(job) { return job; }
  async savePost(post) {
    const relative = post.local_path || path.join('outputs', 'posts', post.post_id);
    const folder = path.resolve(this.root, relative); const postsRoot = path.resolve(this.root, 'outputs', 'posts');
    if (folder !== postsRoot && !folder.startsWith(`${postsRoot}${path.sep}`)) throw new Error('Post local_path must be inside outputs/posts');
    await write(path.join(folder, 'metadata.json'), post); return post;
  }
  async listEligibleSlots(campaignId, window = {}) {
    const file = planFile(this.root, campaignId); const plan = await json(file);
    if (!plan) { const missing = []; missing.planExists = false; missing.totalCount = 0; missing.windowCount = 0; return missing; }
    if (plan.campaign_id !== campaignId || !Array.isArray(plan.slots)) throw new Error('Campaign plan has an invalid structure');
    let slots = plan.slots;
    let locked = true;
    if (window.context) {
      const mutation = mutatePlan(file, new Date(), 30000, (latest) => {
        Object.assign(latest, window.context); latest.slots.forEach((slot) => Object.assign(slot, window.context));
        writeSync(file, latest); return latest.slots;
      });
      locked = mutation.locked;
      if (mutation.locked) slots = mutation.value;
    }
    const inWindow = slots.filter((s) => (!window.start || s.date >= window.start) && (!window.end || s.date <= window.end));
    const eligible = inWindow.filter((s) => ['planned', 'failed'].includes(s.status) && !s.post_id);
    eligible.planExists = true; eligible.totalCount = slots.length; eligible.windowCount = inWindow.length; eligible.locked = locked; return eligible;
  }
  async claimEligibleSlot(campaignId, slotId, now, leaseMs) { return claimCampaignSlot(planFile(this.root, campaignId), slotId, { now: new Date(now), leaseMs, planLockLeaseMs: 30000, isEligible: (s) => ['planned', 'failed'].includes(s.status) && !s.post_id }) || null; }
  async finalizeClaimedSlot(campaignId, slotId, claimId, mutation) { let row = null; const ok = completeClaimedSlot(planFile(this.root, campaignId), slotId, claimId, { now: new Date(), planLockLeaseMs: 30000, onComplete: (s) => { for (const [key, value] of Object.entries(mutation)) { if (value == null) delete s[key]; else s[key] = value; } row = { ...s }; } }); return ok ? row : null; }
  async createGenerationJob(job) { const id = job.job_id || job.jobId; if (!id) throw new Error('job_id is required'); await write(path.join(this.root, 'outputs', 'jobs', id, 'manifest.json'), job); return job; }
  async updateGenerationJob(id, mutation) { const file = path.join(this.root, 'outputs', 'jobs', id, 'manifest.json'); const prior = await json(file); if (!prior) return null; const next = { ...prior, ...mutation, job_id: id }; await write(file, next); return next; }
  async saveExecutionSummary(id, summary) { return this.saveExecution(id, summary); }
  async getExecutionSummary(id) { return this.getExecution(id); }
  async getCoolingScriptIds(accountId, options = {}) {
    const ids = getCoolingScriptIds(accountId, { ...options, root: this.root });
    if (!options.campaignId) return ids;
    const directory = path.join(this.root, 'outputs', 'posts'); let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) { if (!entry.isDirectory()) continue; const post = await json(path.join(directory, entry.name, 'metadata.json')); if (post?.campaign_id === options.campaignId && post.master_script_id) ids.add(post.master_script_id); }
    return ids;
  }
}
class SupabaseOperationalRepository {
  constructor(repository) { this.mode = 'supabase'; this.repository = repository; this.jobs = new Map(); }
  async getCampaign(id) {
    const campaign = await this.repository.getCampaign(id); if (!campaign) return null;
    const { data: account, error } = await this.repository.client.from('accounts').select('*').eq('id', campaign.account_id).single();
    if (error) throw new Error(`Unable to load campaign account: ${error.message}`);
    const assets = await this.repository.listAccountAssets(account.legacy_account_id);
    const signedAssets = await Promise.all(assets.filter((asset) => asset.active && ['hook', 'localized_cta'].includes(asset.asset_type)).map(async (asset) => {
      if (asset.public_url) return asset;
      const bucket = asset.storage_bucket || asset.bucket;
      const { data, error: signedError } = await this.repository.client.storage.from(bucket).createSignedUrl(asset.storage_key, 300);
      if (signedError) throw new Error(`Unable to sign campaign account asset: ${signedError.message}`);
      return { ...asset, signed_url: data.signedUrl };
    }));
    return { ...campaign, campaign_id: campaign.legacy_campaign_id, account_id: account.legacy_account_id, account: { ...account, account_id: account.legacy_account_id, assets: signedAssets }, buffer_channel_id: account.buffer_channel_id,
      account_internal_name: account.internal_name, account_username: account.username, account_language: account.language, account_timezone: account.timezone };
  }
  async saveCampaign(campaign) { return this.repository.upsertCampaign(campaign); }
  async getSlots(id) { return this.repository.listCampaignSlots(id); }
  async listEligibleSlots(campaignId, window) {
    const id = await this.repository.campaignId(campaignId);
    const rows = await this.repository.response(this.repository.client.from('campaign_slots').select('*').eq('campaign_id', id).order('scheduled_at'), 'Unable to list eligible slots');
    const inWindow = rows.filter((slot) => (!window?.start || slot.scheduled_date >= window.start) && (!window?.end || slot.scheduled_date <= window.end));
    const now = window?.now instanceof Date ? window.now : new Date(window?.now || Date.now());
    const eligible = inWindow.filter((slot) => ['planned', 'failed'].includes(slot.status)
      || (slot.status === 'generating' && slot.claim_expires_at && new Date(slot.claim_expires_at) <= now)).map((slot) => ({ ...slot, slot_id: slot.legacy_slot_id,
      date: slot.scheduled_date, time: slot.scheduled_time }));
    eligible.planExists = true; eligible.totalCount = rows.length; eligible.windowCount = inWindow.length; eligible.locked = true; return eligible;
  }
  async claimEligibleSlot(campaignId, slotId, now, leaseMs) {
    const campaign = await this.repository.campaignId(campaignId); const slot = await this.repository.slotId(slotId);
    const claimId = require('crypto').randomUUID(); const expires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const { data, error } = await this.repository.client.rpc('claim_campaign_slot', { p_campaign_id: campaign, p_slot_id: slot, p_claim_id: claimId, p_now: new Date(now).toISOString(), p_lease_expires_at: expires });
    if (error) throw new Error(`Unable to claim campaign slot: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data; return row ? { slot: row, claim: { claim_id: claimId, claimed_at: new Date(now).toISOString(), lease_expires_at: expires, attempt_count: row.attempt_count } } : null;
  }
  async finalizeClaimedSlot(campaignId, slotId, claimId, mutation) {
    const campaign = await this.repository.campaignId(campaignId); const slot = await this.repository.slotId(slotId);
    const { data, error } = await this.repository.client.rpc('finalize_campaign_slot', { p_campaign_id: campaign, p_slot_id: slot, p_claim_id: claimId, p_status: mutation.status, p_failure_code: mutation.failure_code || null, p_failure_reason: mutation.failure_reason || null });
    if (error) throw new Error(`Unable to finalize campaign slot: ${error.message}`);
    return Array.isArray(data) ? data[0] || null : data || null;
  }
  async saveSlots(id, slots, fallbackAccountId) { return this.repository.upsertCampaignSlots(id, slots, fallbackAccountId); }
  async createGenerationJob(job) { this.jobs.set(job.job_id || job.jobId, { ...job }); return this.repository.upsertGenerationJob(job); }
  async updateGenerationJob(jobId, mutation) { const job = { ...(this.jobs.get(jobId) || {}), ...mutation, job_id: jobId }; this.jobs.set(jobId, job); return this.repository.upsertGenerationJob(job); }
  async getExecutionSummary(campaignId) { const id = await this.repository.campaignId(campaignId); const { data, error } = await this.repository.client.from('campaign_execution_summaries').select('summary').eq('campaign_id', id).maybeSingle(); if (error) throw new Error(error.message); return data?.summary || null; }
  async saveExecutionSummary(campaignId, summary) { const id = await this.repository.campaignId(campaignId); const { data, error } = await this.repository.client.from('campaign_execution_summaries').upsert({ campaign_id: id, summary }, { onConflict: 'campaign_id' }).select('summary').single(); if (error) throw new Error(error.message); return data.summary; }
  async getExecution(id) { return this.getExecutionSummary(id); }
  async saveExecution(id, summary) { return this.saveExecutionSummary(id, summary); }
  async saveJob(job) { return this.createGenerationJob(job); }
  async savePost(post) { return this.repository.upsertPost(post); }
  async getCoolingScriptIds(accountId, { now = new Date(), cooldownMs = SCRIPT_ROTATION_CONFIG.cooldown_ms, campaignId = null } = {}) {
    const account = await this.repository.accountId(accountId); const cutoff = new Date(now.getTime() - cooldownMs).toISOString();
    const { data, error } = await this.repository.client.from('publication_history').select('script_id,published_at').eq('account_id', account).gt('published_at', cutoff).not('script_id', 'is', null);
    if (error) throw new Error(`Unable to read cooling publications: ${error.message}`);
    const ids = new Set(data.map((row) => row.script_id).filter(Boolean));
    if (campaignId) { const campaign = await this.repository.campaignId(campaignId); const posts = await this.repository.response(this.repository.client.from('posts').select('master_script_id').eq('campaign_id', campaign).not('master_script_id', 'is', null), 'Unable to read campaign script usage'); posts.forEach((post) => ids.add(post.master_script_id)); }
    return ids;
  }
}
function createOperationalRepository(options = {}) { const repository = options.repository || createPersistenceRepository(options); return repository.mode === 'supabase' ? new SupabaseOperationalRepository(repository) : new LocalOperationalRepository(options); }
module.exports = { LocalOperationalRepository, SupabaseOperationalRepository, createOperationalRepository };
