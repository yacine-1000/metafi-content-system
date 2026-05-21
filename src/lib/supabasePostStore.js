'use strict';

const { createClient } = require('@supabase/supabase-js');

function createSupabaseAdmin() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function buildContentPostRow({ postId, jobId, rawInput, sourceType, metadata, publishPackage, localPath } = {}) {
  const m = metadata || {};
  const p = publishPackage || {};
  return {
    post_id:           postId,
    job_id:            jobId             || m.job_id            || p.job_id            || null,
    source_type:       sourceType        || null,
    raw_input:         rawInput          || null,
    caption:           p.caption         || null,
    hashtags:          p.hashtags        || [],
    statuses:          m.statuses        || p.statuses          || {},
    assets:            m.assets          || p.assets            || {},
    supabase:          m.supabase        || p.supabase          || null,
    buffer:            p.buffer          || null,
    publish:           p.publish         || null,
    strategy_metadata: m.strategy_metadata || p.strategy_metadata || null,
    errors:            m.errors          || p.errors            || [],
    local_path:        localPath         || null,
    updated_at:        new Date().toISOString(),
  };
}

async function upsertContentPost(input) {
  const client = createSupabaseAdmin();
  if (!client) return { skipped: true, reason: 'Supabase env missing' };

  const row = buildContentPostRow(input);
  const { data, error } = await client
    .from('content_posts')
    .upsert(row, { onConflict: 'post_id' })
    .select();

  if (error) return { ok: false, error: error.message };
  return { ok: true, data };
}

module.exports = { createSupabaseAdmin, buildContentPostRow, upsertContentPost };
