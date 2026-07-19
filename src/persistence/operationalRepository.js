'use strict';

// Async operational-state boundary. Local implementations preserve the existing
// JSON layout; Supabase implementations never consult those files.
const fs = require('fs/promises');
const path = require('path');
const { createPersistenceRepository } = require('./index');
const { claimCampaignSlot, completeClaimedSlot } = require('../campaigns/campaignExecutor');

const ROOT = path.resolve(__dirname, '../..');
const campaignFile = (root, id) => path.join(root, 'data', 'campaigns', `${id}.json`);
const planFile = (root, id) => path.join(root, 'data', 'campaigns', `${id}-plan.json`);
const executionFile = (root, id) => path.join(root, 'data', 'campaigns', `${id}-execution.json`);
async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.rename(tmp, file); }

class LocalOperationalRepository {
  constructor({ root = ROOT } = {}) { this.mode = 'local'; this.root = root; }
  async getCampaign(id) { return json(campaignFile(this.root, id)); }
  async saveCampaign(campaign) { await write(campaignFile(this.root, campaign.campaign_id), campaign); return campaign; }
  async getSlots(id) { return (await json(planFile(this.root, id)))?.slots || []; }
  async saveSlots(id, slots, context = {}) { const prior = await json(planFile(this.root, id)) || {}; await write(planFile(this.root, id), { ...prior, ...context, campaign_id: id, slots }); return slots; }
  async getExecution(id) { return json(executionFile(this.root, id)); }
  async saveExecution(id, summary) { await write(executionFile(this.root, id), summary); return summary; }
  async saveJob(job) { return job; }
  async savePost(post) { return post; }
  async listEligibleSlots(campaignId, window = {}) { return (await this.getSlots(campaignId)).filter((s) => ['planned', 'failed'].includes(s.status) && (!window.start || s.date >= window.start) && (!window.end || s.date <= window.end)); }
  async claimEligibleSlot(campaignId, slotId, now, leaseMs) { return claimCampaignSlot(planFile(this.root, campaignId), slotId, { now: new Date(now), leaseMs, planLockLeaseMs: 30000, isEligible: (s) => ['planned', 'failed'].includes(s.status) }) || null; }
  async finalizeClaimedSlot(campaignId, slotId, claimId, mutation) { let row = null; const ok = completeClaimedSlot(planFile(this.root, campaignId), slotId, claimId, { now: new Date(), planLockLeaseMs: 30000, onComplete: (s) => { Object.assign(s, mutation); row = { ...s }; } }); return ok ? row : null; }
  async createGenerationJob(job) { const id = job.job_id || job.jobId; if (!id) throw new Error('job_id is required'); await write(path.join(this.root, 'outputs', 'jobs', id, 'manifest.json'), job); return job; }
  async updateGenerationJob(id, mutation) { const file = path.join(this.root, 'outputs', 'jobs', id, 'manifest.json'); const prior = await json(file); if (!prior) return null; const next = { ...prior, ...mutation, job_id: id }; await write(file, next); return next; }
  async saveExecutionSummary(id, summary) { return this.saveExecution(id, summary); }
  async getExecutionSummary(id) { return this.getExecution(id); }
}
class SupabaseOperationalRepository {
  constructor(repository) { this.mode = 'supabase'; this.repository = repository; }
  async getCampaign(id) { return this.repository.getCampaign(id); }
  async saveCampaign(campaign) { return this.repository.upsertCampaign(campaign); }
  async getSlots(id) { return this.repository.listCampaignSlots(id); }
  async listEligibleSlots(campaignId, window) {
    const id = await this.repository.campaignId(campaignId);
    let query = this.repository.client.from('campaign_slots').select('*').eq('campaign_id', id).in('status', ['planned', 'failed']).order('scheduled_at');
    if (window?.start) query = query.gte('scheduled_date', window.start);
    if (window?.end) query = query.lte('scheduled_date', window.end);
    return this.repository.response(query, 'Unable to list eligible slots');
  }
  async claimEligibleSlot(campaignId, slotId, now, leaseMs) {
    const campaign = await this.repository.campaignId(campaignId); const slot = await this.repository.slotId(slotId);
    const claimId = require('crypto').randomUUID(); const expires = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const { data, error } = await this.repository.client.rpc('claim_campaign_slot', { p_campaign_id: campaign, p_slot_id: slot, p_claim_id: claimId, p_now: new Date(now).toISOString(), p_lease_expires_at: expires });
    if (error) throw new Error(`Unable to claim campaign slot: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data; return row ? { slot: row, claim: { claim_id: claimId, lease_expires_at: expires } } : null;
  }
  async finalizeClaimedSlot(campaignId, slotId, claimId, mutation) {
    const campaign = await this.repository.campaignId(campaignId); const slot = await this.repository.slotId(slotId);
    const { data, error } = await this.repository.client.rpc('finalize_campaign_slot', { p_campaign_id: campaign, p_slot_id: slot, p_claim_id: claimId, p_status: mutation.status, p_failure_code: mutation.failure_code || null, p_failure_reason: mutation.failure_reason || null });
    if (error) throw new Error(`Unable to finalize campaign slot: ${error.message}`);
    return Array.isArray(data) ? data[0] || null : data || null;
  }
  async saveSlots(id, slots, fallbackAccountId) { return this.repository.upsertCampaignSlots(id, slots, fallbackAccountId); }
  async createGenerationJob(job) { return this.repository.upsertGenerationJob(job); }
  async updateGenerationJob(jobId, mutation) { return this.repository.upsertGenerationJob({ ...mutation, job_id: jobId }); }
  async getExecutionSummary(campaignId) { const id = await this.repository.campaignId(campaignId); const { data, error } = await this.repository.client.from('campaign_execution_summaries').select('summary').eq('campaign_id', id).maybeSingle(); if (error) throw new Error(error.message); return data?.summary || null; }
  async saveExecutionSummary(campaignId, summary) { const id = await this.repository.campaignId(campaignId); const { data, error } = await this.repository.client.from('campaign_execution_summaries').upsert({ campaign_id: id, summary }, { onConflict: 'campaign_id' }).select('summary').single(); if (error) throw new Error(error.message); return data.summary; }
  async getExecution(id) { return this.getExecutionSummary(id); }
  async saveExecution(id, summary) { return this.saveExecutionSummary(id, summary); }
  async saveJob(job) { return this.createGenerationJob(job); }
  async savePost(post) { return this.repository.upsertPost(post); }
}
function createOperationalRepository(options = {}) { const repository = options.repository || createPersistenceRepository(options); return repository.mode === 'supabase' ? new SupabaseOperationalRepository(repository) : new LocalOperationalRepository(); }
module.exports = { LocalOperationalRepository, SupabaseOperationalRepository, createOperationalRepository };
