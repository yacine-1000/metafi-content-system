'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { LocalTeamPublisher } = require('../../src/team/localTeamPublisher');

function writeJson(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(value, null, 2)); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-team-publish-'));
  const campaign = { campaign_id: 'campaign-local', account_id: 'account-local', name: 'Local Team', objective: 'content_testing', language: 'ar', timezone: 'Asia/Riyadh', start_date: '2026-07-20', duration_days: 1, posts_per_day: 1, pillars: [], hook_types: ['listicle'], posting_time_mode: 'manual', posting_times: ['12:00'], publishing_mode: 'team_manual', status: 'active' };
  const slot = { slot_id: 'slot-local', campaign_id: campaign.campaign_id, account_id: campaign.account_id, post_id: 'post-local', date: '2026-07-20', time: '12:00', scheduled_at: '2026-07-20T09:00:00.000Z', pillar_id: 'p2', hook_type: 'listicle', language: 'ar', status: 'completed' };
  const metadata = { post_id: slot.post_id, campaign_id: campaign.campaign_id, slot_id: slot.slot_id, account_id: campaign.account_id, language: 'ar', pillar_id: 'p2', hook_type: 'listicle', created_at: '2026-07-20T08:00:00.000Z', statuses: { generation: 'completed', review: 'approved', upload: 'not_started', publish: 'not_published' } };
  writeJson(path.join(root, 'data/accounts/account-local.json'), { account_id: 'account-local', internal_name: 'Local', display_name: 'Local', username: 'local', platform: 'tiktok', country: 'SA', language: 'ar', gender: 'neutral', timezone: 'Asia/Riyadh', connection_status: 'manual_only', active: true });
  writeJson(path.join(root, 'data/campaigns/campaign-local.json'), campaign);
  writeJson(path.join(root, 'data/campaigns/campaign-local-plan.json'), { campaign_id: campaign.campaign_id, slots: [slot] });
  writeJson(path.join(root, 'outputs/posts/post-local/metadata.json'), metadata);
  writeJson(path.join(root, 'outputs/posts/post-local/publish-package.json'), { caption: 'Caption', slides: [{ slide_number: 1 }, { slide_number: 2 }] });
  fs.mkdirSync(path.join(root, 'outputs/posts/post-local/rendered'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outputs/posts/post-local/rendered/slide-1.png'), Buffer.from('first'));
  fs.writeFileSync(path.join(root, 'outputs/posts/post-local/rendered/slide-2.png'), Buffer.from('second'));
  return { root, metadataPath: path.join(root, 'outputs/posts/post-local/metadata.json') };
}

function harness(root, failKey = '') {
  const objects = new Map(); const calls = { account: 0, campaign: 0, slots: 0, jobs: [], posts: [] };
  const storage = {
    async upload(key, buffer) { if (failKey && key.includes(failKey)) return { error: { message: 'simulated upload failure' } }; objects.set(key, Buffer.from(buffer)); return { error: null }; },
    async download(key) { const value = objects.get(key); return value ? { data: { arrayBuffer: async () => value }, error: null } : { error: { message: 'missing' } }; },
  };
  const client = {
    storage: { from: () => storage },
    from() { const chain = { select() { return chain; }, eq() { return chain; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); } }; return chain; },
  };
  const repository = {
    response: async (request) => (await request).data,
    upsertAccount: async () => { calls.account += 1; },
    upsertCampaign: async () => { calls.campaign += 1; },
    upsertCampaignSlots: async () => { calls.slots += 1; },
    upsertGenerationJob: async (job) => { calls.jobs.push(job); },
    upsertPost: async (post) => { calls.posts.push(post); },
  };
  const publisher = new LocalTeamPublisher({ root, client, repository, env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only', SUPABASE_STORAGE_BUCKET: 'private-assets' } });
  return { publisher, objects, calls };
}

test('local team publishing uploads only ordered slides and is deterministic', async (t) => {
  const { root, metadataPath } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.readFileSync(metadataPath);
  const { publisher, objects, calls } = harness(root);
  const first = await publisher.publishPost('campaign-local', 'post-local');
  await publisher.publishPost('campaign-local', 'post-local');
  assert.equal(first.uploaded_slide_count, 2);
  assert.deepEqual([...objects.keys()], [
    'campaign/campaign-local/slots/slot-local/posts/post-local/ar/slides/slide-01.png',
    'campaign/campaign-local/slots/slot-local/posts/post-local/ar/slides/slide-02.png',
  ]);
  assert.equal([...objects.keys()].some((key) => /\.zip$|manifest\.json$/.test(key)), false);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.posts[0].asset_manifest.rendered_output.zip, undefined);
  assert.deepEqual(fs.readFileSync(metadataPath), original);
});

test('failed slide upload never exposes complete post metadata or changes local post', async (t) => {
  const { root, metadataPath } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.readFileSync(metadataPath);
  const { publisher, calls } = harness(root, 'slide-02');
  await assert.rejects(() => publisher.publishPost('campaign-local', 'post-local'), /simulated upload failure/);
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.jobs.at(-1).state, 'failed');
  assert.deepEqual(fs.readFileSync(metadataPath), original);
});
