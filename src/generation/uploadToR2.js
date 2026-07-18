'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ROOT = path.resolve(__dirname, '../..');
const REQUIRED_ENV = [
  'CLOUDFLARE_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_PUBLIC_URL',
];
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

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

function readEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing .env file: ${envPath}`);
  }

  const env = dotenv.parse(fs.readFileSync(envPath));
  const missing = REQUIRED_ENV.filter((name) => !env[name] || !env[name].trim());
  if (missing.length > 0) {
    throw new Error(`Missing required .env variables: ${missing.join(', ')}`);
  }
  return env;
}

function renderedSlides(renderedDir) {
  if (!fs.existsSync(renderedDir) || !fs.statSync(renderedDir).isDirectory()) {
    throw new Error(`Rendered folder does not exist: ${renderedDir}`);
  }

  const slides = fs.readdirSync(renderedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const extension = path.extname(entry.name).toLowerCase();
      const match = entry.name.match(/^slide-(\d+)\.(?:png|jpe?g|webp)$/i);
      if (!CONTENT_TYPES[extension] || !match) return null;
      return {
        slideNumber: Number(match[1]),
        filename: entry.name,
        filePath: path.join(renderedDir, entry.name),
        contentType: CONTENT_TYPES[extension],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.slideNumber - b.slideNumber || a.filename.localeCompare(b.filename));

  if (slides.length === 0) {
    throw new Error(`No valid rendered slide images found in: ${renderedDir}`);
  }
  return slides;
}

async function uploadPostToR2(postFolder) {
  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${postFolder}`);
  }

  const env = readEnv();
  const postId = path.basename(postFolder);
  const slides = renderedSlides(path.join(postFolder, 'rendered'));
  const client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  const publicBaseUrl = env.R2_PUBLIC_URL.replace(/\/+$/, '');
  const files = [];

  for (const slide of slides) {
    const objectKey = `posts/${postId}/${slide.filename}`;
    await client.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: objectKey,
      Body: fs.readFileSync(slide.filePath),
      ContentType: slide.contentType,
    }));
    files.push({
      slide_number: slide.slideNumber,
      filename: slide.filename,
      object_key: objectKey,
      content_type: slide.contentType,
      public_url: `${publicBaseUrl}/${objectKey}`,
    });
  }

  const manifest = {
    provider: 'cloudflare-r2',
    bucket: env.R2_BUCKET,
    post_id: postId,
    uploaded_at: new Date().toISOString(),
    status: 'uploaded',
    files,
  };
  const manifestPath = path.join(postFolder, 'r2-upload.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.post) throw new Error('Missing required argument: --post outputs/posts/{post_id}');
  const postFolder = path.isAbsolute(args.post) ? args.post : path.resolve(ROOT, args.post);
  const manifest = await uploadPostToR2(postFolder);
  console.log(`Uploaded ${manifest.files.length} rendered slides and wrote ${path.relative(ROOT, path.join(postFolder, 'r2-upload.json'))}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`R2 upload failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { uploadPostToR2 };
