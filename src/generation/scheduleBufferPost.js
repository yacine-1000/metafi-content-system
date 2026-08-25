'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '../..');
const BUFFER_API_URL = 'https://api.buffer.com';
const BUFFER_REQUEST_TIMEOUT_MS = 10_000;
const BUFFER_MAX_RETRIES = 3;
const BUFFER_RETRY_BACKOFF_MS = 250;
const BUFFER_RECOVERY_WINDOW_MS = 60_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (['--post', '--date', '--time', '--timezone'].includes(argv[i])) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON: ${filePath}`);
  }
}

function readApiKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) throw new Error(`Missing .env file: ${envPath}`);
  const env = dotenv.parse(fs.readFileSync(envPath));
  if (!env.BUFFER_API_KEY || !env.BUFFER_API_KEY.trim()) {
    throw new Error('Missing required .env variable: BUFFER_API_KEY');
  }
  return env.BUFFER_API_KEY.trim();
}

function localDateTimeToUtc(date, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must use YYYY-MM-DD');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('--time must use HH:mm');

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('--date is not a valid calendar date');
  }

  const requestedUtcFields = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = requestedUtcFields;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const displayedUtcFields = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += requestedUtcFields - displayedUtcFields;
  }

  const displayed = Object.fromEntries(
    formatter.formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  if (displayed.year !== year || displayed.month !== month || displayed.day !== day
    || displayed.hour !== hour || displayed.minute !== minute) {
    throw new Error(`The selected local date/time does not exist in timezone ${timeZone}`);
  }
  return new Date(instant).toISOString();
}

function orderedMedia(manifest) {
  if (manifest.status !== 'uploaded') throw new Error('r2-upload.json status must be "uploaded"');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('r2-upload.json contains no media files');
  }
  const media = manifest.files.map((file, index) => {
    if (!Number.isInteger(file.slide_number)) {
      throw new Error(`r2-upload.json files[${index}] has an invalid slide_number`);
    }
    let url;
    try {
      url = new URL(file.public_url);
    } catch {
      throw new Error(`r2-upload.json files[${index}] has an invalid public_url`);
    }
    if (url.protocol !== 'https:') throw new Error(`r2-upload.json files[${index}] public_url must use HTTPS`);
    return { slideNumber: file.slide_number, publicUrl: file.public_url };
  }).sort((a, b) => a.slideNumber - b.slideNumber);

  if (new Set(media.map((item) => item.publicUrl)).size !== media.length) {
    throw new Error('r2-upload.json contains duplicate public URLs');
  }
  return media;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(filePath, value, writeFileSync = fs.writeFileSync) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function persistBufferMetadata(metadataPath, manifest, writeFileSync) {
  if (!fs.existsSync(metadataPath)) return;
  const metadata = readJson(metadataPath, 'metadata.json');
  metadata.buffer_status = manifest.scheduling_type === 'notification' ? 'notification_scheduled' : 'scheduled';
  metadata.buffer_post_id = manifest.buffer_scheduled_post_id;
  metadata.scheduled_at = manifest.scheduled_at;
  metadata.scheduling_type = manifest.scheduling_type;
  metadata.timezone = manifest.timezone;
  metadata.buffer_scheduled_post_id = manifest.buffer_scheduled_post_id;
  writeJson(metadataPath, metadata, writeFileSync);
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

async function bufferQuery(apiKey, fetchImpl, query, variables = {}) {
  const response = await fetchImpl(BUFFER_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Buffer recovery lookup returned a non-JSON response with HTTP ${response.status}`);
  }
  if (!response.ok || (Array.isArray(payload.errors) && payload.errors.length)) {
    throw new Error(`Buffer recovery lookup failed${payload.errors?.length ? `: ${payload.errors.map((error) => error.message).join('; ')}` : ` with HTTP ${response.status}`}`);
  }
  return payload.data;
}

function matchesScheduledPost(post, input) {
  if (post.channelId !== input.channelId || post.dueAt !== input.dueAt || post.text !== input.text) return false;
  const expectedAssets = (input.assets || []).map((asset) => asset.image?.url || asset.video?.url || asset.document?.url || asset.link?.url);
  const actualAssets = (post.assets || []).map((asset) => asset.source);
  return expectedAssets.length === actualAssets.length
    && expectedAssets.every((url, index) => url === actualAssets[index]);
}

