'use strict';

const { createPersistenceRepository } = require('../persistence');

function buildPostRecord({ postId, jobId, rawInput, sourceType, metadata, publishPackage, localPath } = {}) {
  const m = metadata || {};
  const p = publishPackage || {};
  return {
    post_id: postId,
    job_id: jobId || m.job_id || p.job_id || null,
    account_id: m.account_id || p.account_id || null,
    campaign_id: m.campaign_id || p.campaign_id || null,
    slot_id: m.slot_id || p.slot_id || null,
    language: m.language || p.language || 'ar',
    pillar_id: m.pillar_id || p.pillar_id || null,
    hook_type: m.hook_type || p.hook_type || null,
    topic_id: m.topic_id || p.topic_id || null,
    master_script_id: m.master_script_id || p.master_script_id || null,
    caption: p.caption || '',
    statuses: m.statuses || p.statuses || {},
    assets: m.assets || p.assets || {},
    publish_package: p,
    strategy_metadata: m.strategy_metadata || p.strategy_metadata || {},
    errors: m.errors || p.errors || [],
    local_path: localPath || null,
    buffer_status: m.buffer_status || p.buffer_status || null,
    buffer_post_id: m.buffer_post_id || p.buffer_post_id || null,
    buffer_channel_id: m.buffer_channel_id || p.buffer_channel_id || null,
    scheduled_at: m.scheduled_at || p.scheduled_at || null,
    saved_at: m.saved_at || null,
    source_type: sourceType || null,
    raw_input: rawInput || null,
  };
}

async function upsertContentPost(input, options = {}) {
  const repository = options.repository || createPersistenceRepository({ env: options.env || process.env });
  if (repository.mode === 'local') return { skipped: true, mode: 'local', reason: 'local persistence mode' };
  try {
    const data = await repository.upsertPost(buildPostRecord(input));
    return { ok: true, data, mode: 'supabase' };
  } catch (error) {
    return { ok: false, error: error.message, mode: 'supabase' };
  }
}

module.exports = { buildPostRecord, upsertContentPost };
