'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { ensurePortAvailable, validateLocalOperatorEnvironment } = require('../../scripts/startSupabasePortal');
const { hostedPortalEnabled } = require('../../src/ui/server');

test('Supabase operator refuses to start behind an existing local portal', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(() => ensurePortAvailable(port), new RegExp(`Port ${port} is already in use`));
  await new Promise((resolve) => server.close(resolve));
  await ensurePortAvailable(port);
});

test('local Supabase operator bypasses hosted worker guards even when Vercel is inherited', () => {
  assert.equal(hostedPortalEnabled({ METAFI_PERSISTENCE_MODE: 'supabase', METAFI_HOSTED_PORTAL: 'false', METAFI_LOCAL_OPERATOR: 'true', VERCEL: '1' }), false);
  assert.equal(hostedPortalEnabled({ METAFI_PERSISTENCE_MODE: 'supabase', METAFI_HOSTED_PORTAL: 'false', VERCEL: '1' }), true);
});

test('local Supabase operator accepts Buffer disabled', () => {
  assert.equal(validateLocalOperatorEnvironment({ METAFI_PERSISTENCE_MODE: 'supabase', METAFI_HOSTED_PORTAL: 'false', BUFFER_ENABLED: 'false' }), false);
});

test('local Supabase operator accepts Buffer enabled with an API key', () => {
  assert.equal(validateLocalOperatorEnvironment({ METAFI_PERSISTENCE_MODE: 'supabase', METAFI_HOSTED_PORTAL: 'false', BUFFER_ENABLED: 'true', BUFFER_API_KEY: 'buffer-key' }), true);
});

test('local Supabase operator rejects Buffer enabled without an API key', () => {
  assert.throws(() => validateLocalOperatorEnvironment({ METAFI_PERSISTENCE_MODE: 'supabase', METAFI_HOSTED_PORTAL: 'false', BUFFER_ENABLED: 'true' }), /BUFFER_API_KEY is required/);
});
