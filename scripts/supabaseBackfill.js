'use strict';

// Usage:
//   npm run supabase:backfill -- --dry-run   (default; no writes)
//   npm run supabase:backfill -- --apply     (explicit Supabase writes)

const fs = require('fs');
const path = require('path');
const { createPersistenceRepository } = require('../src/persistence');

const ROOT = path.resolve(__dirname, '..');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function readJson(filePath, issues, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { issues.push({ type: 'invalid_json', label, path: filePath, message: error.message }); return null; }
}

function files(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && predicate(entry)).map((entry) => path.join(directory, entry.name));
}

function recursiveFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...recursiveFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

function relative(filePath) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.zip': 'application/zip' })[extension] || 'application/octet-stream';
}

function pushDuplicateIssues(records, key, label, issues) {
  const seen = new Set();
  records.forEach((record) => {
    const value = record && record[key];
    if (!value) return;
    if (seen.has(value)) issues.push({ type: 'duplicate_id', entity: label, id: value });
    seen.add(value);
  });
}

function collect(root = ROOT) {
  const issues = [];
  const accounts = files(path.join(root, 'data', 'accounts'), (entry) => entry.name.endsWith('.json'))
    .map((filePath) => readJson(filePath, issues, 'account')).filter(Boolean);
  const accountIds = new Set(accounts.map((item) => item.account_id));

  const campaignsDir = path.join(root, 'data', 'campaigns');
  const campaignFiles = files(campaignsDir, (entry) => /^campaign-[a-z0-9][a-z0-9-]*\.json$/i.test(entry.name)
    && !entry.name.endsWith('-plan.json') && !entry.name.endsWith('-execution.json'));
  const campaigns = campaignFiles.map((filePath) => readJson(filePath, issues, 'campaign')).filter(Boolean);
  const campaignsById = new Map(campaigns.map((item) => [item.campaign_id, item]));
  campaigns.forEach((campaign) => {
    if (!accountIds.has(campaign.account_id)) issues.push({ type: 'invalid_reference', entity: 'campaign', id: campaign.campaign_id, field: 'account_id', value: campaign.account_id });
  });

  const slots = [];
  files(campaignsDir, (entry) => entry.name.endsWith('-plan.json')).forEach((filePath) => {
    const plan = readJson(filePath, issues, 'campaign_plan');
    if (!plan) return;
    const campaign = campaignsById.get(plan.campaign_id);
    if (!campaign) issues.push({ type: 'invalid_reference', entity: 'campaign_plan', path: relative(filePath), field: 'campaign_id', value: plan.campaign_id });
    (plan.slots || []).forEach((slot) => {
      const enriched = { ...slot, campaign_id: plan.campaign_id, account_id: slot.account_id || (campaign && campaign.account_id) };
      if (!enriched.account_id || !accountIds.has(enriched.account_id)) issues.push({ type: 'invalid_reference', entity: 'campaign_slot', id: slot.slot_id, field: 'account_id', value: enriched.account_id || null });
      slots.push(enriched);
    });
  });

  const posts = [];
  const postDirectories = fs.existsSync(path.join(root, 'outputs', 'posts'))
    ? fs.readdirSync(path.join(root, 'outputs', 'posts'), { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
  for (const entry of postDirectories) {
    const postDir = path.join(root, 'outputs', 'posts', entry.name);
    const metadata = readJson(path.join(postDir, 'metadata.json'), issues, 'post_metadata');
    if (!metadata) continue;
    let publishPackage = {};
    const packagePath = path.join(postDir, 'publish-package.json');
    if (fs.existsSync(packagePath)) publishPackage = readJson(packagePath, issues, 'publish_package') || {};
    const post = { ...metadata, post_id: metadata.post_id || entry.name, publish_package: publishPackage, local_path: relative(postDir) };
    if (!post.account_id || !accountIds.has(post.account_id)) issues.push({ type: 'invalid_reference', entity: 'post', id: post.post_id, field: 'account_id', value: post.account_id || null });
    if (post.campaign_id && !campaignsById.has(post.campaign_id)) issues.push({ type: 'invalid_reference', entity: 'post', id: post.post_id, field: 'campaign_id', value: post.campaign_id });
    posts.push(post);
  }
  const postsById = new Set(posts.map((item) => item.post_id));

  const jobs = recursiveFiles(path.join(root, 'outputs', 'jobs')).filter((filePath) => path.basename(filePath) === 'manifest.json')
    .map((filePath) => ({ ...readJson(filePath, issues, 'generation_job'), local_path: relative(filePath) })).filter(Boolean);
  jobs.forEach((job) => {
    if (job.account_id && !accountIds.has(job.account_id)) issues.push({ type: 'invalid_reference', entity: 'generation_job', id: job.job_id || job.jobId, field: 'account_id', value: job.account_id });
  });

  const publicationFile = path.join(root, 'data', 'publication-history.json');
  const publicationDocument = fs.existsSync(publicationFile) ? readJson(publicationFile, issues, 'publication_history') : { publications: [] };
  const publications = Array.isArray(publicationDocument && publicationDocument.publications) ? publicationDocument.publications : [];
  publications.forEach((record) => {
    if (!postsById.has(record.post_id)) issues.push({ type: 'invalid_reference', entity: 'publication', id: record.publication_id, field: 'post_id', value: record.post_id });
    if (!accountIds.has(record.account_id)) issues.push({ type: 'invalid_reference', entity: 'publication', id: record.publication_id, field: 'account_id', value: record.account_id });
  });

  const assets = [];
  accounts.forEach((account) => {
    const add = (filePath, assetType, extra = {}) => assets.push({
      account_id: account.account_id, asset_type: assetType, storage_provider: 'local', storage_key: relative(filePath),
      content_type: contentType(filePath), byte_size: fs.statSync(filePath).size, ...extra,
    });
    if (account.avatar_path) {
      const avatar = path.join(root, account.avatar_path.replace(/^\//, ''));
      if (fs.existsSync(avatar)) add(avatar, 'profile');
      else issues.push({ type: 'missing_file', entity: 'account_asset', account_id: account.account_id, path: account.avatar_path });
    }
    recursiveFiles(path.join(root, 'assets', 'account-hook-images', account.account_id))
      .filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())).forEach((filePath) => add(filePath, 'hook'));
    const ctaRoot = path.join(root, 'assets', 'account-app-cta-images', account.account_id);
    if (fs.existsSync(ctaRoot)) for (const languageEntry of fs.readdirSync(ctaRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      recursiveFiles(path.join(ctaRoot, languageEntry.name)).filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
        .forEach((filePath) => add(filePath, 'localized_cta', { language: languageEntry.name }));
    }
  });
  posts.forEach((post) => {
    if (!post.account_id || !accountIds.has(post.account_id)) return;
    const postDir = path.join(root, post.local_path);
    recursiveFiles(path.join(postDir, 'rendered')).filter((filePath) => /^slide-\d+\.png$/i.test(path.basename(filePath))).forEach((filePath) => {
      const match = path.basename(filePath).match(/\d+/);
      assets.push({ account_id: post.account_id, post_id: post.post_id, asset_type: 'rendered_slide', slide_number: Number(match[0]), storage_provider: 'local', storage_key: relative(filePath), content_type: 'image/png', byte_size: fs.statSync(filePath).size });
    });
    recursiveFiles(postDir).filter((filePath) => path.extname(filePath).toLowerCase() === '.zip').forEach((filePath) => assets.push({ account_id: post.account_id, post_id: post.post_id, asset_type: 'slides_zip', storage_provider: 'local', storage_key: relative(filePath), content_type: 'application/zip', byte_size: fs.statSync(filePath).size }));
  });

  pushDuplicateIssues(accounts, 'account_id', 'account', issues);
  pushDuplicateIssues(campaigns, 'campaign_id', 'campaign', issues);
  pushDuplicateIssues(slots, 'slot_id', 'campaign_slot', issues);
  pushDuplicateIssues(posts, 'post_id', 'post', issues);
  pushDuplicateIssues(jobs, 'job_id', 'generation_job', issues);
  pushDuplicateIssues(publications, 'publication_id', 'publication', issues);

  return { accounts, campaigns, slots, posts, jobs, publications, assets, issues };
}

function report(snapshot, dryRun) {
  return {
    mode: dryRun ? 'dry-run' : 'apply',
    root: ROOT,
    accounts_found: snapshot.accounts.length,
    campaigns_found: snapshot.campaigns.length,
    slots_found: snapshot.slots.length,
    posts_found: snapshot.posts.length,
    generation_jobs_found: snapshot.jobs.length,
    assets_found: snapshot.assets.length,
    publication_records_found: snapshot.publications.length,
    invalid_references: snapshot.issues.filter((issue) => issue.type === 'invalid_reference'),
    duplicate_ids: snapshot.issues.filter((issue) => issue.type === 'duplicate_id'),
    other_issues: snapshot.issues.filter((issue) => !['invalid_reference', 'duplicate_id'].includes(issue.type)),
    records_that_would_be_inserted: {
      accounts: snapshot.accounts.length, campaigns: snapshot.campaigns.length, campaign_slots: snapshot.slots.length,
      posts: snapshot.posts.length, generation_jobs: snapshot.jobs.length, account_assets: snapshot.assets.length,
      publication_history: snapshot.publications.length,
    },
  };
}

async function apply(snapshot) {
  if (snapshot.issues.length) {
    throw new Error(`Backfill blocked: resolve ${snapshot.issues.length} dry-run issue(s) before --apply`);
  }
  const repository = createPersistenceRepository({ env: process.env });
  if (repository.mode !== 'supabase') throw new Error('--apply requires METAFI_PERSISTENCE_MODE=supabase');
  for (const account of snapshot.accounts) await repository.upsertAccount(account);
  for (const campaign of snapshot.campaigns) await repository.upsertCampaign(campaign);
  for (const campaign of snapshot.campaigns) await repository.upsertCampaignSlots(campaign.campaign_id, snapshot.slots.filter((slot) => slot.campaign_id === campaign.campaign_id), campaign.account_id);
  for (const job of snapshot.jobs.filter((job) => job.account_id)) await repository.upsertGenerationJob(job);
  for (const post of snapshot.posts.filter((post) => post.account_id)) await repository.upsertPost(post);
  for (const asset of snapshot.assets) await repository.upsertAccountAsset(asset);
  for (const publication of snapshot.publications) await repository.upsertPublication(publication);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dry-run', '--apply'].includes(arg)) || args.includes('--dry-run') && args.includes('--apply')) {
    throw new Error('Usage: npm run supabase:backfill -- --dry-run | --apply');
  }
  const dryRun = !args.includes('--apply');
  const snapshot = collect();
  const output = report(snapshot, dryRun);
  if (!dryRun) await apply(snapshot);
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { collect, report };
