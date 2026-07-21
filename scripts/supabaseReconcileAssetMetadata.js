'use strict';
const crypto = require('crypto');
const { buildUploadPlan, BUCKET } = require('./supabaseUploadAssets');
const { createServerSupabaseClient, persistenceMode } = require('../src/persistence/serverSupabaseClient');

function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
async function remoteHash(storage, key) {
  const { data, error } = await storage.download(key);
  if (error) throw new Error(`Missing Storage object ${key}: ${error.message}`);
  return hash(Buffer.from(await data.arrayBuffer()));
}
async function buildReconciliation(client) {
  const plan = buildUploadPlan();
  if (plan.blockingErrors.length) throw new Error(`Local asset plan has ${plan.blockingErrors.length} blocking error(s)`);
  const storage = client.storage.from(BUCKET);
  const [accountRows, contentRows] = await Promise.all([
    client.from('account_assets').select('*'), client.from('content_assets').select('*'),
  ]);
  if (accountRows.error) throw new Error(accountRows.error.message);
  if (contentRows.error) throw new Error(contentRows.error.message);
  // The bootstrap already used deterministic private keys; only its provider
  // label was wrong. Match that key exactly rather than guessing from paths.
  const accountByKey = new Map(accountRows.data.map((row) => [row.storage_key, row]));
  const contentByLegacy = new Map(contentRows.data.map((row) => [row.legacy_id, row]));
  const updates = [];
  for (const item of plan.files) {
    const row = item.ownership === 'account' ? accountByKey.get(item.storage_key) : contentByLegacy.get(item.legacy_id);
    if (!row) throw new Error(`No existing ${item.ownership}_assets row maps to ${item.source_storage_key}`);
    const actual = await remoteHash(storage, item.storage_key);
    if (actual !== item.checksum) throw new Error(`Checksum mismatch for ${item.storage_key}`);
    updates.push({ table: item.ownership === 'account' ? 'account_assets' : 'content_assets', id: row.id, storage_key: item.storage_key, checksum: item.checksum, source_storage_key: row.storage_key });
  }
  if (updates.length !== 81 || new Set(updates.map((u) => `${u.table}:${u.id}`)).size !== updates.length) throw new Error('Reconciliation mapping is not one-to-one');
  return { plan, accountRows: accountRows.data, contentRows: contentRows.data, updates };
}
async function apply(client, reconciliation) {
  for (const update of reconciliation.updates) {
    const patch = update.table === 'account_assets'
      ? { storage_provider: 'supabase_storage', storage_bucket: BUCKET, storage_key: update.storage_key, checksum_sha256: update.checksum }
      : { storage_provider: 'supabase_storage', bucket: BUCKET, storage_key: update.storage_key, checksum: update.checksum };
    const { error } = await client.from(update.table).update(patch).eq('id', update.id);
    if (error) throw new Error(`Unable to update ${update.table}/${update.id}: ${error.message}`);
  }
}
async function verify(client, reconciliation) {
  const storage = client.storage.from(BUCKET);
  const [a, c] = await Promise.all([client.from('account_assets').select('*'), client.from('content_assets').select('*')]);
  if (a.error || c.error) throw new Error((a.error || c.error).message);
  const rows = [...a.data.map((r) => ['account_assets', r]), ...c.data.map((r) => ['content_assets', r])];
  const expected = new Map(reconciliation.updates.map((u) => [`${u.table}:${u.id}`, u]));
  if (a.data.length !== 25 || c.data.length !== 56) throw new Error(`Unexpected row counts: account_assets=${a.data.length}, content_assets=${c.data.length}`);
  for (const [table, row] of rows) {
    const update = expected.get(`${table}:${row.id}`); if (!update) throw new Error(`Unexpected row ${table}/${row.id}`);
    if (row.storage_provider !== 'supabase_storage' || (row.storage_bucket || row.bucket) !== BUCKET || row.storage_key !== update.storage_key) throw new Error(`Metadata verification failed for ${table}/${row.id}`);
  }
  const keys = rows.map((r) => `${r[0]}:${r[1].storage_provider}:${r[1].storage_bucket || r[1].bucket}:${r[1].storage_key}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate metadata rows detected');
  for (const update of reconciliation.updates) if (await remoteHash(storage, update.storage_key) !== update.checksum) throw new Error(`Object changed during reconciliation: ${update.storage_key}`);
  const samples = [
    a.data.find((r) => r.asset_type === 'profile'), a.data.find((r) => r.asset_type === 'hook'),
    c.data.find((r) => r.asset_type === 'body'), c.data.find((r) => r.asset_type === 'app_screenshot'),
  ];
  for (const row of samples) { const { data, error } = await client.storage.from(row.storage_bucket || row.bucket).createSignedUrl(row.storage_key, 300); if (error || !data?.signedUrl) throw new Error(`Signed URL verification failed for ${row.storage_key}`); }
  return { account_assets: a.data.length, content_assets: c.data.length, verified_objects: reconciliation.updates.length, duplicate_metadata_rows: 0, signed_url_samples: samples.map((r) => r.storage_key) };
}
async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Usage: npm run supabase:reconcile-assets -- --apply');
  if (persistenceMode(process.env) !== 'supabase') throw new Error('METAFI_PERSISTENCE_MODE=supabase is required');
  const client = createServerSupabaseClient(); const reconciliation = await buildReconciliation(client); await apply(client, reconciliation); console.log(JSON.stringify({ updates: reconciliation.updates, verification: await verify(client, reconciliation) }, null, 2));
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { buildReconciliation, verify };
