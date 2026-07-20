'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const environmentFile = path.join(ROOT, '.env.supabase.local');

function required(name) {
  if (!process.env[name] || !String(process.env[name]).trim()) throw new Error(`${name} is required in .env.supabase.local`);
}

async function main() {
  if (!fs.existsSync(environmentFile)) throw new Error('.env.supabase.local is missing; copy .env.supabase.local.example and add server-side credentials');
  dotenv.config({ path: path.join(ROOT, '.env') });
  const localValues = dotenv.parse(fs.readFileSync(environmentFile));
  for (const [name, value] of Object.entries(localValues)) {
    if (value !== '' || process.env[name] == null) process.env[name] = value;
  }
  if (process.env.METAFI_PERSISTENCE_MODE !== 'supabase') throw new Error('METAFI_PERSISTENCE_MODE must be supabase');
  if (process.env.METAFI_HOSTED_PORTAL !== 'false') throw new Error('METAFI_HOSTED_PORTAL must be false for the local operator');
  if (process.env.BUFFER_ENABLED !== 'false') throw new Error('BUFFER_ENABLED must be false for the local operator');
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET']) required(name);

  const { chromium } = require('playwright');
  const chromiumPath = chromium.executablePath();
  if (!fs.existsSync(chromiumPath)) throw new Error('Local Chromium is unavailable; run npx playwright install chromium');
  const { PortalSupabaseService } = require('../src/persistence/portalSupabaseService');
  const health = await new PortalSupabaseService(process.env).health();
  if (health.status !== 'ok' || health.database !== 'reachable' || health.storage !== 'reachable' || health.storage_private !== true) throw new Error('Supabase database or private Storage readiness failed');

  const { app } = require('../src/ui/server');
  const port = Number(process.env.PORT || 3333);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  app.listen(port, () => {
    console.log('Local operator mode: SUPABASE');
    console.log('Database: connected');
    console.log('Storage: connected');
    console.log('Chromium: ready');
    console.log('Buffer: disabled');
    console.log(`Portal: http://localhost:${port}`);
  });
}

if (require.main === module) main().catch((error) => { console.error(`Supabase operator startup failed: ${error.message}`); process.exitCode = 1; });

module.exports = { main };
