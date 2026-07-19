'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '../..');
const BUFFER_API_URL = 'https://api.buffer.com';

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--post') {
      args.post = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--force') {
      args.force = true;
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
    if (url.protocol !== 'https:') {
      throw new Error(`r2-upload.json files[${index}] public_url must use HTTPS`);
    }
    return { slideNumber: file.slide_number, publicUrl: file.public_url };
  }).sort((a, b) => a.slideNumber - b.slideNumber);

  if (new Set(media.map((item) => item.publicUrl)).size !== media.length) {
    throw new Error('r2-upload.json contains duplicate public URLs');
  }
  return media;
}

async function createDraft(apiKey, input) {
  const response = await fetch(BUFFER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: `
        mutation CreateDraftPost($input: CreatePostInput!) {
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
                assets {
                  source
                }
              }
            }
            ... on MutationError {
              message
            }
          }
        }
      `,
      variables: { input },
    }),
  });

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
    throw new Error(`Buffer draft creation failed: ${result.message || result.__typename}`);
  }
  return result.post;
}

async function createBufferDraft(postFolder, { force = false, channelId = null, channelName = '' } = {}) {
  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${postFolder}`);
  }

  const draftPath = path.join(postFolder, 'buffer-draft.json');
  if (fs.existsSync(draftPath) && !force) {
    const existing = readJson(draftPath, 'buffer-draft.json');
    if (existing.buffer_post_id) {
      throw new Error('buffer-draft.json already contains a Buffer post ID; use --force to create another draft');
    }
  }

  const connection = channelId ? {
    channel_id: channelId,
    channel_name: channelName,
    channel_service: 'tiktok',
  } : readJson(path.join(ROOT, 'config', 'buffer-connection.json'), 'Buffer connection file');
  if (String(connection.channel_service).toLowerCase() !== 'tiktok') {
    throw new Error('Saved Buffer channel service must be "tiktok"');
  }
  if (!connection.channel_id) throw new Error('Buffer connection file is missing channel_id');

  const r2Manifest = readJson(path.join(postFolder, 'r2-upload.json'), 'R2 upload manifest');
  const media = orderedMedia(r2Manifest);
  const captionPath = path.join(postFolder, 'caption.txt');
  if (!fs.existsSync(captionPath)) throw new Error(`Caption file is missing: ${captionPath}`);
  const caption = fs.readFileSync(captionPath, 'utf8');
  const apiKey = readApiKey();

  const input = {
    channelId: connection.channel_id,
    schedulingType: 'automatic',
    mode: 'addToQueue',
    saveToDraft: true,
    text: caption,
    assets: media.map((item) => ({ image: { url: item.publicUrl } })),
  };
  const bufferPost = await createDraft(apiKey, input);
  const returnedUrls = (bufferPost.assets || []).map((asset) => asset.source);
  const requestedUrls = media.map((item) => item.publicUrl);

  if (!bufferPost.id) throw new Error('Buffer draft response is missing the post ID');
  if (bufferPost.status !== 'draft') throw new Error(`Buffer post status is not draft: ${bufferPost.status}`);
  if (bufferPost.channelId !== connection.channel_id) throw new Error('Buffer draft was created on an unexpected channel');
  if (String(bufferPost.channelService).toLowerCase() !== 'tiktok') throw new Error('Buffer draft service is not TikTok');
  if (bufferPost.text !== caption) throw new Error('Buffer draft caption does not exactly match caption.txt');
  if (bufferPost.dueAt != null || bufferPost.sentAt != null) throw new Error('Buffer draft was unexpectedly scheduled or published');
  if (returnedUrls.length !== requestedUrls.length || returnedUrls.some((url, index) => url !== requestedUrls[index])) {
    throw new Error('Buffer draft media does not match the requested image order');
  }

  const localManifest = {
    provider: 'buffer',
    post_id: path.basename(postFolder),
    channel_id: connection.channel_id,
    channel_name: connection.channel_name,
    created_at: new Date().toISOString(),
    status: 'draft',
    buffer_post_id: bufferPost.id,
    media_count: media.length,
    caption,
  };
  fs.writeFileSync(draftPath, JSON.stringify(localManifest, null, 2), 'utf8');

  const metadataPath = path.join(postFolder, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    const metadata = readJson(metadataPath, 'metadata.json');
    const hasBufferWorkflow = Object.prototype.hasOwnProperty.call(metadata, 'buffer_status')
      || Object.prototype.hasOwnProperty.call(metadata, 'buffer_post_id');
    if (hasBufferWorkflow) {
      metadata.buffer_status = 'draft_created';
      metadata.buffer_post_id = bufferPost.id;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    }
  }

  return localManifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.post) throw new Error('Missing required argument: --post outputs/posts/{post_id}');
  const postFolder = path.isAbsolute(args.post) ? args.post : path.resolve(ROOT, args.post);
  const localManifest = await createBufferDraft(postFolder, { force: args.force });

  console.log(`Created Buffer draft ${localManifest.buffer_post_id} for TikTok channel "${localManifest.channel_name}" with ${localManifest.media_count} images`);
  console.log(`Saved ${path.relative(ROOT, path.join(postFolder, 'buffer-draft.json'))}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Buffer draft creation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createBufferDraft };
