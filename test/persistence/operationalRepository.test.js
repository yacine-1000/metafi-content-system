'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalOperationalRepository, SupabaseOperationalRepository } = require('../../src/persistence/operationalRepository');
const { SupabaseRepository } = require('../../src/persistence/supabaseRepository');
const { createServerSupabaseClient } = require('../../src/persistence/serverSupabaseClient');
const { getCoolingScriptIds } = require('../../src/publication/publicationService');

function localPlan(root, id) {
  const dir = path.join(root, 'data', 'campaigns'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}-plan.json`), JSON.stringify({ campaign_id: id, slots: [{ slot_id: 'slot-1', date: '2026-07-19', status: 'planned' }] }));
}

test('LocalOperationalRepository preserves claim leases, finalization, jobs, and summaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-operational-'));
  try {
    const repo = new LocalOperationalRepository({ root }); const campaign = 'campaign-local-test'; localPlan(root, campaign);
    const now = new Date('2026-07-19T09:00:00Z');
    const claims = await Promise.all([repo.claimEligibleSlot(campaign, 'slot-1', now, 60000), repo.claimEligibleSlot(campaign, 'slot-1', now, 60000)]);
    assert.equal(claims.filter(Boolean).length, 1, 'one concurrent claim wins'); const claim = claims.find(Boolean);
    assert.equal(await repo.claimEligibleSlot(campaign, 'slot-1', now, 60000), null, 'active lease cannot reclaim');
    const reclaimed = await repo.claimEligibleSlot(campaign, 'slot-1', new Date('2026-07-19T09:01:01Z'), 60000); assert.ok(reclaimed, 'expired active lease can reclaim');
    assert.equal(await repo.finalizeClaimedSlot(campaign, 'slot-1', claim.claim.claim_id, { status: 'failed' }), null, 'expired original claim cannot finalize');
    assert.equal((await repo.finalizeClaimedSlot(campaign, 'slot-1', reclaimed.claim.claim_id, { status: 'failed' })).status, 'failed', 'replacement claim finalizes');
    await repo.createGenerationJob({ job_id: 'job-local', state: 'queued' }); assert.equal((await repo.updateGenerationJob('job-local', { state: 'completed' })).state, 'completed');
    await repo.saveExecutionSummary(campaign, { generated_count: 1 }); assert.deepEqual(await repo.getExecutionSummary(campaign), { generated_count: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SupabaseOperationalRepository preserves claim leases, finalization, jobs, and summaries', { skip: !process.env.SUPABASE_SERVICE_ROLE_KEY }, async () => {
  const client = createServerSupabaseClient(); const base = new SupabaseRepository(client); const repo = new SupabaseOperationalRepository(base); const tag = `repo-test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let campaignId;
  try {
    const accounts = await base.listAccounts(); const account = accounts[0]; assert.ok(account, 'seed account exists');
    await base.upsertCampaign({ campaign_id: tag, account_id: account.legacy_account_id, name: tag, objective: 'content_testing', language: 'ar', timezone: 'Asia/Riyadh', start_date: '2026-07-19', duration_days: 1, posts_per_day: 1, pillars: [], hook_types: ['listicle'], posting_time_mode: 'random', posting_times: [], status: 'draft' });
    campaignId = tag; await base.upsertCampaignSlots(tag, [{ slot_id: `${tag}-slot`, date: '2026-07-19', time: '12:00', scheduled_at: '2026-07-19T09:00:00Z', pillar_id: 'p1', hook_type: 'listicle', language: 'ar', status: 'planned' }], account.legacy_account_id);
    const claims = await Promise.all([repo.claimEligibleSlot(tag, `${tag}-slot`, new Date(), 60000), repo.claimEligibleSlot(tag, `${tag}-slot`, new Date(), 60000)]); assert.equal(claims.filter(Boolean).length, 1); const claim = claims.find(Boolean);
    assert.equal(await repo.claimEligibleSlot(tag, `${tag}-slot`, new Date(), 60000), null);
    const reclaimed = await repo.claimEligibleSlot(tag, `${tag}-slot`, new Date(Date.now() + 61000), 60000); assert.ok(reclaimed, 'expired active lease can reclaim');
    assert.equal(await repo.finalizeClaimedSlot(tag, `${tag}-slot`, claim.claim.claim_id, { status: 'failed' }), null, 'expired original claim cannot finalize');
    assert.equal((await repo.finalizeClaimedSlot(tag, `${tag}-slot`, reclaimed.claim.claim_id, { status: 'failed' })).status, 'failed', 'replacement claim finalizes');
    await repo.createGenerationJob({ job_id: `${tag}-job`, account_id: account.legacy_account_id, campaign_id: tag, state: 'queued' }); assert.equal((await repo.updateGenerationJob(`${tag}-job`, { account_id: account.legacy_account_id, campaign_id: tag, state: 'completed' })).state, 'completed');
    await repo.saveExecutionSummary(tag, { generated_count: 1 }); assert.deepEqual(await repo.getExecutionSummary(tag), { generated_count: 1 });
  } finally { if (campaignId) await base.deleteCampaign(campaignId); }
});

