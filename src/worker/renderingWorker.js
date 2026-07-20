'use strict';

const http = require('http');
const fs = require('fs/promises');
const { chromium } = require('playwright');
const { createPersistenceRepository } = require('../persistence');
const { createOperationalRepository } = require('../persistence/operationalRepository');
const { executeCampaignWindow } = require('../campaigns/campaignExecutor');

const DEFAULTS = Object.freeze({ pollIntervalMs: 15000, slotLeaseMs: 15 * 60 * 1000, executionWindowDays: 3, healthPort: 8080, shutdownTimeoutMs: 5 * 60 * 1000 });

function boolean(name, value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}
function integer(name, value, fallback, minimum = 1) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  return parsed;
}
function validateWorkerEnvironment(env = process.env) {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (env.METAFI_PERSISTENCE_MODE !== 'supabase') throw new Error('METAFI_PERSISTENCE_MODE must be supabase');
  if (!boolean('WORKER_ENABLED', env.WORKER_ENABLED)) throw new Error('WORKER_ENABLED must be true');
  for (const name of required) if (!env[name]) throw new Error(`${name} is required`);
  const bufferEnabled = boolean('BUFFER_ENABLED', env.BUFFER_ENABLED, false);
  if (bufferEnabled && !env.BUFFER_API_KEY) throw new Error('BUFFER_API_KEY is required when BUFFER_ENABLED=true');
  return {
    bufferEnabled,
    bucket: env.SUPABASE_STORAGE_BUCKET || 'metafi-content-assets',
    pollIntervalMs: integer('WORKER_POLL_INTERVAL_MS', env.WORKER_POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs, 1000),
    slotLeaseMs: integer('WORKER_SLOT_LEASE_MS', env.WORKER_SLOT_LEASE_MS, DEFAULTS.slotLeaseMs, 1000),
    executionWindowDays: integer('WORKER_EXECUTION_WINDOW_DAYS', env.WORKER_EXECUTION_WINDOW_DAYS, DEFAULTS.executionWindowDays),
    healthPort: integer('PORT', env.PORT || env.WORKER_HEALTH_PORT, DEFAULTS.healthPort),
    shutdownTimeoutMs: integer('WORKER_SHUTDOWN_TIMEOUT_MS', env.WORKER_SHUTDOWN_TIMEOUT_MS, DEFAULTS.shutdownTimeoutMs, 1000),
  };
}

function createRenderingWorker(options = {}) {
  const env = options.env || process.env;
  const config = options.config || validateWorkerEnvironment(env);
  const repository = options.repository || createPersistenceRepository({ env, client: options.client });
  const operationalRepository = options.operationalRepository || createOperationalRepository({ env, repository });
  const execute = options.executeCampaignWindow || executeCampaignWindow;
  const checkChromium = options.checkChromium || (() => fs.access(chromium.executablePath()));
  const logger = options.logger || console;
  let stopping = false; let running = null; let timer = null; let server = null;
  const state = { started_at: null, ready: false, last_poll_started_at: null, last_poll_completed_at: null, last_error: null, campaigns_checked: 0, executions_started: 0 };

  async function readiness() {
    const database = await repository.response(repository.client.from('accounts').select('id').limit(1), 'Worker database readiness failed');
    const storage = await repository.client.storage.getBucket(config.bucket);
    if (storage.error) throw new Error(`Worker Storage readiness failed: ${storage.error.message}`);
    if (storage.data.public !== false) throw new Error(`Worker Storage bucket ${config.bucket} must be private`);
    await checkChromium();
    return { database: Array.isArray(database) ? 'reachable' : 'reachable', storage: 'reachable', chromium: 'available', bucket: config.bucket };
  }

  async function cycle() {
    if (stopping) return { skipped: 'stopping' };
    if (running) return running;
    running = (async () => {
      state.last_poll_started_at = new Date().toISOString(); state.last_error = null;
      const campaigns = (await repository.listCampaigns()).filter((campaign) => campaign.status === 'active');
      state.campaigns_checked = campaigns.length;
      const results = [];
      for (const campaign of campaigns) {
        if (stopping) break;
        state.executions_started += 1;
        try {
          const summary = await execute(campaign.legacy_campaign_id, { env, repository, operationalRepository,
            rendered_output_bucket: config.bucket, execution_window_days: config.executionWindowDays, slot_claim_lease_ms: config.slotLeaseMs });
          results.push({ campaign_id: campaign.legacy_campaign_id, status: 'completed', summary });
        } catch (error) {
          state.last_error = error.message;
          logger.error(`[rendering-worker] campaign_id=${campaign.legacy_campaign_id} error=${JSON.stringify(error.message)}`);
          results.push({ campaign_id: campaign.legacy_campaign_id, status: 'failed', error: error.message });
        }
      }
      state.last_poll_completed_at = new Date().toISOString();
      return { campaigns: results };
    })();
    try { return await running; } finally { running = null; }
  }

  function schedule() {
    if (stopping) return;
    timer = setTimeout(async () => { try { await cycle(); } catch (error) { state.last_error = error.message; logger.error(`[rendering-worker] poll failed: ${error.message}`); } finally { schedule(); } }, config.pollIntervalMs);
    timer.unref?.();
  }

  function healthResponse(req, res) {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', stopping })); }
    if (req.url === '/readyz') {
      const ok = state.ready && !stopping;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: ok ? 'ready' : 'not_ready', buffer_enabled: config.bufferEnabled, last_error: state.last_error }));
    }
    res.writeHead(404); return res.end();
  }

  async function start() {
    if (state.started_at) return;
    await readiness(); state.ready = true; state.started_at = new Date().toISOString();
    server = http.createServer(healthResponse);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.healthPort, '0.0.0.0', resolve); });
    logger.log(`[rendering-worker] ready port=${config.healthPort} poll_interval_ms=${config.pollIntervalMs} buffer_enabled=${config.bufferEnabled}`);
    await cycle(); schedule();
  }

  async function stop(signal = 'shutdown') {
    if (stopping) return;
    stopping = true; state.ready = false; if (timer) clearTimeout(timer);
    logger.log(`[rendering-worker] stopping signal=${signal}`);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (running) await Promise.race([running.catch(() => {}), new Promise((resolve) => setTimeout(resolve, config.shutdownTimeoutMs))]);
  }

  return { config, state, readiness, cycle, start, stop };
}

module.exports = { DEFAULTS, createRenderingWorker, validateWorkerEnvironment };
