'use strict';

class PersistenceDataError extends Error {
  constructor(message) { super(message); this.name = 'PersistenceDataError'; }
}

function nullable(value) { return value == null || value === '' ? null : value; }
function json(value, fallback) { return value == null ? fallback : value; }
function oneOf(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }

class SupabaseRepository {
  constructor(client) {
    if (!client || typeof client.from !== 'function') throw new PersistenceDataError('A Supabase client is required');
    this.client = client;
    this.mode = 'supabase';
    this.ids = { accounts: new Map(), campaigns: new Map(), slots: new Map(), posts: new Map(), jobs: new Map() };
  }

  async response(request, label) {
    const { data, error } = await request;
    if (error) throw new PersistenceDataError(`${label}: ${error.message}`);
    return data;
  }

  async idFor(table, legacyColumn, legacyId, cache) {
    if (!legacyId) return null;
    if (cache.has(legacyId)) return cache.get(legacyId);
    const data = await this.response(this.client.from(table).select('id').eq(legacyColumn, legacyId).maybeSingle(), `Unable to resolve ${legacyId}`);
    if (!data || !data.id) throw new PersistenceDataError(`Referenced ${table} record does not exist: ${legacyId}`);
    cache.set(legacyId, data.id);
    return data.id;
  }

  async accountId(legacyId) { return this.idFor('accounts', 'legacy_account_id', legacyId, this.ids.accounts); }
  async campaignId(legacyId) { return this.idFor('campaigns', 'legacy_campaign_id', legacyId, this.ids.campaigns); }
  async slotId(legacyId) { return this.idFor('campaign_slots', 'legacy_slot_id', legacyId, this.ids.slots); }
  async postId(legacyId) { return this.idFor('posts', 'legacy_post_id', legacyId, this.ids.posts); }
  async jobId(legacyId) { return this.idFor('generation_jobs', 'legacy_job_id', legacyId, this.ids.jobs); }

  async upsertAccount(account) {
    const row = {
      legacy_account_id: account.account_id || account.legacy_account_id,
      internal_name: account.internal_name,
      display_name: account.display_name,
      username: account.username,
      platform: account.platform || 'tiktok', country: account.country || '', language: account.language,
      gender: account.gender, timezone: account.timezone, avatar_path: nullable(account.avatar_path),
      connection_status: account.connection_status, active: account.active !== false,
      default_publishing_mode: account.default_publishing_mode || 'mobile_finish',
      buffer_organization_id: nullable(account.buffer_organization_id), buffer_channel_id: nullable(account.buffer_channel_id),
      buffer_channel_name: nullable(account.buffer_channel_name),
    };
    if (!row.legacy_account_id) throw new PersistenceDataError('Account legacy ID is required');
    const data = await this.response(this.client.from('accounts').upsert(row, { onConflict: 'legacy_account_id' }).select().single(), 'Unable to upsert account');
    this.ids.accounts.set(row.legacy_account_id, data.id);
    return data;
  }

  async upsertCampaign(campaign) {
    const legacyCampaignId = campaign.campaign_id || campaign.legacy_campaign_id;
    const accountLegacyId = campaign.account_id || campaign.legacy_account_id;
    if (!legacyCampaignId || !accountLegacyId) throw new PersistenceDataError('Campaign legacy ID and account ID are required');
    const row = {
      legacy_campaign_id: legacyCampaignId, account_id: await this.accountId(accountLegacyId), name: campaign.name,
      objective: campaign.objective, language: campaign.language, timezone: campaign.timezone, start_date: campaign.start_date,
      duration_days: campaign.duration_days, posts_per_day: campaign.posts_per_day, pillars: json(campaign.pillars, []),
      hook_types: json(campaign.hook_types, []), posting_time_mode: campaign.posting_time_mode,
      posting_times: json(campaign.posting_times, []), publishing_mode: campaign.publishing_mode || 'mobile_finish',
      status: campaign.status || 'draft',
    };
    const data = await this.response(this.client.from('campaigns').upsert(row, { onConflict: 'legacy_campaign_id' }).select().single(), 'Unable to upsert campaign');
    this.ids.campaigns.set(legacyCampaignId, data.id);
    return data;
  }