test('LocalOperationalRepository cooling IDs match publication service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-cooling-'));
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true }); const now = new Date('2026-07-19T12:00:00Z');
    fs.writeFileSync(path.join(root, 'data', 'publication-history.json'), JSON.stringify({ publications: [
      { publication_id: 'a', account_id: 'account-a', script_id: 'recent', published_at: '2026-07-19T11:00:00Z' },
      { publication_id: 'b', account_id: 'account-a', script_id: 'old', published_at: '2026-07-01T11:00:00Z' },
      { publication_id: 'c', account_id: 'account-b', script_id: 'other', published_at: '2026-07-19T11:00:00Z' },
    ] }));
    const repo = new LocalOperationalRepository({ root }); const options = { now, cooldownMs: 86400000 };
    assert.deepEqual([...await repo.getCoolingScriptIds('account-a', options)], [...getCoolingScriptIds('account-a', { ...options, root })]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SupabaseOperationalRepository cooling IDs isolate account and window', { skip: !process.env.SUPABASE_SERVICE_ROLE_KEY }, async () => {
  const client = createServerSupabaseClient(); const base = new SupabaseRepository(client); const repo = new SupabaseOperationalRepository(base); const tag = `cooling-${Date.now()}`; const ids = []; const posts = [];
  try {
    for (const suffix of ['a', 'b']) { const row = await base.upsertAccount({ account_id: `${tag}-${suffix}`, internal_name: `${tag}-${suffix}`, display_name: suffix, username: `${tag}-${suffix}`, platform: 'tiktok', country: '', language: 'ar', gender: 'male', timezone: 'Asia/Riyadh', connection_status: 'manual_only', active: true }); ids.push(row); }
    const now = new Date(); const recent = new Date(now.getTime() - 60000).toISOString(); const old = new Date(now.getTime() - 172800000).toISOString();
    for (const [index, script, published] of [[0, 'recent-a', recent], [0, 'old-a', old], [1, 'recent-b', recent]]) { const post = await client.from('posts').insert({ legacy_post_id: `${tag}-post-${script}`, account_id: ids[index].id, language: 'ar', caption: '' }).select().single(); if (post.error) throw post.error; posts.push(post.data.id); const pub = await client.from('publication_history').insert({ post_id: post.data.id, account_id: ids[index].id, method: 'manual', status: 'published', published_at: published, script_id: script }).select().single(); if (pub.error) throw pub.error; }
    const cooling = await repo.getCoolingScriptIds(`${tag}-a`, { now, cooldownMs: 86400000 }); assert.deepEqual([...cooling], ['recent-a']);
  } finally { for (const id of posts) await client.from('posts').delete().eq('id', id); for (const account of ids) await base.deleteAccount(account.legacy_account_id); }
});
