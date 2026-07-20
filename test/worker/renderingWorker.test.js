'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRenderingWorker, validateWorkerEnvironment } = require('../../src/worker/renderingWorker');

const validEnv = () => ({ METAFI_PERSISTENCE_MODE: 'supabase', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
  SUPABASE_STORAGE_BUCKET: 'private-assets', WORKER_ENABLED: 'true', BUFFER_ENABLED: 'false' });

test('worker environment is server-only, explicit, and Buffer defaults off', () => {
  const config = validateWorkerEnvironment(validEnv());
  assert.equal(config.bufferEnabled, false); assert.equal(config.bucket, 'private-assets');
  assert.throws(() => validateWorkerEnvironment({ ...validEnv(), WORKER_ENABLED: 'false' }), /WORKER_ENABLED must be true/);
  assert.throws(() => validateWorkerEnvironment({ ...validEnv(), BUFFER_ENABLED: 'true' }), /BUFFER_API_KEY is required/);
});

test('one poll runs each active campaign once and overlapping polls share the execution', async () => {
  let executions = 0; let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const repository = {
    client: { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), storage: { getBucket: async () => ({ data: { public: false }, error: null }) } },
    response: async (request) => (await request).data,
    listCampaigns: async () => [{ legacy_campaign_id: 'active-one', status: 'active' }, { legacy_campaign_id: 'draft-one', status: 'draft' }],
  };
  const worker = createRenderingWorker({ env: validEnv(), repository, operationalRepository: {}, checkChromium: async () => {}, logger: { log() {}, error() {} },
    executeCampaignWindow: async () => { executions += 1; await blocked; return { generated_count: 1 }; } });
  const first = worker.cycle(); const second = worker.cycle(); release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(executions, 1); assert.deepEqual(a, b); assert.equal(a.campaigns[0].campaign_id, 'active-one');
});

test('readiness verifies database access and a private Storage bucket', async () => {
  const repository = {
    client: { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), storage: { getBucket: async () => ({ data: { public: false }, error: null }) } },
    response: async (request) => (await request).data, listCampaigns: async () => [],
  };
  const worker = createRenderingWorker({ env: validEnv(), repository, operationalRepository: {}, checkChromium: async () => {}, logger: { log() {}, error() {} }, executeCampaignWindow: async () => null });
  assert.deepEqual(await worker.readiness(), { database: 'reachable', storage: 'reachable', chromium: 'available', bucket: 'private-assets' });
});
