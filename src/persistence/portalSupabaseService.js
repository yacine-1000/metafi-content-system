'use strict';

// Server-side portal projection for the private hosted-V1 data graph.
const crypto = require('crypto');
const { createPersistenceRepository } = require('./index');
const { createServerSupabaseClient } = require('./serverSupabaseClient');
const { buildPlan } = require('../campaigns/campaignPlanner');
const { RenderedOutputStorage, renderedOutputBasePath } = require('../generation/renderedOutputStorage');

const ASSET_BUCKET = 'metafi-content-assets';
const SIGNED_URL_TTL_SECONDS = 300;

class QuickSaveOutputError extends Error {
  constructor(message, code = 'QUICK_SAVE_OUTPUT_MISSING') { super(message); this.name = 'QuickSaveOutputError'; this.code = code; }
}

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
  constructor(env = process.env, options = {}) {
    this.client = options.client || createServerSupabaseClient(env);
    this.repository = options.repository || createPersistenceRepository({ env, client: this.client });
    this.storageBucket = env.SUPABASE_STORAGE_BUCKET || ASSET_BUCKET;
    this.renderedOutputStorage = options.renderedOutputStorage || new RenderedOutputStorage(this.client, { bucket: this.storageBucket });
  }
  async signed(asset) {
    if (!asset || asset.storage_provider !== 'supabase_storage' || !asset.storage_key) return null;
    const { data, error } = await this.client.storage.from(asset.storage_bucket || asset.bucket || this.storageBucket).createSignedUrl(asset.storage_key, SIGNED_URL_TTL_SECONDS);
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
    const { error } = await this.client.storage.from(this.storageBucket).upload(key, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`Unable to upload account asset: ${error.message}`);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const saved = await this.repository.upsertAccountAsset({ account_id: accountId, asset_type: assetType, language, storage_provider: 'supabase_storage', storage_bucket: this.storageBucket, storage_key: key, content_type: mimeType, byte_size: buffer.length, checksum_sha256: checksum, active: true });
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
  async updateCampaign(id, changes = {}) {
    const existing = await this.getCampaign(id); if (!existing) return null;
    const saved = await this.repository.upsertCampaign({ ...existing, ...changes, campaign_id: id, account_id: existing.account_id });
    return legacyCampaign(saved, await this.repository.getAccount(existing.account_id));
  }
  async deleteCampaign(id) { return this.repository.deleteCampaign(id); }
  async health() {
    const database = await this.client.from('accounts').select('id').limit(1); if (database.error) throw new Error(`Unable to verify Supabase database: ${database.error.message}`);
    const bucket = await this.client.storage.getBucket(this.storageBucket);
    if (bucket.error) throw new Error(`Unable to verify Supabase Storage: ${bucket.error.message}`);
    return { status: 'ok', persistence_mode: 'supabase', database: 'reachable', storage: 'reachable', storage_bucket: this.storageBucket,
      storage_private: bucket.data.public === false, checked_at: new Date().toISOString() };
  }

  validatedRenderedOutput(campaign, slot, post) {
    if (!slot || slot.campaign_id !== campaign.id || slot.account_id !== campaign.account_id || post.campaign_slot_id !== slot.id || post.account_id !== campaign.account_id) {
      throw new QuickSaveOutputError('Post does not belong to the requested campaign and account', 'QUICK_SAVE_ACCESS_DENIED');
    }
    const output = post.asset_manifest?.rendered_output;
    if (!output || output.status !== 'complete' || output.storage_provider !== 'supabase_storage' || !Array.isArray(output.slides) || !output.zip) {
      throw new QuickSaveOutputError(`Rendered output metadata is missing for ${post.legacy_post_id}`);
    }
    const expectedBase = renderedOutputBasePath({ campaignId: campaign.legacy_campaign_id, slotId: slot.legacy_slot_id, postId: post.legacy_post_id, language: post.language });
    const expectedPrefix = `${expectedBase}/`; const slides = [...output.slides].sort((a, b) => a.order - b.order);
    const expectedBucket = this.renderedOutputStorage?.bucket;
    if (!expectedBucket || output.bucket !== expectedBucket || output.base_path !== expectedBase
      || slides.some((slide, index) => slide.order !== index + 1 || slide.storage_key !== `${expectedPrefix}slides/slide-${String(index + 1).padStart(2, '0')}.png`)
      || output.zip.storage_key !== `${expectedBase}/${post.legacy_post_id}-slides.zip`) {
      throw new QuickSaveOutputError('Rendered output metadata failed linkage validation', 'QUICK_SAVE_ACCESS_DENIED');
    }
    return { ...output, slides };
  }

  async quickSavePost(campaignId, postId) {
    const campaign = await this.repository.getCampaign(campaignId); if (!campaign) return null;
    const post = (await this.repository.listPosts(campaignId)).find((item) => item.legacy_post_id === postId); if (!post) return null;
    const slot = (await this.repository.listCampaignSlots(campaignId)).find((item) => item.id === post.campaign_slot_id);
    const output = this.validatedRenderedOutput(campaign, slot, post);
    return { campaign, slot, post, output };
  }

  async quickSaveData(campaignId) {
    const campaign = await this.repository.getCampaign(campaignId); if (!campaign) return null;
    const [account, slots, posts] = await Promise.all([
      this.repository.response(this.client.from('accounts').select('*').eq('id', campaign.account_id).single(), 'Unable to load campaign account'),
      this.repository.listCampaignSlots(campaignId),
      this.repository.listPosts(campaignId),
    ]);
    const slotById = new Map(slots.map((slot) => [slot.id, slot]));
    const ready = posts.filter((post) => post.generation_status === 'completed');
    const postIds = ready.map((post) => post.id); let publications = [];
    if (postIds.length) publications = await this.repository.response(this.client.from('publication_history').select('*').in('post_id', postIds), 'Unable to load Quick Save publications');
    const publicationByPost = new Map(publications.map((item) => [item.post_id, item]));
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();
    const values = [];
    for (const post of ready) {
      const slot = slotById.get(post.campaign_slot_id); const output = this.validatedRenderedOutput(campaign, slot, post);
      const previews = await this.renderedOutputStorage.signedPreviews(output, SIGNED_URL_TTL_SECONDS);
      const zipUrl = await this.renderedOutputStorage.signedZip(output, SIGNED_URL_TTL_SECONDS);
      const publicationRow = publicationByPost.get(post.id);
      const publication = publicationRow ? { status: publicationRow.status, method: publicationRow.method, published_at: publicationRow.published_at,
        confirmed_at: publicationRow.confirmed_at, external_url: publicationRow.external_url } : null;
      values.push({ post_id: post.legacy_post_id, slot_id: slot.legacy_slot_id, scheduled_date: slot.scheduled_date, scheduled_time: slot.scheduled_time,
        account_id: account.legacy_account_id, account_handle: account.username || account.internal_name || '', language: post.language, caption: post.caption || '',
        first_slide_text: post.publish_package?.slides?.[0]?.text || post.publish_package?.hook_text || '', saved_at: post.saved_at || null,
        saved: Boolean(post.saved_at), publication, publication_status: post.publication_status, slide_urls: previews.map((item) => item.signed_url),
        zip_url: zipUrl, signed_url_expires_at: expiresAt, rendered_slide_count: output.slides.length });
    }
    values.sort((a, b) => `${a.scheduled_date} ${a.scheduled_time}`.localeCompare(`${b.scheduled_date} ${b.scheduled_time}`));
    return { campaign_id: campaignId, posts: values };
  }

  async setQuickSaveSaved(campaignId, postId, saved = true) {
    const found = await this.quickSavePost(campaignId, postId); if (!found) return null;
    if (found.post.generation_status !== 'completed') throw new QuickSaveOutputError('Only generated posts can be saved', 'QUICK_SAVE_NOT_READY');
    const savedAt = saved ? (found.post.saved_at || new Date().toISOString()) : null;
    const { data, error } = await this.client.from('posts').update({ saved_at: savedAt }).eq('id', found.post.id).eq('campaign_id', found.campaign.id).eq('account_id', found.campaign.account_id).select('legacy_post_id,saved_at').single();
    if (error) throw new Error(`Unable to update Quick Save state: ${error.message}`);
    return { post_id: data.legacy_post_id, saved_at: data.saved_at, saved: Boolean(data.saved_at) };
  }

  async quickSaveZipUrl(campaignId, postId) {
    const found = await this.quickSavePost(campaignId, postId); if (!found) return null;
    return this.renderedOutputStorage.signedZip(found.output, SIGNED_URL_TTL_SECONDS);
  }

  async markQuickSavePosted(postId, input = {}) {
    const unsupported = Object.keys(input).filter((key) => !['published_at', 'external_url'].includes(key));
    if (unsupported.length) throw new QuickSaveOutputError(`Unsupported publication field: ${unsupported[0]}`, 'QUICK_SAVE_PUBLICATION_INVALID');
    const { data: post, error: postError } = await this.client.from('posts').select('*').eq('legacy_post_id', postId).maybeSingle();
    if (postError) throw new Error(`Unable to load Quick Save post: ${postError.message}`); if (!post) return null;
    const { data: campaign, error: campaignError } = await this.client.from('campaigns').select('*').eq('id', post.campaign_id).single();
    const { data: slot, error: slotError } = await this.client.from('campaign_slots').select('*').eq('id', post.campaign_slot_id).single();
    if (campaignError || slotError) throw new QuickSaveOutputError('Quick Save post linkage is invalid', 'QUICK_SAVE_ACCESS_DENIED');
    this.validatedRenderedOutput(campaign, slot, post);
    const { data: existing, error: existingError } = await this.client.from('publication_history').select('*').eq('post_id', post.id).maybeSingle();
    if (existingError) throw new Error(`Unable to read publication state: ${existingError.message}`);
    if (existing) return { publication: existing, existing: true };
    const publishedAt = input.published_at ? new Date(input.published_at) : new Date();
    if (Number.isNaN(publishedAt.getTime())) throw new QuickSaveOutputError('published_at is invalid', 'QUICK_SAVE_PUBLICATION_INVALID');
    let externalUrl = null;
    if (input.external_url) { try { externalUrl = new URL(input.external_url); } catch { throw new QuickSaveOutputError('external_url must be a valid HTTP(S) URL', 'QUICK_SAVE_PUBLICATION_INVALID'); }
      if (!['http:', 'https:'].includes(externalUrl.protocol)) throw new QuickSaveOutputError('external_url must be a valid HTTP(S) URL', 'QUICK_SAVE_PUBLICATION_INVALID'); }
    const now = new Date().toISOString();
    const { data: publication, error } = await this.client.from('publication_history').insert({ post_id: post.id, account_id: post.account_id,
      campaign_id: post.campaign_id, campaign_slot_id: post.campaign_slot_id, method: 'manual', status: 'published', published_at: publishedAt.toISOString(),
      confirmed_at: now, external_url: externalUrl?.toString() || null, script_id: post.master_script_id, source_set_id: post.topic_id }).select().single();
    if (error) throw new Error(`Unable to save publication state: ${error.message}`);
    const updated = await this.client.from('posts').update({ publication_status: 'published' }).eq('id', post.id);
    if (updated.error) throw new Error(`Unable to update post publication status: ${updated.error.message}`);
    return { publication, existing: false };
  }
}
module.exports = { PortalSupabaseService, QuickSaveOutputError, ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, legacyAccount, legacyCampaign };
