'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInjectionHandlers } = require('../../src/injection/injectionApi');
const { createScriptLibraryWriteService } = require('../../src/injection/scriptLibraryWriteService');
const { createInjectionRequestStore } = require('../../src/injection/injectionRequestStore');
const { createApprovedTaxonomyService } = require('../../src/injection/approvedTaxonomyService');

const ROOT = path.resolve(__dirname, '..', '..');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function input(libraryDir) {
  const set = JSON.parse(fs.readFileSync(path.join(libraryDir, 'source-sets', 'SET-001.json'), 'utf8'));
  return { pillar: set.pillar, subtopic: set.subtopic, topic: 'API injection fixture', scripts: set.scripts.slice(0, 2).map(({ script_id, ...script }) => script) };
}

function responseCapture() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('Injection API creates a valid set and clearly rejects invalid taxonomy and slide structure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-injection-api-'));
  const libraryDir = path.join(root, 'script-library');
  fs.cpSync(path.join(ROOT, 'content', 'script-library'), libraryDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existingPath = path.join(libraryDir, 'source-sets', 'SET-001.json');
  const existingHash = hash(existingPath);
  const requestPath = path.join(root, 'requests.json');
  const campaign = { campaign_id: 'campaign-fixture-active', account_id: 'account-fixture', status: 'active', start_date: '2026-07-20', duration_days: 5, name: 'Fixture campaign' };
  const handlers = createInjectionHandlers({
    writeService: createScriptLibraryWriteService({ libraryDir }),
    taxonomyService: createApprovedTaxonomyService(),
    requestStore: createInjectionRequestStore({ filePath: requestPath }),
    getCampaign: (campaignId) => campaignId === campaign.campaign_id ? campaign : campaignId === 'campaign-fixture-paused' ? { ...campaign, campaign_id: campaignId, status: 'paused' } : null,
    listCampaigns: () => [campaign],
  });
  const taxonomy = responseCapture();
  await handlers.taxonomy({}, taxonomy);
  assert.ok(taxonomy.body.pillars.length > 0);
  const changedWeek = taxonomy.body.subtopics.filter((item) => item.pillar === 'Changed Week / What Should I Train Today?').map((item) => item.subtopic);
  assert.deepEqual(changedWeek, ['Weekly Activity Adaptation', 'Daily Training Decision', 'Training Load', 'Personalized Plan', 'Sport Logging', 'Recovery Decision']);
  assert.equal(taxonomy.body.subtopics.some((item) => item.pillar === 'Changed Week / What Should I Train Today?' && item.subtopic === 'Hybrid Athlete'), false);
  const created = responseCapture();
  handlers.createSourceSet({ body: input(libraryDir) }, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.source_set.source_set_id, 'SET-045');
  assert.equal(hash(existingPath), existingHash);
  assert.ok(fs.existsSync(path.join(libraryDir, 'source-sets', 'SET-045.json')));
  assert.equal(fs.existsSync(requestPath), false);

  const badTaxonomy = input(libraryDir);
  badTaxonomy.pillar = 'Not a pillar';
  const taxonomyFailure = responseCapture();
  handlers.createSourceSet({ body: badTaxonomy }, taxonomyFailure);
  assert.equal(taxonomyFailure.statusCode, 400);
  assert.match(taxonomyFailure.body.error, /Unknown pillar/);
  const badSlides = input(libraryDir);
  badSlides.scripts[0].slides[3].slide_label = 'Slide 4';
  const slideFailure = responseCapture();
  handlers.createSourceSet({ body: badSlides }, slideFailure);
  assert.equal(slideFailure.statusCode, 400);
  assert.match(slideFailure.body.error, /Metafi/);

  const request = responseCapture();
  handlers.createCampaignRequest({ body: { source_set_id: 'SET-001', campaign_id: campaign.campaign_id, target_date: '2026-07-22' } }, request);
  assert.equal(request.statusCode, 201);
  assert.equal(request.body.request.account_id, 'account-fixture');
  assert.equal(request.body.request.status, 'pending');
  assert.equal(createInjectionRequestStore({ filePath: requestPath }).list().length, 1);
  const missingSource = responseCapture();
  handlers.createCampaignRequest({ body: { source_set_id: 'SET-999', campaign_id: campaign.campaign_id } }, missingSource);
  assert.equal(missingSource.statusCode, 400);
  assert.match(missingSource.body.error, /Source set does not exist/);
  const missingCampaign = responseCapture();
  handlers.createCampaignRequest({ body: { source_set_id: 'SET-001', campaign_id: 'campaign-missing' } }, missingCampaign);
  assert.equal(missingCampaign.statusCode, 400);
  assert.match(missingCampaign.body.error, /Campaign does not exist/);
  const inactiveCampaign = responseCapture();
  handlers.createCampaignRequest({ body: { source_set_id: 'SET-001', campaign_id: 'campaign-fixture-paused' } }, inactiveCampaign);
  assert.equal(inactiveCampaign.statusCode, 400);
  assert.match(inactiveCampaign.body.error, /Campaign is not active/);
  const outsideDate = responseCapture();
  handlers.createCampaignRequest({ body: { source_set_id: 'SET-001', campaign_id: campaign.campaign_id, target_date: '2026-08-01' } }, outsideDate);
  assert.equal(outsideDate.statusCode, 400);
  assert.match(outsideDate.body.error, /inside the campaign dates/);
  const duplicate = responseCapture();
  handlers.createCampaignRequest({ body: { source_set_id: 'SET-001', campaign_id: campaign.campaign_id } }, duplicate);
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.body.error, /pending request already exists/);
});
