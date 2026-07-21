'use strict';

// Usage:
//   npm run supabase:upload-assets -- --dry-run  (default; no writes)
//   npm run supabase:upload-assets -- --apply    (private bucket + metadata writes)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectAccountsOnly } = require('./supabaseBackfill');
const { createPersistenceRepository } = require('../src/persistence');
const { createServerSupabaseClient, persistenceMode } = require('../src/persistence/serverSupabaseClient');

const ROOT = path.resolve(__dirname, '..');
const BUCKET = 'metafi-content-assets';

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function localFile(root, storageKey) { return path.resolve(root, storageKey); }
function filename(storageKey) { return path.basename(storageKey); }

function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (mimeType === 'image/jpeg') {
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && offset + 9 < buffer.length) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (!length || offset + 2 + length > buffer.length) break;
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

function accountKey(asset) {
  const name = filename(asset.storage_key);
  if (asset.asset_type === 'profile') return `accounts/${asset.account_id}/profile/${name}`;
  if (asset.asset_type === 'hook') return `accounts/${asset.account_id}/hooks/${name}`;
  return `accounts/${asset.account_id}/cta/${asset.language}/${name}`;
}

function contentKey(asset) {
  const name = filename(asset.storage_key);
  if (asset.asset_type === 'body') {
    const parts = asset.storage_key.split('/');
    const bank = parts.includes('female') ? 'body_slides-female' : 'body_slides';
    return `global/body/${bank}/${name}`;
  }
  if (asset.asset_type === 'shared_hook') return `global/hooks/${asset.bank || 'visual_hooks'}/${name}`;
  return `global/app-screenshots/${asset.language || 'shared'}/${name}`;
}

function buildUploadPlan(root = ROOT) {
  const snapshot = collectAccountsOnly(root);
  const files = [];
  const add = (asset, ownership) => {
    const filePath = localFile(root, asset.storage_key);
    if (!fs.existsSync(filePath)) return;
    const data = fs.readFileSync(filePath);
    const dimensions = imageDimensions(data, asset.mime_type || asset.content_type);
    files.push({ ...asset, ownership, storage_provider: 'supabase_storage', file_path: filePath, storage_key: ownership === 'account' ? accountKey(asset) : contentKey(asset),
      source_storage_key: asset.storage_key, checksum: sha256(data), size_bytes: data.length, byte_size: data.length, width: dimensions.width, height: dimensions.height,
      mime_type: asset.mime_type || asset.content_type, content_type: asset.content_type || asset.mime_type, storage_bucket: BUCKET, bucket: BUCKET });
  };
  snapshot.assets.forEach((asset) => add(asset, 'account'));
  snapshot.contentAssets.forEach((asset) => add(asset, 'content'));
  const byKey = new Map();
  const duplicates = [];
  for (const item of files) {
    const prior = byKey.get(item.storage_key);
    if (!prior) { byKey.set(item.storage_key, item); continue; }
    duplicates.push({ storage_key: item.storage_key, first_source: prior.source_storage_key, duplicate_source: item.source_storage_key,
      same_checksum: prior.checksum === item.checksum });
  }
  const blockingErrors = [...snapshot.blockingErrors];
  duplicates.filter((item) => !item.same_checksum).forEach((item) => blockingErrors.push({ type: 'storage_key_collision', ...item }));
  return { snapshot, files: [...byKey.values()], duplicates, blockingErrors };
}

