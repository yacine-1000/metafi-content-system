'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('hosted portal blocks renderer and publication worker routes before execution', async () => {
  const previous = { mode: process.env.METAFI_PERSISTENCE_MODE, vercel: process.env.VERCEL };
  process.env.METAFI_PERSISTENCE_MODE = 'supabase'; process.env.VERCEL = '1';
  const { app } = require('../../src/ui/hostedServer'); const server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const [route, method] of [['/api/generate-slideshows', 'POST'], ['/api/campaigns/campaign-test/generate-window', 'POST'],
      ['/api/campaigns/campaign-test/send-uploaded-to-buffer', 'POST'], ['/api/posts/post-test/schedule-buffer', 'POST'], ['/generate', 'POST']]) {
      const response = await fetch(`${origin}${route}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 503); assert.equal((await response.json()).reason_code, 'WORKER_NOT_DEPLOYED');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous.mode == null) delete process.env.METAFI_PERSISTENCE_MODE; else process.env.METAFI_PERSISTENCE_MODE = previous.mode;
    if (previous.vercel == null) delete process.env.VERCEL; else process.env.VERCEL = previous.vercel;
  }
});