async function findScheduledPostForRecovery(apiKey, input, { fetchImpl = globalThis.fetch } = {}) {
  const organizations = (await bufferQuery(apiKey, fetchImpl, `
    query BufferOrganizations { account { organizations { id } } }
  `)).account?.organizations || [];
  const dueAt = new Date(input.dueAt).getTime();
  const variables = {
    start: new Date(dueAt - BUFFER_RECOVERY_WINDOW_MS).toISOString(),
    end: new Date(dueAt + BUFFER_RECOVERY_WINDOW_MS).toISOString(),
  };
  const matches = [];
  for (const organization of organizations) {
    const data = await bufferQuery(apiKey, fetchImpl, `
      query ScheduledPostsForRecovery($organizationId: OrganizationId!, $channelId: ChannelId!, $start: DateTime!, $end: DateTime!) {
        posts(first: 20, input: {
          organizationId: $organizationId,
          filter: { status: [scheduled], channelIds: [$channelId], dueAt: { start: $start, end: $end } },
          sort: [{ field: dueAt, direction: asc }]
        }) {
          edges { node { id channelId dueAt text status assets { source } } }
        }
      }
    `, { ...variables, organizationId: organization.id, channelId: input.channelId });
    matches.push(...(data.posts?.edges || []).map((edge) => edge.node).filter((post) => matchesScheduledPost(post, input)));
  }
  if (matches.length > 1) throw new Error('Buffer recovery found multiple matching scheduled posts');
  return matches[0] || null;
}

async function createScheduledPost(apiKey, input, {
  fetchImpl = globalThis.fetch,
  timeoutMs = BUFFER_REQUEST_TIMEOUT_MS,
  maxRetries = BUFFER_MAX_RETRIES,
  backoffMs = BUFFER_RETRY_BACKOFF_MS,
  findScheduledPost = (request) => findScheduledPostForRecovery(apiKey, request, { fetchImpl }),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response;
    try {
      response = await fetchImpl(BUFFER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: `
        mutation CreateScheduledPost($input: CreatePostInput!) {
          createPost(input: $input) {
            __typename
            ... on PostActionSuccess {
              post {
                id
                text
                status
                dueAt
                sentAt
                channelId
                channelService
                shareMode
                assets { source }
              }
            }
            ... on MutationError { message }
          }
        }
      `,
      variables: { input },
    }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const requestError = timedOut ? new Error('Buffer API request timed out') : error;
      const recoveredPost = await findScheduledPost(input);
      if (recoveredPost) return recoveredPost;
      if (attempt < maxRetries) {
        await delay(backoffMs * (2 ** attempt));
        continue;
      }
      throw requestError;
    }
    clearTimeout(timeout);

    if (isRetryableStatus(response.status)) {
      if (attempt < maxRetries) {
        await delay(backoffMs * (2 ** attempt));
        continue;
      }
      throw new Error(`Buffer API request failed with HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Buffer API returned a non-JSON response with HTTP ${response.status}`);
    }
    if (response.status === 401 || response.status === 403) throw new Error('Buffer authentication failed');
    if (!response.ok) throw new Error(`Buffer API request failed with HTTP ${response.status}`);
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`Buffer GraphQL error: ${payload.errors.map((error) => error.message).join('; ')}`);
    }
    const result = payload.data?.createPost;
    if (!result) throw new Error('Buffer createPost returned no result');
    if (result.__typename !== 'PostActionSuccess') {
      throw new Error(`Buffer scheduling failed: ${result.message || result.__typename}`);
    }
    return result.post;
  }
}