  async upsertCampaignSlots(campaignLegacyId, slots, fallbackAccountLegacyId = null) {
    const campaignId = await this.campaignId(campaignLegacyId);
    const rows = await Promise.all((slots || []).map(async (slot) => ({
      legacy_slot_id: slot.slot_id || slot.legacy_slot_id, campaign_id: campaignId,
      account_id: await this.accountId(slot.account_id || fallbackAccountLegacyId), scheduled_date: slot.date || slot.scheduled_date,
      scheduled_time: slot.time || slot.scheduled_time, scheduled_at: slot.scheduled_at,
      pillar_id: slot.pillar_id, hook_type: slot.hook_type, language: slot.language,
      publishing_mode: slot.publishing_mode || 'mobile_finish', status: slot.status || 'planned',
      attempt_count: slot.attempt_count || 0, failure_code: nullable(slot.failure_code), failure_reason: nullable(slot.failure_reason),
      claim_id: nullable(slot.claim && slot.claim.claim_id), claimed_at: nullable(slot.claim && slot.claim.claimed_at),
      claim_expires_at: nullable(slot.claim && slot.claim.lease_expires_at),
    })));
    if (rows.some((row) => !row.legacy_slot_id || !row.account_id)) throw new PersistenceDataError('Campaign slot legacy ID and account ID are required');
    if (!rows.length) return [];
    const data = await this.response(this.client.from('campaign_slots').upsert(rows, { onConflict: 'legacy_slot_id' }).select(), 'Unable to upsert campaign slots');
    data.forEach((row) => this.ids.slots.set(row.legacy_slot_id, row.id));
    return data;
  }

  async upsertGenerationJob(job) {
    const legacyJobId = job.job_id || job.jobId || job.legacy_job_id;
    const row = {
      legacy_job_id: nullable(legacyJobId), account_id: await this.accountId(job.account_id),
      campaign_id: job.campaign_id ? await this.campaignId(job.campaign_id) : null,
      campaign_slot_id: job.slot_id ? await this.slotId(job.slot_id) : null,
      state: oneOf(job.state || job.status, ['queued', 'claimed', 'selecting', 'resolving_assets', 'rendering', 'uploading', 'completed', 'failed'], 'queued'), attempt_count: job.attempt_count || 0,
      claim_token: nullable(job.claim_token), claimed_at: nullable(job.claimed_at), claim_expires_at: nullable(job.claim_expires_at),
      started_at: nullable(job.started_at), completed_at: nullable(job.completed_at), error_code: nullable(job.error_code),
      error_message: nullable(job.error_message), progress: json(job.progress || job.steps, {}),
    };
    const request = legacyJobId
      ? this.client.from('generation_jobs').upsert(row, { onConflict: 'legacy_job_id' }).select().single()
      : this.client.from('generation_jobs').insert(row).select().single();
    const data = await this.response(request, 'Unable to upsert generation job');
    if (legacyJobId) this.ids.jobs.set(legacyJobId, data.id);
    return data;
  }

