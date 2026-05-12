'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../../');
const RENDERS_DIR = path.join(ROOT, 'renders');
const RAW_SOURCE_PATH = path.join(ROOT, 'test-inputs', 'raw-source.txt');
const MANUAL_INPUT_PATH = path.join(ROOT, 'test-inputs', 'manual-input.json');

const PIPELINE = ['intake', 'planning', 'hook', 'body', 'final-slide', 'assembly:build', 'assemble:test', 'caption'];

function savePostFolder() {
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

  const slidePaths = Array.from({ length: 5 }, (_, i) => `slides/slide-${i + 1}.png`);
  const createdAt = now.toISOString();

  fs.writeFileSync(
    path.join(postDir, 'publish-package.json'),
    JSON.stringify({
      post_id: postId,
      platform: 'tiktok',
      type: 'photo_carousel',
      status: 'ready_for_review',
      slide_paths: slidePaths,
      slide_urls: [],
      caption,
      hashtags,
      caption_path: 'caption.txt',
      created_at: createdAt,
      publish: { provider: null, platform_post_id: null, published_at: null, error: null },
    }, null, 2),
    'utf8',
  );

  fs.writeFileSync(
    path.join(postDir, 'metadata.json'),
    JSON.stringify({ post_id: postId, status: 'ready_for_review', created_at: createdAt, slide_count: 5 }, null, 2),
    'utf8',
  );

  return postId;
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
    return { post_id: name, status: 'unknown', created_at: null, slide_count: 5 };
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
  const pkgPath = path.join(postDir, 'publish-package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      caption = pkg.caption || '';
      hashtags = Array.isArray(pkg.hashtags) ? pkg.hashtags : [];
      slide_urls = Array.isArray(pkg.slide_urls) ? pkg.slide_urls : [];
      caption_url = pkg.caption_url || null;
      supabase = pkg.supabase || null;
    } catch {}
  }

  res.json({ ...meta, caption, hashtags, slide_urls, caption_url, supabase });
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
  const { source_type = 'other', raw_input = '' } = req.body;

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
    fs.writeFileSync(MANUAL_INPUT_PATH, JSON.stringify({ source_type, raw_input }, null, 2), 'utf8');
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
    postId = savePostFolder();
    log(`\nSaved → outputs/posts/${postId}/\n`);
  } catch (err) {
    log(`\nWARN: could not save post folder: ${err.message}\n`);
  }

  if (postId) {
    const outputPath = `outputs/posts/${postId}`;
    log(`\nPOST_SAVED:${JSON.stringify({ post_id: postId, output_path: outputPath })}\n`);
  }

  log('\nDONE\n');
  res.end();
});

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`Creator UI running at http://localhost:${PORT}`);
});
