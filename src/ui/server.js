'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { persistenceMode } = require('../persistence/serverSupabaseClient');
const { PortalSupabaseService } = require('../persistence/portalSupabaseService');
const { createPostMetadata, createPublishPackage, markUploadSuccess, markUploadFailed } = require('../lib/postMetadata');
const { upsertContentPost } = require('../lib/supabasePostStore');
const { generateSlideshows } = require('../generation/generateSlideshows');
const { uploadPostToR2 } = require('../generation/uploadToR2');
const { createBufferDraft } = require('../generation/createBufferDraft');
const { scheduleBufferPost, localDateTimeToUtc } = require('../generation/scheduleBufferPost');
const {
  CampaignConflictError,
  CampaignValidationError,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  resolveCampaignAccount,
  updateCampaign,
} = require('../campaigns/campaignService');
const { CampaignPlannerError, planCampaign } = require('../campaigns/campaignPlanner');
const { CampaignExecutionError, executeCampaignWindow, retryBufferNotificationPost, sendUploadedCampaignPostsToBuffer, uploadApprovedCampaignPosts } = require('../campaigns/campaignExecutor');
const { CampaignSwapError, swapCampaignPost } = require('../campaigns/campaignSwapService');
const { PublicationValidationError, markPostPosted, readPublicationHistory } = require('../publication/publicationService');
const {
  AccountConflictError,
  AccountValidationError,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
  updateAccountAvatar,
} = require('../accounts/accountService');
const { discoverBufferTikTokChannels } = require('../generation/connectBuffer');
const { createScriptLibraryWriteService } = require('../injection/scriptLibraryWriteService');
const { createInjectionRequestStore } = require('../injection/injectionRequestStore');
const { createApprovedTaxonomyService } = require('../injection/approvedTaxonomyService');
const { createInjectionHandlers } = require('../injection/injectionApi');

const ROOT = path.resolve(__dirname, '../../');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const RENDERS_DIR = path.join(ROOT, 'renders');
const RAW_SOURCE_PATH = path.join(ROOT, 'test-inputs', 'raw-source.txt');
const MANUAL_INPUT_PATH = path.join(ROOT, 'test-inputs', 'manual-input.json');
const POSTS_DIR = path.join(ROOT, 'outputs', 'posts');

function isSupabaseMode() { return persistenceMode(process.env) === 'supabase'; }
function portalRepository() { return new PortalSupabaseService(process.env); }

function quickSavePostDir(campaignId, postId) {
  const postDir = safePostFolder(postId);
  if (!postDir || !fs.existsSync(postDir)) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(postDir, 'metadata.json'), 'utf8'));
    return metadata.campaign_id === campaignId ? { postDir, metadata } : null;
  } catch { return null; }
}

function quickSaveData(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  const planPath = path.join(ROOT, 'data', 'campaigns', `${campaignId}-plan.json`);
  if (!fs.existsSync(planPath)) return { campaign, posts: [] };
  const publications = new Map(readPublicationHistory().publications.map((item) => [item.post_id, item]));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const posts = (plan.slots || []).filter((slot) => slot && slot.post_id).map((slot) => {
    const found = quickSavePostDir(campaignId, slot.post_id);
    if (!found || !found.metadata.statuses || found.metadata.statuses.generation !== 'completed') return null;
    const pkgPath = path.join(found.postDir, 'publish-package.json');
    let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch {}
    const rendered = path.join(found.postDir, 'rendered');
    const slides = fs.existsSync(rendered) ? fs.readdirSync(rendered).filter((name) => /^slide-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
    return { post_id: slot.post_id, scheduled_date: slot.date, scheduled_time: slot.time, language: found.metadata.language, account_handle: campaign.account_username || campaign.account_internal_name || '', saved_at: found.metadata.saved_at || null, publication: publications.get(slot.post_id) || null, first_slide_text: pkg.slides?.[0]?.text || pkg.hook_text || '', caption: fs.existsSync(path.join(found.postDir, 'caption.txt')) ? fs.readFileSync(path.join(found.postDir, 'caption.txt'), 'utf8') : (pkg.caption || ''), slide_urls: slides.map((name) => `/outputs/posts/${encodeURIComponent(slot.post_id)}/rendered/${encodeURIComponent(name)}`) };
  }).filter(Boolean).sort((a, b) => `${a.scheduled_date} ${a.scheduled_time}`.localeCompare(`${b.scheduled_date} ${b.scheduled_time}`));
  return { campaign_id: campaignId, posts };
}

function createInjectionRouter(options = {}) {
  const router = express.Router();
  const handlers = createInjectionHandlers({
    writeService: options.writeService || createScriptLibraryWriteService(),
    taxonomyService: options.taxonomyService || createApprovedTaxonomyService(),
    requestStore: options.requestStore || createInjectionRequestStore(),
    getCampaign: options.getCampaign || getCampaign,
    listCampaigns: options.listCampaigns || listCampaigns,
  });
  router.get('/taxonomy', handlers.taxonomy);
  router.get('/source-sets', handlers.sourceSets);
  router.get('/available-source-sets', handlers.availableSourceSets);
  router.post('/source-sets', handlers.createSourceSet);
  router.get('/campaigns', handlers.activeCampaigns);
  router.get('/requests', handlers.requests);
  router.post('/campaign-requests', handlers.createCampaignRequest);
  return router;
}

const PIPELINE = ['intake', 'planning', 'hook', 'body', 'final-slide', 'assembly:build', 'assemble:test', 'caption', 'strategy-check'];

const STRATEGY_DEFAULTS = {
  sprint_phase: 'days_1_15_find_signal',
  cta_goal: 'comments',
  expected_signal: '',
};

function computeBufferReadiness(statuses) {
  const s = statuses || {};
  if (s.buffer === 'scheduled') return 'scheduled';
  if (s.buffer === 'draft_created') return 'draft_created';
  if (s.review !== 'approved') return 'not_ready_review_required';
  if (s.upload !== 'uploaded') return 'not_ready_upload_required';
  if (s.buffer === 'sent') return 'sent_to_buffer';
  return 'ready_for_buffer';
}

function computeReadiness(statuses) {
  const s = statuses || {};
  if (s.review !== 'approved') return 'not_ready_review_required';
  if (s.upload === 'uploaded') return 'already_uploaded';
  if (s.upload === 'failed') return 'ready_to_retry_upload';
  return 'ready_to_upload';
}

function resolveStatuses(meta, pkgStatuses) {
  let statuses;
  if (meta && meta.statuses) statuses = { ...meta.statuses };
  else if (pkgStatuses) statuses = { ...pkgStatuses };
  else {
    const s = (meta && meta.status) || 'unknown';
    statuses = {
      generation: (s === 'generated' || s === 'uploaded' || s === 'upload_failed') ? 'completed' : 'unknown',
      review: 'unknown',
      upload: s === 'uploaded' ? 'uploaded' : s === 'upload_failed' ? 'failed' : 'unknown',
      buffer: 'unknown',
      publish: 'unknown',
    };
  }
  if (meta && meta.buffer_status === 'scheduled') {
    statuses.buffer = 'scheduled';
  } else if (meta && (meta.buffer_status === 'draft_created' || meta.buffer_post_id)) {
    statuses.buffer = 'draft_created';
  }
  return statuses;
}

function safePostFolder(postId) {
  if (typeof postId !== 'string' || !/^post-[A-Za-z0-9_-]+$/.test(postId)) return null;
  const postDir = path.resolve(POSTS_DIR, postId);
  return path.dirname(postDir) === path.resolve(POSTS_DIR) ? postDir : null;
}

function postBufferChannelError(postDir) {
  const metadataPath = path.join(postDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.account_id) return null;
    const account = getAccount(metadata.account_id);
    if (account && !account.buffer_channel_id) return 'Post account has no Buffer channel configured';
  } catch {
    return null;
  }
  return null;
}