async function scheduleBufferPost(postFolder, { date, time, timezone, channelId = null, channelName = '', schedulingType = 'automatic' }, {
  apiKey = null,
  fetchImpl = globalThis.fetch,
  writeFileSync = fs.writeFileSync,
} = {}) {
  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${postFolder}`);
  }

  const schedulePath = path.join(postFolder, 'buffer-schedule.json');
  const pendingPath = path.join(postFolder, 'buffer-schedule-pending.json');
  if (fs.existsSync(schedulePath)) {
    const existing = readJson(schedulePath, 'buffer-schedule.json');
    if (existing.buffer_scheduled_post_id) {
      if (channelId && existing.channel_id !== channelId) throw new Error('Existing Buffer schedule belongs to a different account channel');
      const existingSchedulingType = existing.scheduling_type || 'automatic';
      if (existingSchedulingType !== schedulingType) throw new Error(`Existing Buffer schedule uses ${existingSchedulingType} scheduling`);
      persistBufferMetadata(path.join(postFolder, 'metadata.json'), existing, writeFileSync);
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
      return { ...existing, already_scheduled: true };
    }
  }

  if (!['automatic', 'notification'].includes(schedulingType)) throw new Error('schedulingType must be automatic or notification');

  const dueAt = localDateTimeToUtc(date, time, timezone);
  if (new Date(dueAt).getTime() <= Date.now()) throw new Error('Scheduled date/time must be in the future');

  const connection = channelId ? {
    channel_id: channelId,
    channel_name: channelName,
    channel_service: 'tiktok',
  } : readJson(path.join(ROOT, 'config', 'buffer-connection.json'), 'Buffer connection file');
  if (String(connection.channel_service).toLowerCase() !== 'tiktok') {
    throw new Error('Saved Buffer channel service must be "tiktok"');
  }
  if (!connection.channel_id) throw new Error('Buffer connection file is missing channel_id');

  if (schedulingType === 'automatic') {
    const draft = readJson(path.join(postFolder, 'buffer-draft.json'), 'Buffer draft manifest');
    if (!draft.buffer_post_id || draft.status !== 'draft') {
      throw new Error('buffer-draft.json must contain an existing Buffer draft ID');
    }
  }
  const media = orderedMedia(readJson(path.join(postFolder, 'r2-upload.json'), 'R2 upload manifest'));
  const captionPath = path.join(postFolder, 'caption.txt');
  if (!fs.existsSync(captionPath)) throw new Error(`Caption file is missing: ${captionPath}`);
  const caption = fs.readFileSync(captionPath, 'utf8');

  const schedulingInput = {
    channelId: connection.channel_id,
    schedulingType,
    mode: 'customScheduled',
    dueAt,
    text: caption,
    assets: media.map((item) => ({ image: { url: item.publicUrl } })),
  };
  const key = apiKey || readApiKey();
  let bufferPost = null;
  if (fs.existsSync(pendingPath)) {
    bufferPost = await findScheduledPostForRecovery(key, schedulingInput, { fetchImpl });
  }
  if (!bufferPost) {
    writeJson(pendingPath, {
      provider: 'buffer', post_id: path.basename(postFolder), channel_id: connection.channel_id,
      due_at: dueAt, text: caption, media_urls: media.map((item) => item.publicUrl), created_at: new Date().toISOString(),
    }, writeFileSync);
    bufferPost = await createScheduledPost(key, schedulingInput, { fetchImpl });
  }
  const returnedUrls = (bufferPost.assets || []).map((asset) => asset.source);
  const requestedUrls = media.map((item) => item.publicUrl);

  if (!bufferPost.id) throw new Error('Buffer schedule response is missing the post ID');
  if (!['scheduled', 'buffer'].includes(bufferPost.status)) {
    throw new Error(`Buffer post status is not scheduled: ${bufferPost.status}`);
  }
  if (bufferPost.channelId !== connection.channel_id) throw new Error('Buffer post was scheduled on an unexpected channel');
  if (String(bufferPost.channelService).toLowerCase() !== 'tiktok') throw new Error('Buffer scheduled post service is not TikTok');
  if (bufferPost.text !== caption) throw new Error('Buffer scheduled caption does not exactly match caption.txt');
  if (bufferPost.sentAt != null) throw new Error('Buffer post was unexpectedly published');
  if (new Date(bufferPost.dueAt).getTime() !== new Date(dueAt).getTime()) {
    throw new Error('Buffer scheduled time does not match the requested dueAt');
  }
  if (returnedUrls.length !== requestedUrls.length || returnedUrls.some((url, index) => url !== requestedUrls[index])) {
    throw new Error('Buffer scheduled media does not match the requested image order');
  }

  const manifest = {
    provider: 'buffer',
    post_id: path.basename(postFolder),
    channel_id: connection.channel_id,
    channel_name: connection.channel_name,
    created_at: new Date().toISOString(),
    scheduled_at: dueAt,
    timezone,
    status: 'scheduled',
    scheduling_type: schedulingType,
    buffer_scheduled_post_id: bufferPost.id,
    media_count: media.length,
    caption,
  };
  writeJson(schedulePath, manifest, writeFileSync);

  persistBufferMetadata(path.join(postFolder, 'metadata.json'), manifest, writeFileSync);
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const name of ['post', 'date', 'time', 'timezone']) {
    if (!args[name]) throw new Error(`Missing required argument: --${name}`);
  }
  const postFolder = path.isAbsolute(args.post) ? args.post : path.resolve(ROOT, args.post);
  const result = await scheduleBufferPost(postFolder, args);
  if (result.already_scheduled) {
    console.log(`Post is already scheduled as Buffer post ${result.buffer_scheduled_post_id}`);
    return;
  }
  console.log(`Scheduled Buffer post ${result.buffer_scheduled_post_id} for ${result.scheduled_at} (${result.timezone})`);
  console.log(`Saved ${path.relative(ROOT, path.join(postFolder, 'buffer-schedule.json'))}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Buffer scheduling failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { scheduleBufferPost, createScheduledPost, findScheduledPostForRecovery, localDateTimeToUtc };
