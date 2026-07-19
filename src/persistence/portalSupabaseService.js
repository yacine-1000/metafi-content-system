'use strict';

// Server-side portal projection for the private hosted-V1 data graph.
const crypto = require('crypto');
const { createPersistenceRepository } = require('./index');
const { createServerSupabaseClient } = require('./serverSupabaseClient');
const { buildPlan } = require('../campaigns/campaignPlanner');

const ASSET_BUCKET = 'metafi-content-assets';
const SIGNED_URL_TTL_SECONDS = 300;

function legacyAccount(row) {
  if (!row) return null;
  return { ...row, account_id: row.legacy_account_id };
}
function legacyCampaign(row, account) {
  if (!row) return null;
  return { ...row, campaign_id: row.legacy_campaign_id, account_id: account?.legacy_account_id || row.account_id,
    account_internal_name: account?.internal_name, account_username: account?.username, account_language: account?.language, account_timezone: account?.timezone };
}
function accountInput(input = {}) {
  const now = new Date().toISOString();
  const accountId = input.account_id || `account_${crypto.randomBytes(12).toString('hex')}`;
  const value = {
    account_id: accountId, internal_name: input.internal_name, display_name: input.display_name, username: input.username,
    avatar_path: input.avatar_path || '', platform: input.platform || 'tiktok', country: input.country || '', language: input.language,
    gender: input.gender || 'male', timezone: input.timezone, buffer_organization_id: input.buffer_organization_id || '',
    buffer_channel_id: input.buffer_channel_id || '', buffer_channel_name: input.buffer_channel_name || '',
    connection_status: input.connection_status || (input.buffer_channel_id ? 'connected' : 'manual_only'), active: input.active == null ? true : input.active,
    created_at: input.created_at || now, updated_at: now,
  };
  for (const field of ['internal_name', 'display_name', 'username', 'language', 'timezone']) if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`${field} is required`);
  if (!['ar', 'en', 'es', 'fr', 'zh'].includes(value.language)) throw new Error('language is invalid');
  if (!['male', 'female'].includes(value.gender) || !['connected', 'manual_only'].includes(value.connection_status) || typeof value.active !== 'boolean') throw new Error('Account configuration is invalid');
  if (value.connection_status === 'connected' && !value.buffer_channel_id) throw new Error('buffer_channel_id is required for connected accounts');
  if (value.connection_status === 'manual_only' && value.buffer_channel_id) throw new Error('manual_only accounts cannot have buffer_channel_id');
  return value;
}

class PortalSupabaseService {
  constructor(env = process.env) { this.client = createServerSupabaseClient(env); this.repository = createPersistenceRepository({ env, client: this.client }); }
  async signed(asset) {
    if (!asset || asset.storage_provider !== 'supabase_storage' || !asset.storage_key) return null;
    const { data, error } = await this.client.storage.from(asset.storage_bucket || asset.bucket || ASSET_BUCKET).createSignedUrl(asset.storage_key, SIGNED_URL_TTL_SECONDS);
    if (error) throw new Error(`Unable to sign asset ${asset.storage_key}: ${error.message}`);
    return data.signedUrl;
  }
  async enrichAccount(row) {
    const account = legacyAccount(row); const assets = await this.repository.listAccountAssets(account.account_id);
    const hook = assets.filter((a) => a.asset_type === 'hook' && a.active);
    const ctas = assets.filter((a) => a.asset_type === 'localized_cta' && a.active);
    const profile = assets.find((a) => a.asset_type === 'profile' && a.active);
    const map = async (asset) => ({ filename: asset.storage_key.split('/').pop(), url: await this.signed(asset), asset_id: asset.id });
    const app_cta_banks = Object.fromEntries(await Promise.all(['ar','en','es','fr'].map(async (language) => {
      const images = await Promise.all(ctas.filter((a) => a.language === language).map(map)); return [language, { image_count: images.length, images }];
    })));
    return { ...account, avatar_url: profile ? await this.signed(profile) : null, hook_image_count: hook.length, hook_images: await Promise.all(hook.map(map)), app_cta_banks };
  }
  async listAccounts() { return Promise.all((await this.repository.listAccounts()).map((row) => this.enrichAccount(row))); }
  async getAccount(id) { const row = await this.repository.getAccount(id); return row ? this.enrichAccount(row) : null; }
  async createAccount(input) { const saved = await this.repository.upsertAccount(accountInput(input)); return this.enrichAccount(saved); }
  async updateAccount(id, changes) { const existing = await this.getAccount(id); if (!existing) return null; const saved = await this.repository.upsertAccount(accountInput({ ...existing, ...changes, account_id: id, created_at: existing.created_at })); return this.enrichAccount(saved); }
  async globalAssets() { const assets = await this.repository.listContentAssets(); return Promise.all(assets.filter((a) => a.active).map(async (a) => ({ ...a, url: await this.signed(a) }))); }
  async uploadAccountAsset(accountId, assetType, language, buffer, mimeType, filename) {
    const account = await this.getAccount(accountId); if (!account) return null;
    const clean = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = assetType === 'profile' ? `accounts/${accountId}/profile/${clean}` : assetType === 'hook' ? `accounts/${accountId}/hooks/${clean}` : `accounts/${accountId}/cta/${language}/${clean}`;
    const { error } = await this.client.storage.from(ASSET_BUCKET).upload(key, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`Unable to upload account asset: ${error.message}`);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const saved = await this.repository.upsertAccountAsset({ account_id: accountId, asset_type: assetType, language, storage_provider: 'supabase_storage', storage_bucket: ASSET_BUCKET, storage_key: key, content_type: mimeType, byte_size: buffer.length, checksum_sha256: checksum, active: true });
    return { ...saved, url: await this.signed(saved) };
  }
  async listCampaigns() { const rows = await this.repository.listCampaigns(); const accounts = new Map((await this.repository.listAccounts()).map((a) => [a.id, a])); return rows.map((r) => legacyCampaign(r, accounts.get(r.account_id))); }
  async getCampaign(id) { const row = await this.repository.getCampaign(id); if (!row) return null; const accounts = new Map((await this.repository.listAccounts()).map((a) => [a.id, a])); return legacyCampaign(row, accounts.get(row.account_id)); }
  async createCampaign(input) {
    const account = await this.getAccount(input.account_id); if (!account || !account.active) throw new Error('Campaign account does not exist or is inactive');
    if (!input.name || !input.objective || !input.start_date || !Number.isInteger(input.duration_days) || input.duration_days <= 0 || !Number.isInteger(input.posts_per_day) || input.posts_per_day <= 0 || !Array.isArray(input.pillars) || !Array.isArray(input.hook_types)) throw new Error('Campaign configuration is invalid');
    const campaign_id = input.campaign_id || `campaign-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
    const campaign = { ...input, campaign_id, account_id: account.account_id, language: input.language || account.language, timezone: input.timezone || account.timezone, publishing_mode: input.publishing_mode || 'mobile_finish', status: 'draft', account_internal_name: account.internal_name, account_username: account.username, account_language: account.language, account_timezone: account.timezone, buffer_channel_id: account.buffer_channel_id };
    const plan = buildPlan(campaign); await this.repository.upsertCampaign(campaign); await this.repository.upsertCampaignSlots(campaign_id, plan.slots, account.account_id); return campaign;
  }
}
module.exports = { PortalSupabaseService, ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, legacyAccount, legacyCampaign };
