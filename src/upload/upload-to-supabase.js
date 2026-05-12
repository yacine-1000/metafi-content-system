'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.resolve(__dirname, '../../');
const POSTS_DIR = path.join(ROOT, 'outputs', 'posts');

function latestPost() {
  const entries = fs.readdirSync(POSTS_DIR).filter(e =>
    fs.statSync(path.join(POSTS_DIR, e)).isDirectory()
  );
  if (!entries.length) throw new Error('No post folders found in outputs/posts/');
  entries.sort();
  return entries[entries.length - 1];
}

function publicUrl(supabaseUrl, bucket, remotePath) {
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${remotePath}`;
}

async function upload(supabase, bucket, localPath, remotePath) {
  const body = fs.readFileSync(localPath);
  const contentType = localPath.endsWith('.png') ? 'image/png'
    : localPath.endsWith('.txt') ? 'text/plain'
    : 'application/json';

  const { error } = await supabase.storage
    .from(bucket)
    .upload(remotePath, body, { contentType, upsert: true });

  if (error) throw new Error(`Upload failed for ${remotePath}: ${error.message}`);
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_BUCKET) {
    console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const postId = latestPost();
  const postDir = path.join(POSTS_DIR, postId);
  console.log(`Uploading: ${postId}`);

  const slideFiles = ['slide-1.png', 'slide-2.png', 'slide-3.png', 'slide-4.png', 'slide-5.png'];

  const uploads = [
    ...slideFiles.map(f => ({
      local: path.join(postDir, 'slides', f),
      remote: `posts/${postId}/slides/${f}`,
    })),
    { local: path.join(postDir, 'caption.txt'),          remote: `posts/${postId}/caption.txt` },
    { local: path.join(postDir, 'publish-package.json'), remote: `posts/${postId}/publish-package.json` },
  ];

  for (const { local, remote } of uploads) {
    if (!fs.existsSync(local)) {
      console.error(`File not found, aborting: ${local}`);
      process.exit(1);
    }
  }

  for (const { local, remote } of uploads) {
    await upload(supabase, SUPABASE_BUCKET, local, remote);
    console.log(`✓ ${remote}`);
  }

  const uploadedAt = new Date().toISOString();
  const slideUrls = slideFiles.map(f =>
    publicUrl(SUPABASE_URL, SUPABASE_BUCKET, `posts/${postId}/slides/${f}`)
  );
  const captionUrl = publicUrl(SUPABASE_URL, SUPABASE_BUCKET, `posts/${postId}/caption.txt`);

  // Update publish-package.json
  const pkgPath = path.join(postDir, 'publish-package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.status = 'uploaded';
  pkg.slide_urls = slideUrls;
  pkg.caption_url = captionUrl;
  pkg.supabase = {
    bucket: SUPABASE_BUCKET,
    base_path: `posts/${postId}`,
    uploaded_at: uploadedAt,
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('✓ publish-package.json updated');

  // Update metadata.json
  const metaPath = path.join(postDir, 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.status = 'uploaded';
  meta.uploaded_at = uploadedAt;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log('✓ metadata.json updated');

  console.log(`\nDone — ${postId} uploaded to ${SUPABASE_BUCKET}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
