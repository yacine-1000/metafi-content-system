'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScheduledPost, scheduleBufferPost } = require('./scheduleBufferPost');

const input = { channelId: 'channel-1', dueAt: '2030-01-01T12:00:00.000Z', text: 'Test post', assets: [] };

function successResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post-1' } } },
    }),
  };
}

function response(status, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function fetchSequence(...results) {
  let calls = 0;
  return {
    fetchImpl: async (...args) => {
      const result = results[calls++];
      if (result instanceof Error) throw result;
      if (typeof result === 'function') return result(...args);
      return result;
    },
    calls: () => calls,
  };
}

function options(fetchImpl, extra = {}) {
  return { fetchImpl, backoffMs: 0, timeoutMs: 10, ...extra };
}

test('succeeds on the first attempt', async () => {
  const mock = fetchSequence(successResponse());
  assert.deepEqual(await createScheduledPost('key', input, options(mock.fetchImpl)), { id: 'post-1' });
  assert.equal(mock.calls(), 1);
});

test('retries HTTP 500 then succeeds', async () => {
  const mock = fetchSequence(response(500), successResponse());
  await createScheduledPost('key', input, options(mock.fetchImpl));
  assert.equal(mock.calls(), 2);
});

test('retries HTTP 429 then succeeds', async () => {
  const mock = fetchSequence(response(429), successResponse());
  await createScheduledPost('key', input, options(mock.fetchImpl));
  assert.equal(mock.calls(), 2);
});

test('retries a network failure then succeeds', async () => {
  const mock = fetchSequence(new Error('network unavailable'), successResponse());
  await createScheduledPost('key', input, options(mock.fetchImpl, { findScheduledPost: async () => null }));
  assert.equal(mock.calls(), 2);
});

test('retries a request timeout then succeeds', async () => {
  const mock = fetchSequence(
    (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    successResponse(),
  );
  await createScheduledPost('key', input, options(mock.fetchImpl, { timeoutMs: 1, findScheduledPost: async () => null }));
  assert.equal(mock.calls(), 2);
});

test('timeout recovery returns the existing post without another create', async () => {
  let createCalls = 0;
  let recoveryCalls = 0;
  const fetchImpl = (_url, request) => {
    createCalls += 1;
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const post = await createScheduledPost('key', input, options(fetchImpl, {
    timeoutMs: 1,
    findScheduledPost: async () => { recoveryCalls += 1; return { id: 'recovered-timeout' }; },
  }));
  assert.equal(post.id, 'recovered-timeout');
  assert.equal(createCalls, 1);
  assert.equal(recoveryCalls, 1);
});

test('network recovery returns the existing post without another create', async () => {
  const mock = fetchSequence(new Error('network unavailable'));
  const post = await createScheduledPost('key', input, options(mock.fetchImpl, {
    findScheduledPost: async () => ({ id: 'recovered-network' }),
  }));
  assert.equal(post.id, 'recovered-network');
  assert.equal(mock.calls(), 1);
});

test('retries creation when recovery finds no post', async () => {
  const mock = fetchSequence(new Error('network unavailable'), successResponse());
  await createScheduledPost('key', input, options(mock.fetchImpl, { findScheduledPost: async () => null }));
  assert.equal(mock.calls(), 2);
});

test('fails when recovery finds multiple matching posts', async () => {
  let createCalls = 0;
  const fetchImpl = async (_url, request) => {
    const query = JSON.parse(request.body).query;
    if (query.includes('CreateScheduledPost')) {
      createCalls += 1;
      throw new Error('network unavailable');
    }
    if (query.includes('BufferOrganizations')) {
      return response(200, { data: { account: { organizations: [{ id: 'organization-1' }] } } });
    }
    return response(200, {
      data: {
        posts: {
          edges: [
            { node: { id: 'post-1', channelId: input.channelId, dueAt: input.dueAt, text: input.text, assets: [] } },
            { node: { id: 'post-2', channelId: input.channelId, dueAt: input.dueAt, text: input.text, assets: [] } },
          ],
        },
      },
    });
  };
  await assert.rejects(
    createScheduledPost('key', input, options(fetchImpl)),
    /multiple matching scheduled posts/,
  );
  assert.equal(createCalls, 1);
});

test('does not retry HTTP 401', async () => {
  const mock = fetchSequence(response(401));
  await assert.rejects(createScheduledPost('key', input, options(mock.fetchImpl)), /authentication failed/);
  assert.equal(mock.calls(), 1);
});

test('does not retry GraphQL or Buffer validation failures', async (t) => {
  await t.test('GraphQL error', async () => {
    const mock = fetchSequence(response(200, { errors: [{ message: 'invalid input' }] }));
    await assert.rejects(createScheduledPost('key', input, options(mock.fetchImpl)), /GraphQL error/);
    assert.equal(mock.calls(), 1);
  });
  await t.test('mutation error', async () => {
    const mock = fetchSequence(response(200, { data: { createPost: { __typename: 'MutationError', message: 'invalid input' } } }));
    await assert.rejects(createScheduledPost('key', input, options(mock.fetchImpl)), /Buffer scheduling failed/);
    assert.equal(mock.calls(), 1);
  });
});

test('stops retrying after the configured maximum', async () => {
  const mock = fetchSequence(response(500), response(500), response(500));
  await assert.rejects(
    createScheduledPost('key', input, options(mock.fetchImpl, { maxRetries: 2 })),
    /HTTP 500/,
  );
  assert.equal(mock.calls(), 3);
});

function scheduledPostResponse(postId = 'buffer-post') {
  return {
    id: postId, text: 'Test post', status: 'scheduled', dueAt: '2030-01-01T12:00:00.000Z', sentAt: null,
    channelId: 'channel-1', channelService: 'tiktok', assets: [{ source: 'https://example.com/slide.png' }],
  };
}

function schedulingFixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-buffer-schedule-'));
  fs.writeFileSync(path.join(folder, 'r2-upload.json'), JSON.stringify({ status: 'uploaded', files: [{ slide_number: 1, public_url: 'https://example.com/slide.png' }] }));
  fs.writeFileSync(path.join(folder, 'caption.txt'), 'Test post');
  fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({ post_id: path.basename(folder), statuses: {} }));
  return folder;
}

test('recovers a Buffer success after local persistence fails without creating a second post', async () => {
  const folder = schedulingFixture();
  let createCalls = 0;
  const fetchImpl = async (_url, request) => {
    const query = JSON.parse(request.body).query;
    if (query.includes('CreateScheduledPost')) {
      createCalls += 1;
      return response(200, { data: { createPost: { __typename: 'PostActionSuccess', post: scheduledPostResponse() } } });
    }
    if (query.includes('BufferOrganizations')) {
      return response(200, { data: { account: { organizations: [{ id: 'organization-1' }] } } });
    }
    return response(200, { data: { posts: { edges: [{ node: scheduledPostResponse() }] } } });
  };
  const args = { date: '2030-01-01', time: '12:00', timezone: 'UTC', channelId: 'channel-1', schedulingType: 'notification' };
  let failScheduleWrite = true;
  const writeFileSync = (filePath, contents, encoding) => {
    if (failScheduleWrite && path.basename(filePath) === 'buffer-schedule.json') throw new Error('disk unavailable');
    fs.writeFileSync(filePath, contents, encoding);
  };
  await assert.rejects(scheduleBufferPost(folder, args, { apiKey: 'key', fetchImpl, writeFileSync }), /disk unavailable/);
  assert.equal(createCalls, 1);
  assert.ok(fs.existsSync(path.join(folder, 'buffer-schedule-pending.json')));

  failScheduleWrite = false;
  const result = await scheduleBufferPost(folder, args, { apiKey: 'key', fetchImpl });
  assert.equal(result.buffer_scheduled_post_id, 'buffer-post');
  assert.equal(createCalls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8')).buffer_post_id, 'buffer-post');
  assert.ok(fs.existsSync(path.join(folder, 'buffer-schedule.json')));
  assert.ok(!fs.existsSync(path.join(folder, 'buffer-schedule-pending.json')));
});