  async upsertPost(post) {
    const legacyPostId = post.post_id || post.postId || post.legacy_post_id;
    if (!legacyPostId || !post.account_id) throw new PersistenceDataError('Post legacy ID and account ID are required');
    const statuses = post.statuses || {};
    const row = {
      legacy_post_id: legacyPostId, account_id: await this.accountId(post.account_id),
      campaign_id: post.campaign_id ? await this.campaignId(post.campaign_id) : null,
      campaign_slot_id: post.slot_id ? await this.slotId(post.slot_id) : null,
      generation_job_id: post.job_id ? await this.jobId(post.job_id) : null,
      language: post.language, pillar_id: nullable(post.pillar_id), hook_type: nullable(post.hook_type),
      topic_id: nullable(post.topic_id), master_script_id: nullable(post.master_script_id), caption: post.caption || '',
      publish_package: json(post.publish_package || post.publishPackage, {}), strategy_metadata: json(post.strategy_metadata, {}),
      asset_manifest: json(post.assets || post.asset_manifest, {}), errors: json(post.errors, []),
      generation_status: oneOf(statuses.generation || post.generation_status, ['queued', 'generating', 'completed', 'failed'], 'queued'),
      review_status: oneOf(statuses.review || post.review_status, ['pending', 'approved', 'rejected'], 'pending'),
      upload_status: oneOf(statuses.upload || post.upload_status, ['not_started', 'uploading', 'uploaded', 'failed'], 'not_started'),
      buffer_status: oneOf(post.buffer_status || statuses.buffer, ['not_sent', 'draft', 'notification_scheduled', 'buffered', 'published', 'failed'], 'not_sent'),
      publication_status: oneOf(statuses.publish || post.publication_status, ['not_published', 'published', 'failed'], 'not_published'), publishing_mode: post.publishing_mode || 'mobile_finish',
      saved_at: nullable(post.saved_at), local_path: nullable(post.local_path), buffer_post_id: nullable(post.buffer_post_id),
      buffer_channel_id: nullable(post.buffer_channel_id), buffer_scheduled_at: nullable(post.scheduled_at), buffer_payload: nullable(post.buffer),
    };
    const data = await this.response(this.client.from('posts').upsert(row, { onConflict: 'legacy_post_id' }).select().single(), 'Unable to upsert post');
    this.ids.posts.set(legacyPostId, data.id);
    return data;
  }

  async upsertPublication(publication) {
    const row = {
      legacy_publication_id: nullable(publication.publication_id), post_id: await this.postId(publication.post_id),
      account_id: await this.accountId(publication.account_id), campaign_id: publication.campaign_id ? await this.campaignId(publication.campaign_id) : null,
      campaign_slot_id: publication.slot_id ? await this.slotId(publication.slot_id) : null,
      method: publication.method, status: publication.status || 'published', published_at: nullable(publication.published_at),
      confirmed_at: nullable(publication.confirmed_at), external_url: nullable(publication.external_url), script_id: nullable(publication.script_id),
      source_set_id: nullable(publication.source_set_id), buffer_post_id: nullable(publication.buffer && publication.buffer.post_id),
      buffer_channel_id: nullable(publication.buffer && publication.buffer.channel_id), buffer_status: nullable(publication.buffer && publication.buffer.status),
      buffer_sent_at: nullable(publication.buffer && publication.buffer.sent_at), metadata: json(publication.metadata, {}),
    };
    return this.response(this.client.from('publication_history').upsert(row, { onConflict: 'post_id' }).select().single(), 'Unable to upsert publication');
  }

  async upsertAccountAsset(asset) {
    const row = {
      account_id: await this.accountId(asset.account_id), post_id: asset.post_id ? await this.postId(asset.post_id) : null,
      asset_type: asset.asset_type, language: nullable(asset.language), hook_type: nullable(asset.hook_type), slide_number: nullable(asset.slide_number),
      storage_provider: asset.storage_provider || 'local', storage_bucket: nullable(asset.storage_bucket), storage_key: asset.storage_key,
      public_url: nullable(asset.public_url), content_type: asset.content_type, byte_size: nullable(asset.byte_size), width: nullable(asset.width),
      height: nullable(asset.height), checksum_sha256: nullable(asset.checksum_sha256), active: asset.active !== false,
    };
    return this.response(this.client.from('account_assets').upsert(row, { onConflict: 'account_id,storage_provider,storage_key' }).select().single(), 'Unable to upsert account asset');
  }

