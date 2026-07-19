'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RenderedOutputStorage, renderedOutputBasePath } = require('../../src/generation/renderedOutputStorage');

function fakeClient() {
  const objects = new Map();
  const bucket = {
    upload: async (key, value) => { objects.set(key, Buffer.from(value)); return { error: null }; },
    download: async (key) => objects.has(key) ? { data: new Blob([objects.get(key)]), error: null } : { data: null, error: { message: 'missing' } },
    createSignedUrl: async (key) => ({ data: { signedUrl: `https://signed.invalid/${key}` }, error: null }),
    createSignedUrls: async (keys) => ({ data: keys.map((key) => ({ signedUrl: `https://signed.invalid/${key}` })), error: null }),
  };
  return { objects, storage: { from: () => bucket } };
}

test('rendered output storage uploads, verifies, signs, retries idempotently, and cleans scratch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-output-storage-'));
  const postFolder = path.join('outputs', 'posts', 'post-test'); const rendered = path.join(root, postFolder, 'rendered');
  fs.mkdirSync(rendered, { recursive: true });
  fs.writeFileSync(path.join(rendered, 'slide-1.png'), Buffer.from('slide-one'));
  fs.writeFileSync(path.join(rendered, 'slide-2.png'), Buffer.from('slide-two'));
  const client = fakeClient(); const service = new RenderedOutputStorage(client, { root, bucket: 'private-test' });
  const input = { campaignId: 'campaign-test', slotId: 'slot-test', postId: 'post-test', language: 'ar', postFolder,
    renderedFiles: [`${postFolder}/rendered/slide-1.png`, `${postFolder}/rendered/slide-2.png`], generatedAt: '2026-07-19T12:00:00.000Z' };
  const first = await service.persist(input); const second = await service.persist(input);
  assert.equal(first.base_path, renderedOutputBasePath(input));
  assert.deepEqual(first.slides.map((slide) => slide.order), [1, 2]);
  assert.equal(first.slides.length, 2); assert.equal(client.objects.size, 4); assert.equal(second.slides.length, 2);
  assert.match(await service.signedSlide(first, 1), /^https:\/\/signed\.invalid\//);
  assert.match(await service.signedZip(first), /^https:\/\/signed\.invalid\//);
  assert.equal((await service.signedPreviews(first)).length, 2);
  await service.cleanupTemporary(postFolder); assert.equal(fs.existsSync(path.join(root, postFolder)), false);
});

test('upload failure preserves render scratch and reports its location', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-output-storage-failure-'));
  const postFolder = path.join('outputs', 'posts', 'post-failure'); const rendered = path.join(root, postFolder, 'rendered');
  fs.mkdirSync(rendered, { recursive: true }); fs.writeFileSync(path.join(rendered, 'slide-1.png'), Buffer.from('slide'));
  const client = { storage: { from: () => ({ upload: async () => ({ error: { message: 'unavailable' } }) }) } };
  const service = new RenderedOutputStorage(client, { root, bucket: 'private-test' });
  await assert.rejects(service.persist({ campaignId: 'campaign-test', slotId: 'slot-test', postId: 'post-failure', language: 'ar', postFolder,
    renderedFiles: [`${postFolder}/rendered/slide-1.png`] }), (error) => error.code === 'RENDERED_OUTPUT_STORAGE_FAILED'
      && error.details.temporary_files_preserved === true && error.message.includes('temporary render files preserved'));
  assert.equal(fs.existsSync(path.join(root, postFolder)), true);
});
