'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createScriptLibraryWriteService, ScriptLibraryWriteError } = require('../../src/injection/scriptLibraryWriteService');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_LIBRARY = path.join(ROOT, 'content', 'script-library');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-injection-'));
  const libraryDir = path.join(root, 'script-library');
  fs.cpSync(REAL_LIBRARY, libraryDir, { recursive: true });
  return { root, libraryDir };
}

function validInput(libraryDir) {
  const original = JSON.parse(fs.readFileSync(path.join(libraryDir, 'source-sets', 'SET-001.json'), 'utf8'));
  return {
    pillar: original.pillar,
    subtopic: original.subtopic,
    topic: 'Temporary injection fixture topic',
    scripts: original.scripts.slice(0, 2).map((script) => ({ ...script, script_id: undefined })),
  };
}

test('creates and indexes the next source set without changing existing sets', (t) => {
  const { root, libraryDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existingPath = path.join(libraryDir, 'source-sets', 'SET-001.json');
  const before = hash(existingPath);
  const service = createScriptLibraryWriteService({ libraryDir });
  assert.equal(service.getNextSourceSetId(), 'SET-045');
  const created = service.createSourceSet(validInput(libraryDir));
  assert.equal(created.source_set_id, 'SET-045');
  assert.equal(created.scripts[0].script_id, 'SET-045-ORIGINAL');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(libraryDir, 'source-sets', 'SET-045.json'), 'utf8')), created);
  const index = JSON.parse(fs.readFileSync(path.join(libraryDir, 'index.json'), 'utf8'));
  assert.equal(index.source_sets.at(-1).source_set_id, 'SET-045');
  assert.equal(hash(existingPath), before);
});

test('rejects duplicate, inconsistent, and invalid IDs', (t) => {
  const { root, libraryDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createScriptLibraryWriteService({ libraryDir });
  const wrongSet = validInput(libraryDir);
  wrongSet.source_set_id = 'SET-044';
  assert.throws(() => service.createSourceSet(wrongSet), ScriptLibraryWriteError);
  const wrongScript = validInput(libraryDir);
  wrongScript.scripts[0].script_id = 'SET-045-V99';
  assert.throws(() => service.createSourceSet(wrongScript), ScriptLibraryWriteError);
  const duplicateVersion = validInput(libraryDir);
  duplicateVersion.scripts[1].script_version = 'Original';
  assert.throws(() => service.createSourceSet(duplicateVersion), ScriptLibraryWriteError);
});

test('rejects invalid taxonomy and slide structure', (t) => {
  const { root, libraryDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createScriptLibraryWriteService({ libraryDir });
  const badTaxonomy = validInput(libraryDir);
  badTaxonomy.pillar = 'Invented Pillar';
  assert.throws(() => service.createSourceSet(badTaxonomy), /Unknown pillar/);
  const badSlide = validInput(libraryDir);
  badSlide.scripts[0].slides[3].slide_label = 'Slide 4';
  assert.throws(() => service.createSourceSet(badSlide), /Metafi/);
  const missingText = validInput(libraryDir);
  missingText.scripts[0].slides[0].text = '';
  assert.throws(() => service.createSourceSet(missingText), /text is required/);
});

test('an index commit failure preserves the original index and removes the new set', (t) => {
  const { root, libraryDir } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexPath = path.join(libraryDir, 'index.json');
  const before = fs.readFileSync(indexPath);
  const service = createScriptLibraryWriteService({
    libraryDir,
    beforeIndexCommit() { throw new Error('simulated index commit failure'); },
  });
  assert.throws(() => service.createSourceSet(validInput(libraryDir)), /simulated index commit failure/);
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal(fs.existsSync(path.join(libraryDir, 'source-sets', 'SET-045.json')), false);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(indexPath, 'utf8')));
});