  async upsertContentAsset(asset) {
    const row = {
      legacy_id: asset.legacy_id, asset_type: asset.asset_type, bank: asset.bank,
      pillar: nullable(asset.pillar), hook_type: nullable(asset.hook_type), language: nullable(asset.language),
      storage_provider: asset.storage_provider || 'local', bucket: nullable(asset.bucket), storage_key: asset.storage_key,
      mime_type: asset.mime_type || asset.content_type, width: nullable(asset.width), height: nullable(asset.height),
      size_bytes: nullable(asset.size_bytes == null ? asset.byte_size : asset.size_bytes), checksum: nullable(asset.checksum), active: asset.active !== false,
    };
    if (!row.legacy_id || !row.asset_type || !row.bank || !row.storage_key || !row.mime_type) {
      throw new PersistenceDataError('Content asset legacy ID, type, bank, storage key, and MIME type are required');
    }
    return this.response(this.client.from('content_assets').upsert(row, { onConflict: 'legacy_id' }).select().single(), 'Unable to upsert content asset');
  }

  async listAccounts() { return this.response(this.client.from('accounts').select('*').order('internal_name'), 'Unable to list accounts'); }
  async getAccount(legacyAccountId) { return this.response(this.client.from('accounts').select('*').eq('legacy_account_id', legacyAccountId).maybeSingle(), 'Unable to get account'); }
  async listCampaigns() { return this.response(this.client.from('campaigns').select('*').order('created_at', { ascending: false }), 'Unable to list campaigns'); }
  async getCampaign(legacyCampaignId) { return this.response(this.client.from('campaigns').select('*').eq('legacy_campaign_id', legacyCampaignId).maybeSingle(), 'Unable to get campaign'); }
  async listCampaignSlots(campaignLegacyId) { return this.response(this.client.from('campaign_slots').select('*').eq('campaign_id', await this.campaignId(campaignLegacyId)).order('scheduled_at'), 'Unable to list campaign slots'); }
  async listPosts(campaignLegacyId) { const id = campaignLegacyId ? await this.campaignId(campaignLegacyId) : null; let query = this.client.from('posts').select('*').order('created_at', { ascending: false }); if (id) query = query.eq('campaign_id', id); return this.response(query, 'Unable to list posts'); }
  async listGenerationJobs() { return this.response(this.client.from('generation_jobs').select('*').order('created_at', { ascending: false }), 'Unable to list generation jobs'); }
  async listPublicationHistory() { return this.response(this.client.from('publication_history').select('*').order('published_at', { ascending: false }), 'Unable to list publication history'); }
  async listAccountAssets(accountLegacyId) { return this.response(this.client.from('account_assets').select('*').eq('account_id', await this.accountId(accountLegacyId)).order('created_at'), 'Unable to list account assets'); }
  async listContentAssets() { return this.response(this.client.from('content_assets').select('*').order('created_at'), 'Unable to list content assets'); }

  async deleteAccount(legacyAccountId) { return this.response(this.client.from('accounts').delete().eq('legacy_account_id', legacyAccountId).select().maybeSingle(), 'Unable to delete account'); }
  async deleteCampaign(legacyCampaignId) { return this.response(this.client.from('campaigns').delete().eq('legacy_campaign_id', legacyCampaignId).select().maybeSingle(), 'Unable to delete campaign'); }
  async deletePost(legacyPostId) { return this.response(this.client.from('posts').delete().eq('legacy_post_id', legacyPostId).select().maybeSingle(), 'Unable to delete post'); }
  async deleteGenerationJob(legacyJobId) { return this.response(this.client.from('generation_jobs').delete().eq('legacy_job_id', legacyJobId).select().maybeSingle(), 'Unable to delete generation job'); }
  async deleteAccountAsset(assetId) { return this.response(this.client.from('account_assets').delete().eq('id', assetId).select().maybeSingle(), 'Unable to delete account asset'); }
  async deleteContentAsset(assetId) { return this.response(this.client.from('content_assets').delete().eq('id', assetId).select().maybeSingle(), 'Unable to delete content asset'); }
}

module.exports = { PersistenceDataError, SupabaseRepository };