function renderedImageCount(postDir) {
  const renderedDir = path.join(postDir, 'rendered');
  if (!fs.existsSync(renderedDir) || !fs.statSync(renderedDir).isDirectory()) return 0;
  return fs.readdirSync(renderedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name)).length;
}

function savePostFolder(strategy_metadata) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const postId = `post-${stamp}`;
  const postDir = path.join(ROOT, 'outputs', 'posts', postId);
  const slidesDir = path.join(postDir, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });

  const copies = [
    [path.join(ROOT, 'test-inputs', 'manual-input.json'),          path.join(postDir, 'source.json')],
    [path.join(ROOT, 'test-outputs', 'cleanedSourceBrief.json'),   path.join(postDir, 'cleanedSourceBrief.json')],
    [path.join(ROOT, 'test-outputs', 'sliderPlan.json'),           path.join(postDir, 'sliderPlan.json')],
    [path.join(ROOT, 'test-outputs', 'hookOutput.json'),           path.join(postDir, 'hookOutput.json')],
    [path.join(ROOT, 'test-outputs', 'bodyOutput.json'),           path.join(postDir, 'bodyOutput.json')],
    [path.join(ROOT, 'test-outputs', 'finalSlideOutput.json'),     path.join(postDir, 'finalSlideOutput.json')],
    [path.join(ROOT, 'test-inputs', 'assembly-config.json'),       path.join(postDir, 'assembly-config.json')],
    [path.join(ROOT, 'test-outputs', 'captionOutput.json'),        path.join(postDir, 'captionOutput.json')],
  ];
  for (const [src, dest] of copies) {
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  }

  for (let i = 1; i <= 5; i++) {
    const src = path.join(ROOT, 'renders', `slide-${i}.png`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(slidesDir, `slide-${i}.png`));
  }

  // caption.txt and publish-package.json from captionOutput
  let caption = '';
  let hashtags = [];
  const captionOutputPath = path.join(ROOT, 'test-outputs', 'captionOutput.json');
  if (fs.existsSync(captionOutputPath)) {
    try {
      const captionData = JSON.parse(fs.readFileSync(captionOutputPath, 'utf8'));
      caption = captionData.caption || '';
      hashtags = Array.isArray(captionData.hashtags) ? captionData.hashtags : [];
    } catch {}
  }

  const captionTxtPath = path.join(postDir, 'caption.txt');
  fs.writeFileSync(captionTxtPath, `${caption}\n\n${hashtags.join(' ')}`, 'utf8');

  const createdAt = now.toISOString();

  let strategyCheck = null;
  const strategyCheckPath = path.join(ROOT, 'test-outputs', 'strategyCheck.json');
  if (fs.existsSync(strategyCheckPath)) {
    try { strategyCheck = JSON.parse(fs.readFileSync(strategyCheckPath, 'utf8')); } catch {}
  }

  const metadata = { ...createPostMetadata({ postId, createdAt, slideCount: 5, strategyCheck }), strategy_metadata };
  fs.writeFileSync(path.join(postDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  const pkg = { ...createPublishPackage({ postId, caption, hashtags, createdAt, slideCount: 5, strategyCheck }), strategy_metadata };
  fs.writeFileSync(path.join(postDir, 'publish-package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  return { postId, metadata, pkg, postDir };
}

async function uploadPost(postId, log) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_BUCKET) {
    throw new Error('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const postDir = path.join(ROOT, 'outputs', 'posts', postId);
  const bucket = SUPABASE_BUCKET;
  const slideFiles = ['slide-1.png', 'slide-2.png', 'slide-3.png', 'slide-4.png', 'slide-5.png'];

  const uploads = [
    ...slideFiles.map((f) => ({
      local: path.join(postDir, 'slides', f),
      remote: `posts/${postId}/slides/${f}`,
      contentType: 'image/png',
    })),
    { local: path.join(postDir, 'caption.txt'),          remote: `posts/${postId}/caption.txt`,          contentType: 'text/plain' },
    { local: path.join(postDir, 'publish-package.json'), remote: `posts/${postId}/publish-package.json`, contentType: 'application/json' },
  ];

  for (const { local, remote, contentType } of uploads) {
    const body = fs.readFileSync(local);
    const { error } = await supabase.storage.from(bucket).upload(remote, body, { contentType, upsert: true });
    if (error) throw new Error(`Upload failed for ${remote}: ${error.message}`);
    log(`✓ ${remote}\n`);
  }

  const uploadedAt = new Date().toISOString();
  const slideUrls = slideFiles.map((f) =>
    `${SUPABASE_URL}/storage/v1/object/public/${bucket}/posts/${postId}/slides/${f}`
  );
  const captionUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/posts/${postId}/caption.txt`;

  const uploadInput = { uploadedAt, bucket, basePath: `posts/${postId}`, slideUrls, captionUrl };

  const pkgPath = path.join(postDir, 'publish-package.json');
  const updatedPkg = markUploadSuccess(JSON.parse(fs.readFileSync(pkgPath, 'utf8')), uploadInput);
  fs.writeFileSync(pkgPath, JSON.stringify(updatedPkg, null, 2));

  const metaPath = path.join(postDir, 'metadata.json');
  const updatedMeta = markUploadSuccess(JSON.parse(fs.readFileSync(metaPath, 'utf8')), uploadInput);
  fs.writeFileSync(metaPath, JSON.stringify(updatedMeta, null, 2));

  const dbr = await upsertContentPost({ postId, metadata: updatedMeta, publishPackage: updatedPkg, localPath: postDir, sourceType: 'portal' });
  if (!dbr.skipped && !dbr.ok) console.warn(`[db] upload sync failed for ${postId}:`, dbr.error);
}

const app = express();
app.use(express.json());
app.use('/api/injection', createInjectionRouter());
app.use('/renders', express.static(RENDERS_DIR));
app.use('/outputs', express.static(path.join(ROOT, 'outputs')));
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use(express.static(path.join(__dirname)));

const HOOK_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const APP_CTA_LANGUAGES = Object.freeze(['ar', 'en', 'es', 'fr']);

function accountForAssetRequest(accountId) {
  if (accountId === 'account_1') return resolveCampaignAccount(accountId);
  return getAccount(accountId);
}

function imageFilesIn(folder, urlPrefix) {
  return fs.existsSync(folder) && fs.statSync(folder).isDirectory()
    ? fs.readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && HOOK_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .map((filename) => ({ filename, url: `${urlPrefix}/${filename}` }))
    : [];
}

function accountWithHookBank(account) {
  if (!account) return account;
  const hookDir = path.join(ROOT, 'assets', 'account-hook-images', account.account_id);
  const hookImages = imageFilesIn(hookDir, `/assets/account-hook-images/${account.account_id}`);
  const appCtaBanks = Object.fromEntries(APP_CTA_LANGUAGES.map((language) => {
    const folder = path.join(ROOT, 'assets', 'account-app-cta-images', account.account_id, language);
    const images = imageFilesIn(folder, `/assets/account-app-cta-images/${account.account_id}/${language}`);
    return [language, { image_count: images.length, images }];
  }));
  return { ...account, hook_image_count: hookImages.length, hook_images: hookImages, app_cta_banks: appCtaBanks };
}

app.get('/api/accounts', async (_req, res) => {
  try {
    if (isSupabaseMode()) return res.json(await portalRepository().listAccounts());
    return res.json(listAccounts().map(accountWithHookBank));
  } catch (error) {
    console.error(`[accounts] list failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to read accounts' });
  }
});

app.get('/api/accounts/:accountId', async (req, res) => {
  try {
    if (isSupabaseMode()) { const account = await portalRepository().getAccount(req.params.accountId); return account ? res.json(account) : res.status(404).json({ error: 'Account not found' }); }
    const account = getAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    return res.json(accountWithHookBank(account));
  } catch (error) {
    if (error instanceof AccountValidationError) return res.status(400).json({ error: error.message });
    console.error(`[accounts] read failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to read account' });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    if (isSupabaseMode()) return res.status(201).json(await portalRepository().createAccount(req.body));
    return res.status(201).json(accountWithHookBank(createAccount(req.body)));
  } catch (error) {
    if (error instanceof AccountValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof AccountConflictError || error.code === 'EEXIST') return res.status(409).json({ error: error.message });
    console.error(`[accounts] creation failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to create account' });
  }
});

const AVATAR_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function avatarExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const parseAvatar = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' });

app.post('/api/accounts/:accountId/avatar', (req, res, next) => {
  parseAvatar(req, res, (error) => {
    if (!error) return next();
    return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.type === 'entity.too.large' ? 'Avatar image is too large' : 'Invalid avatar upload' });
  });
}, async (req, res) => {
  try {
    const account = getAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const declaredExtension = AVATAR_TYPES.get(String(req.headers['content-type'] || '').split(';')[0].toLowerCase());
    const detectedExtension = Buffer.isBuffer(req.body) ? avatarExtension(req.body) : null;
    if (!declaredExtension || !detectedExtension || declaredExtension !== detectedExtension) return res.status(415).json({ error: 'Avatar must be a JPG, JPEG, PNG, or WEBP image' });
    if (isSupabaseMode()) {
      const asset = await portalRepository().uploadAccountAsset(account.account_id, 'profile', null, req.body, String(req.headers['content-type']).split(';')[0], `avatar.${detectedExtension}`);
      return res.json({ account_id: account.account_id, avatar_path: asset.storage_key, avatar_url: asset.url });
    }
    const avatarDir = path.join(ROOT, 'assets', 'account-avatars', account.account_id);
    fs.mkdirSync(avatarDir, { recursive: true });
    const filename = `avatar.${detectedExtension}`;
    const target = path.join(avatarDir, filename);
    const temporary = path.join(avatarDir, `.avatar-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(temporary, req.body, { flag: 'wx' });
    fs.copyFileSync(temporary, target);
    fs.unlinkSync(temporary);
    for (const entry of fs.readdirSync(avatarDir)) {
      if (/^avatar\.(?:jpg|jpeg|png|webp)$/i.test(entry) && entry !== filename) fs.unlinkSync(path.join(avatarDir, entry));
    }
    const updated = updateAccountAvatar(account.account_id, `/assets/account-avatars/${account.account_id}/${filename}`);
    return res.json({ account_id: updated.account_id, avatar_path: updated.avatar_path });
  } catch (error) {
    if (error instanceof AccountValidationError) return res.status(400).json({ error: error.message });
    console.error(`[accounts] avatar upload failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to upload avatar' });
  }
});

app.post('/api/accounts/:accountId/hook-images', (req, res, next) => {
  parseAvatar(req, res, (error) => {
    if (!error) return next();
    return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.type === 'entity.too.large' ? 'Character hook image is too large' : 'Invalid character hook image upload' });
  });
}, async (req, res) => {
  try {
    const account = getAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const declaredExtension = AVATAR_TYPES.get(String(req.headers['content-type'] || '').split(';')[0].toLowerCase());
    const detectedExtension = Buffer.isBuffer(req.body) ? avatarExtension(req.body) : null;
    if (!declaredExtension || !detectedExtension || declaredExtension !== detectedExtension) {
      return res.status(415).json({ error: 'Character hook image must be JPG, JPEG, PNG, or WEBP' });
    }
    if (isSupabaseMode()) {
      const filename = `hook-${Date.now()}-${process.hrtime.bigint()}.${detectedExtension}`;
      const asset = await portalRepository().uploadAccountAsset(account.account_id, 'hook', null, req.body, String(req.headers['content-type']).split(';')[0], filename);
      return res.status(201).json({ account_id: account.account_id, filename, asset_path: asset.storage_key, url: asset.url });
    }
    const hookDir = path.join(ROOT, 'assets', 'account-hook-images', account.account_id);
    fs.mkdirSync(hookDir, { recursive: true });
    const filename = `hook-${Date.now()}-${process.hrtime.bigint()}.${detectedExtension}`;
    const target = path.join(hookDir, filename);
    const temporary = path.join(hookDir, `.${filename}.tmp`);
    fs.writeFileSync(temporary, req.body, { flag: 'wx' });
    fs.renameSync(temporary, target);
    return res.status(201).json({
      account_id: account.account_id,
      filename,
      asset_path: `/assets/account-hook-images/${account.account_id}/${filename}`,
    });
  } catch (error) {
    if (error instanceof AccountValidationError) return res.status(400).json({ error: error.message });
    console.error(`[accounts] character hook upload failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to upload character hook image' });
  }
});

app.delete('/api/accounts/:accountId/hook-images/:filename', (req, res) => {
  try {
    const account = getAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const filename = String(req.params.filename || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\.(?:png|jpg|jpeg|webp)$/i.test(filename)
      || filename.includes('..') || path.basename(filename) !== filename) {
      return res.status(400).json({ error: 'Invalid hook image filename' });
    }
    const hookDir = path.resolve(ROOT, 'assets', 'account-hook-images', account.account_id);
    const target = path.resolve(hookDir, filename);
    if (path.dirname(target) !== hookDir) return res.status(400).json({ error: 'Invalid hook image filename' });
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'Hook image not found' });
    fs.unlinkSync(target);
    return res.json({ account_id: account.account_id, filename, status: 'deleted' });
  } catch (error) {
    if (error instanceof AccountValidationError) return res.status(400).json({ error: error.message });
    console.error(`[accounts] character hook delete failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to delete character hook image' });
  }
});

