'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--post') {
      args.post = argv[i + 1];
      i += 1;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.post) throw new Error('Missing required argument: --post outputs/posts/{post_id}');

  const postFolder = path.isAbsolute(args.post) ? args.post : path.join(ROOT, args.post);
  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${args.post}`);
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

  const result = spawnSync(
    process.execPath,
    ['src/assembly/assemble-slider.js'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        METAFI_ASSEMBLY_CONFIG_INPUT: configPath,
        METAFI_RENDERS_DIR: rendersDir,
        METAFI_PRESERVE_LINE_BREAKS: '1',
      },
    }
  );

  if (result.status !== 0) {
    throw new Error(`Renderer failed with exit code ${result.status}`);
  }

  const metadataPath = path.join(postFolder, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    const metadata = readJson(metadataPath);
    metadata.updated_at = new Date().toISOString();
    metadata.assets = {
      ...(metadata.assets || {}),
      slide_count: renderConfig.slides.length,
      rendered_path: 'rendered/',
      render_config_path: 'render-config.json',
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }

  console.log(JSON.stringify({
    post_folder: repoRelative(postFolder),
    render_config: repoRelative(configPath),
    rendered_dir: repoRelative(rendersDir),
    slide_count: renderConfig.slides.length,
  }, null, 2));
}

main();
