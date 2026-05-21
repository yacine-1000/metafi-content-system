'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { createPostMetadata, createPublishPackage, markUploadSuccess, markUploadFailed } = require('../lib/postMetadata');

const ROOT = path.resolve(__dirname, '../../');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const RENDERS_DIR = path.join(ROOT, 'renders');
const RAW_SOURCE_PATH = path.join(ROOT, 'test-inputs', 'raw-source.txt');
const MANUAL_INPUT_PATH = path.join(ROOT, 'test-inputs', 'manual-input.json');

const PIPELINE = ['intake', 'planning', 'hook', 'body', 'final-slide', 'assembly:build', 'assemble:test', 'caption'];

const STRATEGY_DEFAULTS = {
  sprint_phase: 'days_1_15_find_signal',
  activity_category: 'general',
  specific_activity: 'none',
  pain_hypothesis: 'none',
  message_hypothesis: 'none',
  content_pillar: 'changed_week_pain',
  content_ring: 'core',
  carousel_archetype: 'pain_mirror',
  cta_goal: 'comments',
  expected_signal: '',
};

function resolveStatuses(meta, pkgStatuses) {
  if (meta && meta.statuses) return meta.statuses;
  if (pkgStatuses) return pkgStatuses;
  const s = (meta && meta.status) || 'unknown';
  return {
    generation: (s === 'generated' || s === 'uploaded' || s === 'upload_failed') ? 'completed' : 'unknown',
    review: 'unknown',
    upload: s === 'uploaded' ? 'uploaded' : s === 'upload_failed' ? 'failed' : 'unknown',
    buffer: 'unknown',
    publish: 'unknown',
  };
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

  const metadata = { ...createPostMetadata({ postId, createdAt, slideCount: 5 }), strategy_metadata };
  fs.writeFileSync(path.join(postDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  const pkg = { ...createPublishPackage({ postId, caption, hashtags, createdAt, slideCount: 5 }), strategy_metadata };
  fs.writeFileSync(path.join(postDir, 'publish-package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  return postId;
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
  fs.writeFileSync(pkgPath, JSON.stringify(markUploadSuccess(JSON.parse(fs.readFileSync(pkgPath, 'utf8')), uploadInput), null, 2));

  const metaPath = path.join(postDir, 'metadata.json');
  fs.writeFileSync(metaPath, JSON.stringify(markUploadSuccess(JSON.parse(fs.readFileSync(metaPath, 'utf8')), uploadInput), null, 2));
}

const app = express();
app.use(express.json());
app.use('/renders', express.static(RENDERS_DIR));
app.use('/outputs', express.static(path.join(ROOT, 'outputs')));
app.use('/assets', express.static(path.join(ROOT, 'assets')));
app.use(express.static(path.join(__dirname)));

app.get('/posts', (_req, res) => {
  const postsDir = path.join(ROOT, 'outputs', 'posts');
  if (!fs.existsSync(postsDir)) return res.json([]);
  const folders = fs.readdirSync(postsDir)
    .filter((name) => fs.statSync(path.join(postsDir, name)).isDirectory())
    .sort()
    .reverse();
  const posts = folders.map((name) => {
    const metaPath = path.join(postsDir, name, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    }
    return { post_id: name, status: 'unknown', statuses: { generation: 'unknown', review: 'unknown', upload: 'unknown', buffer: 'unknown', publish: 'unknown' }, created_at: null, slide_count: 5 };
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

  res.json({ ...meta, status: derivedStatus, statuses, caption, hashtags, slide_urls, caption_url, supabase, strategy_metadata });
});

app.patch('/posts/:postId/review', (req, res) => {
  const VALID = ['approved', 'needs_edit', 'pending'];
  const { review } = req.body || {};
  if (!VALID.includes(review)) return res.status(400).json({ error: `review must be one of: ${VALID.join(', ')}` });

  const postDir = path.join(ROOT, 'outputs', 'posts', req.params.postId);
  if (!fs.existsSync(postDir)) return res.status(404).json({ error: 'not found' });

  const metaPath = path.join(postDir, 'metadata.json');
  const pkgPath  = path.join(postDir, 'publish-package.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'metadata.json missing' });

  const now = new Date().toISOString();
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.statuses = { ...(meta.statuses || {}), review };
    meta.updated_at = now;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) { return res.status(500).json({ error: `metadata write failed: ${e.message}` }); }

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.statuses = { ...(pkg.statuses || {}), review };
      pkg.updated_at = now;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    } catch {}
  }

  res.json({ ok: true, post_id: req.params.postId, review });
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
  const { source_type = 'other', raw_input = '', strategy_metadata: rawMeta = {} } = req.body;
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
    fs.writeFileSync(RAW_SOURCE_PATH, `[source_type: ${source_type}]\n\n${raw_input.trim()}`, 'utf8');
    fs.writeFileSync(MANUAL_INPUT_PATH, JSON.stringify({ source_type, raw_input, strategy_metadata }, null, 2), 'utf8');
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
    postId = savePostFolder(strategy_metadata);
    log(`\nSaved → outputs/posts/${postId}/\n`);
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
app.listen(PORT, () => {
  console.log(`Creator UI running at http://localhost:${PORT}`);
});