function report(plan, dryRun) {
  return {
    mode: dryRun ? 'dry-run' : 'apply', bucket: BUCKET,
    files_discovered: plan.files.length,
    account_profile_assets: plan.files.filter((item) => item.ownership === 'account' && item.asset_type === 'profile').length,
    account_hook_assets: plan.files.filter((item) => item.ownership === 'account' && item.asset_type === 'hook').length,
    account_localized_cta_assets: plan.files.filter((item) => item.ownership === 'account' && item.asset_type === 'localized_cta').length,
    global_body_assets: plan.files.filter((item) => item.asset_type === 'body').length,
    global_shared_hook_assets: plan.files.filter((item) => item.asset_type === 'shared_hook').length,
    global_app_screenshot_assets: plan.files.filter((item) => item.asset_type === 'app_screenshot').length,
    total_bytes: plan.files.reduce((total, item) => total + item.size_bytes, 0), destination_keys: plan.files.map((item) => item.storage_key),
    duplicates: plan.duplicates, missing_ownership_metadata: plan.snapshot.excludedAssets.filter((item) => item.type === 'ownership_not_explicit'),
    unsupported_formats: [...plan.snapshot.excludedAssets, ...plan.snapshot.excludedContentAssets].filter((item) => item.type === 'unsupported_file_type'),
    files_excluded: [...plan.snapshot.excludedAssets, ...plan.snapshot.excludedContentAssets], blocking_errors: plan.blockingErrors,
  };
}

async function ensurePrivateBucket(client) {
  const { data, error } = await client.storage.listBuckets();
  if (error) throw new Error(`Unable to list Storage buckets: ${error.message}`);
  const bucket = (data || []).find((item) => item.name === BUCKET);
  if (bucket) {
    if (bucket.public) throw new Error(`${BUCKET} already exists but is public; make it private before uploading`);
    return;
  }
  const created = await client.storage.createBucket(BUCKET, { public: false });
  if (created.error) throw new Error(`Unable to create private Storage bucket ${BUCKET}: ${created.error.message}`);
}

async function existingChecksum(storage, key) {
  const { data, error } = await storage.download(key);
  if (error) {
    if (/not found|object not found/i.test(error.message || '')) return null;
    throw new Error(`Unable to inspect ${key}: ${error.message}`);
  }
  return sha256(Buffer.from(await data.arrayBuffer()));
}

async function uploadAndVerify(storage, item) {
  const existing = await existingChecksum(storage, item.storage_key);
  if (existing && existing !== item.checksum) throw new Error(`Refusing to overwrite ${item.storage_key}: existing object checksum differs`);
  if (!existing) {
    const body = fs.readFileSync(item.file_path);
    const { error } = await storage.upload(item.storage_key, body, { contentType: item.mime_type, upsert: false });
    if (error) {
      const racedChecksum = await existingChecksum(storage, item.storage_key);
      if (racedChecksum === item.checksum) return 'already_present';
      throw new Error(`Unable to upload ${item.storage_key}: ${error.message}`);
    }
  }
  const verified = await existingChecksum(storage, item.storage_key);
  if (verified !== item.checksum) throw new Error(`Upload verification failed for ${item.storage_key}`);
  return existing ? 'already_present' : 'uploaded';
}

async function apply(plan, env = process.env) {
  if (plan.blockingErrors.length) throw new Error(`Upload blocked: resolve ${plan.blockingErrors.length} blocking error(s)`);
  if (persistenceMode(env) !== 'supabase') throw new Error('--apply requires METAFI_PERSISTENCE_MODE=supabase');
  const client = createServerSupabaseClient(env);
  await ensurePrivateBucket(client);
  const storage = client.storage.from(BUCKET);
  for (const item of plan.files) await uploadAndVerify(storage, item);
  const repository = createPersistenceRepository({ env, client });
  for (const account of plan.snapshot.accounts) await repository.upsertAccount(account);
  for (const item of plan.files.filter((entry) => entry.ownership === 'account')) await repository.upsertAccountAsset(item);
  for (const item of plan.files.filter((entry) => entry.ownership === 'content')) await repository.upsertContentAsset(item);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dry-run', '--apply'].includes(arg)) || args.includes('--dry-run') && args.includes('--apply')) throw new Error('Usage: npm run supabase:upload-assets -- --dry-run | --apply');
  const dryRun = !args.includes('--apply');
  const plan = buildUploadPlan();
  if (!dryRun) await apply(plan);
  console.log(JSON.stringify(report(plan, dryRun), null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { BUCKET, buildUploadPlan, report, imageDimensions, accountKey, contentKey };
