'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { renderSlides, STYLES } = require('../assembly/assemble-slider');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = { posts: [], scratchInput: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--post') {
      args.posts.push(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--scratch-input') {
      args.scratchInput = argv[i + 1]; i += 1;
    }
  }
  return args;
}

function repoRelative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertResolvedPackage(pkg, postFolder) {
  if (!Array.isArray(pkg.slides)) throw new Error('publish-package-resolved.json must contain slides array');
  if (pkg.slides.length !== pkg.slide_count) {
    throw new Error(`slides.length (${pkg.slides.length}) does not equal slide_count (${pkg.slide_count})`);
  }

  for (const slide of pkg.slides) {
    if (slide.slide_number == null) throw new Error('Every slide must have slide_number');
    if (typeof slide.text !== 'string') throw new Error(`Slide ${slide.slide_number} must have text`);
    if (typeof slide.asset_path !== 'string' || !slide.asset_path) {
      throw new Error(`Slide ${slide.slide_number} must have asset_path`);
    }
    const imagePath = path.join(ROOT, slide.asset_path);
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Referenced image does not exist for slide ${slide.slide_number}: ${slide.asset_path}`);
    }
  }

  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${repoRelative(postFolder)}`);
  }
}

async function renderPost(argsPost, browser, options = {}) {
  const postFolder = path.isAbsolute(argsPost) ? argsPost : path.join(ROOT, argsPost);
  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${argsPost}`);
  }

  const resolvedPath = path.join(postFolder, 'publish-package-resolved.json');
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`publish-package-resolved.json is missing: ${repoRelative(resolvedPath)}`);
  }

  const resolvedPackage = readJson(resolvedPath);
  assertResolvedPackage(resolvedPackage, postFolder);

  const renderConfig = {
    slides: resolvedPackage.slides.map((slide) => ({
      slide_number: slide.slide_number,
      language: resolvedPackage.language,
      role: slide.role,
      image_path: slide.asset_path,
      text: slide.text,
    })),
  };

  const configPath = path.join(postFolder, 'render-config.json');
  const rendersDir = path.join(postFolder, 'rendered');
  fs.writeFileSync(configPath, JSON.stringify(renderConfig, null, 2), 'utf8');
  fs.mkdirSync(rendersDir, { recursive: true });

  const previousPreserveLineBreaks = process.env.METAFI_PRESERVE_LINE_BREAKS;
  process.env.METAFI_PRESERVE_LINE_BREAKS = '1';
  try {
    await renderSlides(renderConfig, rendersDir, STYLES['style-a'], path.basename(postFolder), {
      browser,
      pageMode: 'reuse',
      imageMode: 'base64',
    });
  } finally {
    if (previousPreserveLineBreaks == null) delete process.env.METAFI_PRESERVE_LINE_BREAKS;
    else process.env.METAFI_PRESERVE_LINE_BREAKS = previousPreserveLineBreaks;
  }

  const metadataPath = path.join(postFolder, 'metadata.json');
  let metadata = options.metadata || (fs.existsSync(metadataPath) ? readJson(metadataPath) : null);
  if (metadata) {
    metadata.updated_at = new Date().toISOString();
    metadata.assets = {
      ...(metadata.assets || {}),
      slide_count: renderConfig.slides.length,
      rendered_path: 'rendered/',
      render_config_path: 'render-config.json',
    };
    if (String(options.persistenceMode || process.env.METAFI_PERSISTENCE_MODE || 'local').toLowerCase() !== 'supabase') fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }

  return {
    post_id: metadata?.post_id || path.basename(postFolder), campaign_id: metadata?.campaign_id || null, slot_id: metadata?.slot_id || null,
    account_id: metadata?.account_id || null, language: metadata?.language || resolvedPackage.language, pillar_id: metadata?.pillar_id || null,
    hook_type: metadata?.hook_type || null, caption: resolvedPackage.caption || '', metadata, publish_package: resolvedPackage,
    resolved_assets: resolvedPackage.slides.map((slide) => ({ slide_number: slide.slide_number, asset_path: slide.asset_path })),
    slide_files: fs.readdirSync(rendersDir).filter((name) => /^slide-\d+\.png$/.test(name)).sort().map((name) => repoRelative(path.join(rendersDir, name))),
    post_folder: repoRelative(postFolder),
    render_config: repoRelative(configPath),
    rendered_dir: repoRelative(rendersDir),
    slide_count: renderConfig.slides.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let scratch = null;
  if (args.scratchInput) {
    scratch = readJson(args.scratchInput);
    if (!scratch || !Array.isArray(scratch.posts) || !scratch.result_path) throw new Error('Invalid renderer scratch input: posts[] and result_path are required');
    args.posts = scratch.posts.map((item) => item.post_folder);
  }
  if (!args.posts.length) throw new Error('Missing required argument: --post outputs/posts/{post_id}');
  const batchStartedAt = performance.now();
  const launchStartedAt = performance.now();
  const browser = await chromium.launch();
  console.error(`[renderer] ${new Date().toISOString()} stage=browser_launch event=complete elapsed_ms=${Math.round((performance.now() - launchStartedAt) * 100) / 100} scope=batch`);
  try {
    const results = [];
    for (let i = 0; i < args.posts.length; i += 1) results.push(await renderPost(args.posts[i], browser, scratch ? { ...scratch.posts[i], persistenceMode: scratch.persistence_mode } : {}));
    const output = args.posts.length === 1 ? results[0] : { posts: results };
    if (scratch) fs.writeFileSync(scratch.result_path, JSON.stringify(output, null, 2), 'utf8');
    console.log(JSON.stringify(output, null, 2));
  } finally {
    const closeStartedAt = performance.now();
    await browser.close();
    console.error(`[renderer] ${new Date().toISOString()} stage=browser_shutdown event=complete elapsed_ms=${Math.round((performance.now() - closeStartedAt) * 100) / 100} scope=batch`);
  }
  console.error(`[renderer] ${new Date().toISOString()} stage=render_batch event=complete elapsed_ms=${Math.round((performance.now() - batchStartedAt) * 100) / 100} posts=${args.posts.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { assertResolvedPackage, renderPost };
