'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.METAFI_PERSISTENCE_MODE = 'local';
const { app } = require('../../src/ui/server');
const { PortalSupabaseService } = require('../../src/persistence/portalSupabaseService');

async function getPosts() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/posts`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /posts retains local filesystem behavior in local mode', async () => {
  process.env.METAFI_PERSISTENCE_MODE = 'local';
  const result = await getPosts();
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body));
});

test('GET /posts returns the Supabase Content-tab projection in Supabase mode', async () => {
  const original = PortalSupabaseService.prototype.contentPosts;
  PortalSupabaseService.prototype.contentPosts = async () => [{
    post_id: 'post-hosted', campaign_id: 'campaign-hosted', slot_id: 'slot-hosted',
    statuses: { generation: 'completed', review: 'approved', upload: 'uploaded', buffer: 'scheduled', publish: 'not_published', strategy: 'passed' },
    buffer_post_id: 'buffer-hosted', created_at: '2030-01-01T10:00:00.000Z', updated_at: '2030-01-01T11:00:00.000Z',
  }];
  process.env.METAFI_PERSISTENCE_MODE = 'supabase';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  try {
    const result = await getPosts();
    assert.equal(result.status, 200);
    assert.equal(result.body[0].post_id, 'post-hosted');
    assert.equal(result.body[0].campaign_id, 'campaign-hosted');
    assert.equal(result.body[0].slot_id, 'slot-hosted');
    assert.equal(result.body[0].statuses.generation, 'completed');
  } finally {
    PortalSupabaseService.prototype.contentPosts = original;
    process.env.METAFI_PERSISTENCE_MODE = 'local';
  }
});
