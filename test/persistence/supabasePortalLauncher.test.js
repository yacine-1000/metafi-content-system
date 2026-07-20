'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { ensurePortAvailable } = require('../../scripts/startSupabasePortal');

test('Supabase operator refuses to start behind an existing local portal', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(() => ensurePortAvailable(port), new RegExp(`Port ${port} is already in use`));
  await new Promise((resolve) => server.close(resolve));
  await ensurePortAvailable(port);
});
