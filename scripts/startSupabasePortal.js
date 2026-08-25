'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const environmentFile = path.join(ROOT, '.env.supabase.local');

function required(name) {
  if (!process.env[name] || !String(process.env[name]).trim()) throw new Error(`${name} is required in .env.supabase.local`);
}

function validateLocalOperatorEnvironment(env = process.env) {
  if (env.METAFI_PERSISTENCE_MODE !== 'supabase') throw new Error('METAFI_PERSISTENCE_MODE must be supabase');
  if (env.METAFI_HOSTED_PORTAL !== 'false') throw new Error('METAFI_HOSTED_PORTAL must be false for the local operator');
  if (!['true', 'false'].includes(env.BUFFER_ENABLED)) throw new Error('BUFFER_ENABLED must be true or false for the local operator');
  if (env.BUFFER_ENABLED === 'true' && (!env.BUFFER_API_KEY || !String(env.BUFFER_API_KEY).trim())) {
    throw new Error('BUFFER_API_KEY is required when BUFFER_ENABLED=true');
  }
  return env.BUFFER_ENABLED === 'true';
}

function ensurePortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing local portal before starting the Supabase operator.`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve));
  });
}

async function main() {
  if (!fs.existsSync(environmentFile)) throw new Error('.env.supabase.local is missing; copy .env.supabase.local.example and add server-side credentials');
  dotenv.config({ path: path.join(ROOT, '.env') });
  const localValues = dotenv.parse(fs.readFileSync(environmentFile));
  for (const [name, value] of Object.entries(localValues)) {
    if (value !== '' || process.env[name] == null) process.env[name] = value;
  }
  const bufferEnabled = validateLocalOperatorEnvironment(process.env);
  process.env.METAFI_LOCAL_OPERATOR = 'true';
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET']) required(name);
  const port = Number(process.env.PORT || 3333);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  await ensurePortAvailable(port);

  const { chromium } = require('playwright');
  const chromiumPath = chromium.executablePath();
  if (!fs.existsSync(chromiumPath)) throw new Error('Local Chromium is unavailable; run npx playwright install chromium');
  const { PortalSupabaseService } = require('../src/persistence/portalSupabaseService');
  const health = await new PortalSupabaseService(process.env).health();
  if (health.status !== 'ok' || health.database !== 'reachable' || health.storage !== 'reachable' || health.storage_private !== true) throw new Error('Supabase database or private Storage readiness failed');

  const { app } = require('../src/ui/server');
  app.listen(port, () => {
    console.log('Local operator mode: SUPABASE');
    console.log('Database: connected');
    console.log('Storage: connected');
    console.log('Chromium: ready');
    console.log('Local generation: enabled');
    console.log('Hosted worker dispatch: disabled');
    console.log(`Buffer: ${bufferEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Portal: http://localhost:${port}`);
  });
}

if (require.main === module) main().catch((error) => { console.error(`Supabase operator startup failed: ${error.message}`); process.exitCode = 1; });

module.exports = { ensurePortAvailable, validateLocalOperatorEnvironment, main };