app.post('/api/accounts/:accountId/app-cta-images/:language', (req, res, next) => {
  parseAvatar(req, res, (error) => {
    if (!error) return next();
    return res.status(error.type === 'entity.too.large' ? 413 : 400).json({
      error: error.type === 'entity.too.large' ? 'App CTA image is too large' : 'Invalid App CTA image upload',
      uploaded_files: [],
      rejected_files: [{ error: error.type === 'entity.too.large' ? 'File is too large' : 'Invalid image upload' }],
    });
  });
}, async (req, res) => {
  try {
    const account = accountForAssetRequest(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found', uploaded_files: [], rejected_files: [] });
    const language = String(req.params.language || '').toLowerCase();
    if (!APP_CTA_LANGUAGES.includes(language)) {
      return res.status(400).json({ error: 'App CTA language must be ar, en, es, or fr', uploaded_files: [], rejected_files: [] });
    }
    const declaredExtension = AVATAR_TYPES.get(String(req.headers['content-type'] || '').split(';')[0].toLowerCase());
    const detectedExtension = Buffer.isBuffer(req.body) ? avatarExtension(req.body) : null;
    if (!declaredExtension || !detectedExtension || declaredExtension !== detectedExtension) {
      return res.status(415).json({
        error: 'App CTA image must be JPG, JPEG, PNG, or WEBP and match its MIME type',
        uploaded_files: [],
        rejected_files: [{ error: 'Unsupported image or MIME mismatch' }],
      });
    }
    const ctaDir = path.join(ROOT, 'assets', 'account-app-cta-images', account.account_id, language);
    fs.mkdirSync(ctaDir, { recursive: true });
    const filename = `app-cta-${Date.now()}-${process.hrtime.bigint()}.${detectedExtension}`;
    const target = path.join(ctaDir, filename);
    const temporary = path.join(ctaDir, `.${filename}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, req.body, { flag: 'wx' });
    fs.renameSync(temporary, target);
    const refreshed = accountWithHookBank(account).app_cta_banks[language];
    const uploadedFile = {
      filename,
      url: `/assets/account-app-cta-images/${account.account_id}/${language}/${filename}`,
    };
    return res.status(201).json({
      account_id: account.account_id,
      language,
      uploaded_files: [uploadedFile],
      rejected_files: [],
      image_count: refreshed.image_count,
      images: refreshed.images,
    });
  } catch (error) {
    if (error instanceof AccountValidationError || error instanceof CampaignValidationError) {
      return res.status(400).json({ error: error.message, uploaded_files: [], rejected_files: [] });
    }
    console.error(`[accounts] App CTA upload failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to upload App CTA image', uploaded_files: [], rejected_files: [] });
  }
});

app.delete('/api/accounts/:accountId/app-cta-images/:language/:filename', (req, res) => {
  try {
    const account = accountForAssetRequest(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const language = String(req.params.language || '').toLowerCase();
    if (!APP_CTA_LANGUAGES.includes(language)) return res.status(400).json({ error: 'App CTA language must be ar, en, es, or fr' });
    const filename = String(req.params.filename || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\.(?:png|jpg|jpeg|webp)$/i.test(filename)
      || filename.includes('..') || path.basename(filename) !== filename) {
      return res.status(400).json({ error: 'Invalid App CTA image filename' });
    }
    const ctaDir = path.resolve(ROOT, 'assets', 'account-app-cta-images', account.account_id, language);
    const target = path.resolve(ctaDir, filename);
    if (path.dirname(target) !== ctaDir) return res.status(400).json({ error: 'Invalid App CTA image filename' });
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'App CTA image not found' });
    fs.unlinkSync(target);
    return res.json({ account_id: account.account_id, language, filename, status: 'deleted' });
  } catch (error) {
    if (error instanceof AccountValidationError || error instanceof CampaignValidationError) return res.status(400).json({ error: error.message });
    console.error(`[accounts] App CTA delete failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to delete App CTA image' });
  }
});

app.post('/api/accounts/refresh-buffer-channels', async (_req, res) => {
  try {
    const [channels, accounts] = await Promise.all([
      discoverBufferTikTokChannels(),
      Promise.resolve(listAccounts()),
    ]);
    const accountsByChannel = new Map(accounts.filter((account) => account.buffer_channel_id).map((account) => [account.buffer_channel_id, account]));
    const safeChannel = (channel, linkedAccountId = null) => ({
      organization_id: channel.organization_id,
      organization_name: channel.organization_name,
      channel_id: channel.channel_id,
      channel_name: channel.channel_name,
      username: channel.username,
      service: 'tiktok',
      linked_account_id: linkedAccountId,
    });
    const connectedChannels = channels.filter((channel) => !channel.is_disconnected);
    const connectedIds = new Set(connectedChannels.map((channel) => channel.channel_id));
    const linkedChannels = connectedChannels
      .filter((channel) => accountsByChannel.has(channel.channel_id))
      .map((channel) => safeChannel(channel, accountsByChannel.get(channel.channel_id).account_id));
    const unlinkedChannels = connectedChannels
      .filter((channel) => !accountsByChannel.has(channel.channel_id))
      .map((channel) => safeChannel(channel));
    const disconnectedSavedAccounts = accounts.filter((account) => account.buffer_channel_id && !connectedIds.has(account.buffer_channel_id)).map((account) => {
      const discovered = channels.find((channel) => channel.channel_id === account.buffer_channel_id);
      return {
        organization_id: discovered ? discovered.organization_id : account.buffer_organization_id,
        organization_name: discovered ? discovered.organization_name : '',
        channel_id: account.buffer_channel_id,
        channel_name: discovered ? discovered.channel_name : account.buffer_channel_name,
        username: discovered ? discovered.username : account.username,
        service: 'tiktok',
        linked_account_id: account.account_id,
      };
    });
    return res.json({
      linked_channels: linkedChannels,
      unlinked_channels: unlinkedChannels,
      disconnected_saved_accounts: disconnectedSavedAccounts,
    });
  } catch (error) {
    console.error(`[accounts] Buffer channel refresh failed: ${error.message}`);
    const status = error.message === 'Buffer authentication failed' ? 401 : 502;
    return res.status(status).json({ error: error.message === 'Buffer authentication failed' ? error.message : 'Unable to refresh Buffer channels' });
  }
});

app.patch('/api/accounts/:accountId', async (req, res) => {
  try {
    if (isSupabaseMode()) { const account = await portalRepository().updateAccount(req.params.accountId, req.body); return account ? res.json(account) : res.status(404).json({ error: 'Account not found' }); }
    const account = updateAccount(req.params.accountId, req.body);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    return res.json(accountWithHookBank(account));
  } catch (error) {
    if (error instanceof AccountValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof AccountConflictError) return res.status(409).json({ error: error.message });
    console.error(`[accounts] update failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to update account' });
  }
});

app.get('/api/campaigns', async (_req, res) => {
  try {
    if (isSupabaseMode()) return res.json(await portalRepository().listCampaigns());
    return res.json(listCampaigns());
  } catch (error) {
    if (error instanceof CampaignValidationError) return res.status(400).json({ error: error.message });
    console.error(`[campaigns] list failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to read campaigns' });
  }
});

app.get('/api/campaigns/:campaignId', async (req, res) => {
  try {
    if (isSupabaseMode()) { const campaign = await portalRepository().getCampaign(req.params.campaignId); return campaign ? res.json(campaign) : res.status(404).json({ error: 'Campaign not found' }); }
    const campaign = getCampaign(req.params.campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(campaign);
  } catch (error) {
    if (error instanceof CampaignValidationError) return res.status(400).json({ error: error.message });
    console.error(`[campaigns] read failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to read campaign' });
  }
});

app.post('/api/campaigns/:campaignId/plan', (req, res) => {
  try {
    const result = planCampaign(req.params.campaignId);
    if (!result) return res.status(404).json({ error: 'Campaign not found' });
    return res.status(result.existing ? 200 : 201).json(result.plan);
  } catch (error) {
    if (error instanceof CampaignValidationError || error instanceof CampaignPlannerError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`[campaigns] planning failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to plan campaign' });
  }
});

app.post('/api/campaigns/:campaignId/generate-window', (req, res) => {
  const startedAt = Date.now();
  const campaignId = req.params.campaignId;
  console.error(`[campaign-generation] ${new Date().toISOString()} campaign_id=${campaignId} stage=http_route event=start`);
  try {
    const summary = executeCampaignWindow(campaignId);
    if (!summary) return res.status(404).json({ error: 'Campaign not found' });
    console.error(`[campaign-generation] ${new Date().toISOString()} campaign_id=${campaignId} stage=http_route event=return elapsed_ms=${Date.now() - startedAt}`);
    return res.json(summary);
  } catch (error) {
    console.error(`[campaign-generation] ${new Date().toISOString()} campaign_id=${campaignId} stage=http_route event=error elapsed_ms=${Date.now() - startedAt} error=${JSON.stringify(error.message || String(error))}`);
    if (res.headersSent) return res.end();
    if (error instanceof CampaignValidationError || error instanceof CampaignExecutionError) {
      return res.status(400).json({
        error: error.message,
        reason: error.message,
        reason_code: error.code || (error instanceof CampaignValidationError ? 'CAMPAIGN_CONFIG_INVALID' : 'CAMPAIGN_EXECUTION_ERROR'),
        details: error.details || {},
        outcome: 'blocked',
        generated_count: 0,
        skipped_count: 0,
        failed_count: 0,
      });
    }
    console.error(`[campaigns] execution failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to execute campaign window' });
  }
});

app.post('/api/campaigns/:campaignId/slots/:slotId/swap', (req, res) => {
  try {
    const result = swapCampaignPost(req.params.campaignId, req.params.slotId);
    if (!result) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(result);
  } catch (error) {
    if (error instanceof CampaignValidationError || error instanceof CampaignExecutionError || error instanceof CampaignSwapError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`[campaigns] swap failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to swap campaign post' });
  }
});

app.post('/api/campaigns/:campaignId/upload-approved', async (req, res) => {
  try {
    const summary = await uploadApprovedCampaignPosts(req.params.campaignId);
    if (!summary) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(summary);
  } catch (error) {
    if (error instanceof CampaignValidationError || error instanceof CampaignExecutionError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`[campaigns] approved upload failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to upload approved campaign posts' });
  }
});

app.post('/api/campaigns/:campaignId/send-uploaded-to-buffer', async (req, res) => {
  try {
    const summary = await sendUploadedCampaignPostsToBuffer(req.params.campaignId);
    if (!summary) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(summary);
  } catch (error) {
    if (error instanceof CampaignValidationError || error instanceof CampaignExecutionError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`[campaigns] Buffer send failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to send uploaded campaign posts to Buffer' });
  }
});

app.post('/api/campaigns/:campaignId/posts/:postId/retry-buffer', async (req, res) => {
  try {
    const result = await retryBufferNotificationPost(req.params.campaignId, req.params.postId, req.body || {});
    if (!result) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(result);
  } catch (error) {
    if (error instanceof CampaignValidationError || error instanceof CampaignExecutionError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(`[campaigns] Buffer notification retry failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to retry Buffer notification' });
  }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    if (isSupabaseMode()) return res.status(201).json(await portalRepository().createCampaign(req.body));
    return res.status(201).json(createCampaign(req.body));
  } catch (error) {
    if (error instanceof CampaignValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof CampaignConflictError || error.code === 'EEXIST') {
      return res.status(409).json({ error: 'Campaign ID already exists' });
    }
    console.error(`[campaigns] creation failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to create campaign' });
  }
});

app.patch('/api/campaigns/:campaignId', (req, res) => {
  try {
    // An active campaign is only usable if its plan can be created first.
    // Planning before the status write prevents a failed activation from
    // leaving an ACTIVE campaign without a plan.
    if (req.body && req.body.status === 'active') {
      const planned = planCampaign(req.params.campaignId);
      if (!planned) return res.status(404).json({ error: 'Campaign not found' });
      if (!Array.isArray(planned.plan.slots) || planned.plan.slots.length === 0) {
        throw new CampaignPlannerError('Campaign plan contains zero slots');
      }
    }
    const campaign = updateCampaign(req.params.campaignId, req.body);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(campaign);
  } catch (error) {
    if (error instanceof CampaignValidationError || error instanceof CampaignPlannerError) return res.status(400).json({ error: error.message, reason_code: 'ACTIVATION_PLAN_INVALID', reason: error.message });
    console.error(`[campaigns] update failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to update campaign' });
  }
});

app.delete('/api/campaigns/:campaignId', (req, res) => {
  try {
    if (!deleteCampaign(req.params.campaignId)) return res.status(404).json({ error: 'Campaign not found' });
    return res.json({ campaign_id: req.params.campaignId, status: 'deleted' });
  } catch (error) {
    if (error instanceof CampaignValidationError) return res.status(400).json({ error: error.message });
    console.error(`[campaigns] delete failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to delete campaign' });
  }
});

app.get('/posts', (_req, res) => {
  const postsDir = path.join(ROOT, 'outputs', 'posts');
  if (!fs.existsSync(postsDir)) return res.json([]);
  const folders = fs.readdirSync(postsDir)
    .filter((name) => fs.statSync(path.join(postsDir, name)).isDirectory())
    .sort()
    .reverse();
  let publicationsByPostId = new Map();
  try {
    publicationsByPostId = new Map(readPublicationHistory().publications.map((record) => [record.post_id, record]));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  const posts = folders.map((name) => {
    const metaPath = path.join(postsDir, name, 'metadata.json');
    let m = { post_id: name, status: 'unknown', statuses: { generation: 'unknown', review: 'unknown', upload: 'unknown', buffer: 'unknown', publish: 'unknown', strategy: 'not_checked' }, created_at: null, slide_count: 5 };
    if (fs.existsSync(metaPath)) {
      try { m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    }
    const statuses = resolveStatuses(m, null);
    return { ...m, statuses, upload_readiness: computeReadiness(statuses), buffer_readiness: computeBufferReadiness(statuses), publication: publicationsByPostId.get(name) || null };
  });
  res.json(posts);
});

app.get('/posts/:postId', (req, res) => {
  const postDir = path.join(ROOT, 'outputs', 'posts', req.params.postId);
  if (!fs.existsSync(postDir)) return res.status(404).json({ error: 'not found' });

  let meta = { post_id: req.params.postId, status: 'unknown', created_at: null, slide_count: 5 };
  const metaPath = path.join(postDir, 'metadata.json');
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }

  let caption = '';
  let hashtags = [];
  let slide_urls = [];
  let caption_url = null;
  let supabase = null;
  let strategy_metadata = null;
  let pkgStatuses = null;
  const pkgPath = path.join(postDir, 'publish-package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      caption = pkg.caption || '';
      hashtags = Array.isArray(pkg.hashtags) ? pkg.hashtags : [];
      slide_urls = Array.isArray(pkg.slide_urls) ? pkg.slide_urls : [];
      caption_url = pkg.caption_url || null;
      supabase = pkg.supabase || null;
      strategy_metadata = pkg.strategy_metadata || null;
      pkgStatuses = pkg.statuses || null;
    } catch {}
  }

  const statuses = resolveStatuses(meta, pkgStatuses);
  const derivedStatus = statuses.upload === 'uploaded' ? 'uploaded' :
    statuses.upload === 'failed' ? 'upload_failed' :
    statuses.generation === 'completed' ? 'generated' : (meta.status || 'unknown');
  const upload_readiness = computeReadiness(statuses);
  const buffer_readiness = computeBufferReadiness(statuses);
  const rendered_count = renderedImageCount(postDir);
  const bufferDraftPath = path.join(postDir, 'buffer-draft.json');
  let bufferDraft = null;
  if (fs.existsSync(bufferDraftPath)) {
    try { bufferDraft = JSON.parse(fs.readFileSync(bufferDraftPath, 'utf8')); } catch {}
  }

  const buffer_status = meta.buffer_status === 'scheduled'
    ? 'scheduled'
    : bufferDraft?.buffer_post_id ? 'draft_created' : (meta.buffer_status || 'not_sent');
  let publication;
  try {
    publication = readPublicationHistory().publications.find((record) => record.post_id === req.params.postId) || null;
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ ...meta, status: derivedStatus, statuses, upload_readiness, buffer_readiness, caption, hashtags, slide_urls, caption_url, supabase, strategy_metadata, rendered_count, has_rendered_slides: rendered_count > 0, buffer_status, buffer_post_id: bufferDraft?.buffer_post_id || meta.buffer_post_id || null, r2_uploaded: fs.existsSync(path.join(postDir, 'r2-upload.json')), publication });
});

app.post('/api/posts/:postId/mark-posted', (req, res) => {
  try {
    const result = markPostPosted(req.params.postId, req.body || {});
    return res.status(result.existing ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof PublicationValidationError) return res.status(400).json({ error: error.message });
    console.error(`[publication] manual confirmation failed: ${error.message}`);
    return res.status(500).json({ error: 'Unable to confirm publication' });
  }
});

app.get('/api/campaigns/:campaignId/quick-save', (req, res) => {
  try { const data = quickSaveData(req.params.campaignId); return data ? res.json(data) : res.status(404).json({ error: 'Campaign not found' }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});

app.post('/api/campaigns/:campaignId/posts/:postId/mark-saved', (req, res) => {
  const found = quickSavePostDir(req.params.campaignId, req.params.postId);
  if (!found) return res.status(404).json({ error: 'Campaign post not found' });
  if (!found.metadata.statuses || found.metadata.statuses.generation !== 'completed') return res.status(400).json({ error: 'Only generated posts can be saved' });
  if (!found.metadata.saved_at) {
    found.metadata.saved_at = new Date().toISOString();
    fs.writeFileSync(path.join(found.postDir, 'metadata.json'), JSON.stringify(found.metadata, null, 2), 'utf8');
  }
  return res.json({ post_id: req.params.postId, saved_at: found.metadata.saved_at });
});

app.get('/api/campaigns/:campaignId/posts/:postId/slides.zip', (req, res) => {
  const found = quickSavePostDir(req.params.campaignId, req.params.postId);
  if (!found) return res.status(404).json({ error: 'Campaign post not found' });
  const rendered = path.join(found.postDir, 'rendered');
  const files = fs.existsSync(rendered) ? fs.readdirSync(rendered).filter((name) => /^slide-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  if (!files.length) return res.status(404).json({ error: 'Rendered slides are missing' });
  // Store-only ZIP: avoids a dependency and preserves each existing PNG byte-for-byte.
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = [], central = []; let offset = 0;
  for (const name of files) { const data = fs.readFileSync(path.join(rendered, name)); const n = Buffer.from(name); const c = crc(data); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(c, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); parts.push(local, n, data); const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(c, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42); central.push(cd, n); offset += local.length + n.length + data.length; }
  const centralSize = central.reduce((n, b) => n + b.length, 0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.postId}-slides.zip"`); return res.send(Buffer.concat([...parts, ...central, end]));
});

app.post('/api/posts/:postId/send-to-buffer', async (req, res) => {
  const postDir = safePostFolder(req.params.postId);
  if (!postDir) return res.status(400).json({ error: 'Invalid post ID' });
  if (!fs.existsSync(postDir) || !fs.statSync(postDir).isDirectory()) {
    return res.status(404).json({ error: 'Post not found' });
  }
  const bufferChannelError = postBufferChannelError(postDir);
  if (bufferChannelError) return res.status(400).json({ error: bufferChannelError });
  if (renderedImageCount(postDir) === 0) {
    return res.status(400).json({ error: 'Rendered slides are missing' });
  }

  const draftPath = path.join(postDir, 'buffer-draft.json');
  if (fs.existsSync(draftPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
      if (existing.buffer_post_id) {
        return res.json({
          post_id: req.params.postId,
          r2_status: fs.existsSync(path.join(postDir, 'r2-upload.json')) ? 'uploaded' : 'unknown',
          buffer_status: 'already_created',
          buffer_post_id: existing.buffer_post_id,
          media_count: Number(existing.media_count) || 0,
        });
      }
    } catch {
      return res.status(400).json({ error: 'Existing Buffer draft file is invalid' });
    }
  }

  const r2Path = path.join(postDir, 'r2-upload.json');
  try {
    if (!fs.existsSync(r2Path)) await uploadPostToR2(postDir);
  } catch (error) {
    console.error(`[send-to-buffer] R2 upload failed for ${req.params.postId}: ${error.message}`);
    return res.status(502).json({ error: 'Unable to upload rendered media' });
  }

  try {
    const draft = await createBufferDraft(postDir);
    return res.json({
      post_id: req.params.postId,
      r2_status: 'uploaded',
      buffer_status: 'draft_created',
      buffer_post_id: draft.buffer_post_id,
      media_count: draft.media_count,
    });
  } catch (error) {
    console.error(`[send-to-buffer] draft creation failed for ${req.params.postId}: ${error.message}`);
    return res.status(502).json({ error: 'Unable to create Buffer draft' });
  }
});

app.post('/api/posts/:postId/schedule-buffer', async (req, res) => {
  const postDir = safePostFolder(req.params.postId);
  if (!postDir) return res.status(400).json({ error: 'Invalid post ID' });
  if (!fs.existsSync(postDir) || !fs.statSync(postDir).isDirectory()) {
    return res.status(404).json({ error: 'Post not found' });
  }
  const bufferChannelError = postBufferChannelError(postDir);
  if (bufferChannelError) return res.status(400).json({ error: bufferChannelError });

  const { local_date: localDate, local_time: localTime, timezone } = req.body || {};
  if (typeof localDate !== 'string' || typeof localTime !== 'string' || typeof timezone !== 'string') {
    return res.status(400).json({ error: 'local_date, local_time, and timezone are required' });
  }

  try {
    const dueAt = localDateTimeToUtc(localDate, localTime, timezone);
    if (new Date(dueAt).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Scheduled date/time must be in the future' });
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    const scheduled = await scheduleBufferPost(postDir, {
      date: localDate,
      time: localTime,
      timezone,
    });
    return res.json({
      post_id: req.params.postId,
      buffer_status: scheduled.already_scheduled ? 'already_scheduled' : 'scheduled',
      buffer_scheduled_post_id: scheduled.buffer_scheduled_post_id,
      scheduled_at: scheduled.scheduled_at,
      timezone: scheduled.timezone,
    });
  } catch (error) {
    console.error(`[schedule-buffer] scheduling failed for ${req.params.postId}: ${error.message}`);
    return res.status(502).json({ error: 'Unable to schedule Buffer post' });
  }
});

app.post('/api/generate-slideshows', async (req, res) => {
  const VALID_PILLARS = ['p1', 'p2', 'p3', 'p4'];
  const VALID_HOOKS = ['listicle'];
  const VALID_LANGUAGES = ['ar', 'en', 'es', 'fr'];
  const { pillar_id, hook_type, languages } = req.body || {};

  if (!VALID_PILLARS.includes(pillar_id)) {
    return res.status(400).json({ error: 'pillar_id must be p1, p2, p3, or p4' });
  }
  if (!VALID_HOOKS.includes(hook_type)) {
    return res.status(400).json({ error: 'hook_type must be listicle' });
  }
  if (!Array.isArray(languages) || languages.length === 0) {
    return res.status(400).json({ error: 'languages must be a non-empty array' });
  }
  const uniqueLanguages = [...new Set(languages)];
  if (uniqueLanguages.some((language) => !VALID_LANGUAGES.includes(language))) {
    return res.status(400).json({ error: 'languages may only include ar, en, es, fr' });
  }

  try {
    const summary = generateSlideshows({ pillar: pillar_id, hook: hook_type, languages: uniqueLanguages });
    res.json(summary);
  } catch (err) {
    console.error('[generate-slideshows] failed:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

app.patch('/posts/:postId/review', async (req, res) => {
  const VALID = ['approved', 'needs_edit', 'pending'];
  const { review } = req.body || {};
  if (!VALID.includes(review)) return res.status(400).json({ error: `review must be one of: ${VALID.join(', ')}` });

  const postDir = path.join(ROOT, 'outputs', 'posts', req.params.postId);
  if (!fs.existsSync(postDir)) return res.status(404).json({ error: 'not found' });

  const metaPath = path.join(postDir, 'metadata.json');
  const pkgPath  = path.join(postDir, 'publish-package.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'metadata.json missing' });

  const now = new Date().toISOString();
  let updatedMeta = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.statuses = { ...(meta.statuses || {}), review };
    meta.updated_at = now;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    updatedMeta = meta;
  } catch (e) { return res.status(500).json({ error: `metadata write failed: ${e.message}` }); }

  let updatedPkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.statuses = { ...(pkg.statuses || {}), review };
      pkg.updated_at = now;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
      updatedPkg = pkg;
    } catch {}
  }

  const dbr = await upsertContentPost({ postId: req.params.postId, metadata: updatedMeta, publishPackage: updatedPkg, localPath: postDir, sourceType: 'portal' });
  if (!dbr.skipped && !dbr.ok) console.warn(`[db] review sync failed for ${req.params.postId}:`, dbr.error);

  res.json({ ok: true, post_id: req.params.postId, review });
});

app.patch('/posts/:postId/buffer', async (req, res) => {
  const VALID = ['not_started', 'sent', 'scheduled'];
  const { buffer } = req.body || {};
  if (!VALID.includes(buffer)) return res.status(400).json({ error: `buffer must be one of: ${VALID.join(', ')}` });

  const postDir = path.join(ROOT, 'outputs', 'posts', req.params.postId);
  if (!fs.existsSync(postDir)) return res.status(404).json({ error: 'not found' });

  const metaPath = path.join(postDir, 'metadata.json');
  const pkgPath  = path.join(postDir, 'publish-package.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'metadata.json missing' });

  const now = new Date().toISOString();
  let updatedMeta = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.statuses = { ...(meta.statuses || {}), buffer };
    meta.updated_at = now;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    updatedMeta = meta;
  } catch (e) { return res.status(500).json({ error: `metadata write failed: ${e.message}` }); }

  let updatedPkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.statuses = { ...(pkg.statuses || {}), buffer };
      pkg.updated_at = now;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
      updatedPkg = pkg;
    } catch {}
  }

  const dbr = await upsertContentPost({ postId: req.params.postId, metadata: updatedMeta, publishPackage: updatedPkg, localPath: postDir, sourceType: 'portal' });
  if (!dbr.skipped && !dbr.ok) console.warn(`[db] buffer sync failed for ${req.params.postId}:`, dbr.error);

  res.json({ ok: true, post_id: req.params.postId, buffer });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function runStep(step, log) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', step], { cwd: ROOT, shell: true });
    proc.stdout.on('data', (d) => log(d.toString()));
    proc.stderr.on('data', (d) => log(d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`[${step}] exited with code ${code}`));
    });
  });
}

app.post('/generate', async (req, res) => {
  const { source_type = 'other', raw_input = '', strategy_metadata: rawMeta = {}, content_format = 'auto' } = req.body;
  const strategy_metadata = { ...STRATEGY_DEFAULTS, ...rawMeta };

  if (!raw_input.trim()) {
    return res.status(400).json({ error: 'raw_input is required' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const log = (line) => {
    res.write(line);
  };

  try {
    fs.mkdirSync(path.dirname(RAW_SOURCE_PATH), { recursive: true });
    fs.writeFileSync(RAW_SOURCE_PATH, `[source_type: ${source_type}]\n[content_format: ${content_format}]\n\n${raw_input.trim()}`, 'utf8');
    fs.writeFileSync(MANUAL_INPUT_PATH, JSON.stringify({ source_type, raw_input, strategy_metadata, content_format }, null, 2), 'utf8');
    log(`inputs written\n`);
  } catch (err) {
    log(`ERROR writing inputs: ${err.message}\n`);
    res.end();
    return;
  }

  for (const step of PIPELINE) {
    log(`\n--- ${step} ---\n`);
    try {
      await runStep(step, log);
      log(`--- ${step} done ---\n`);
    } catch (err) {
      log(`\nERROR: ${err.message}\n`);
      res.end();
      return;
    }
  }

  let postId = null;
  try {
    const saved = savePostFolder(strategy_metadata);
    postId = saved.postId;
    log(`\nSaved → outputs/posts/${postId}/\n`);
    const dbResult = await upsertContentPost({
      postId,
      sourceType: source_type || 'portal',
      rawInput: raw_input,
      metadata: saved.metadata,
      publishPackage: saved.pkg,
      localPath: saved.postDir,
    });
    if (dbResult.skipped) { /* env not configured, skip silently */ }
    else if (!dbResult.ok) console.warn(`[db] upsert failed for ${postId}:`, dbResult.error);
  } catch (err) {
    log(`\nWARN: could not save post folder: ${err.message}\n`);
  }

  if (postId) {
    const outputPath = `outputs/posts/${postId}`;
    log(`\nPOST_SAVED:${JSON.stringify({ post_id: postId, output_path: outputPath })}\n`);

    log(`\n--- upload ---\n`);
    try {
      await uploadPost(postId, log);
      log(`--- upload done ---\n`);
    } catch (uploadErr) {
      log(`\nUpload failed: ${uploadErr.message}\n`);
      try {
        const metaPath = path.join(ROOT, 'outputs', 'posts', postId, 'metadata.json');
        fs.writeFileSync(metaPath, JSON.stringify(markUploadFailed(JSON.parse(fs.readFileSync(metaPath, 'utf8')), uploadErr.message), null, 2));
      } catch {}
    }
  }

  log('\nDONE\n');
  res.end();
});

const PORT = 3333;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Creator UI running at http://localhost:${PORT}`));
}

module.exports = { app, createInjectionRouter };
