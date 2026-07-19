'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_SET_PATTERN = /^SET-(\d{3,})$/;
const VERSION_PATTERN = /^(Original|Variation ([1-9]\d*))$/;

class ScriptLibraryWriteError extends Error {}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ScriptLibraryWriteError(`Cannot read valid JSON from ${filePath}: ${error.message}`);
  }
}

function writeTemp(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return temporaryPath;
}

function requiredText(value, location) {
  if (typeof value !== 'string' || value.trim() === '') throw new ScriptLibraryWriteError(`${location} is required`);
  return value;
}

function canonicalScriptId(sourceSetId, version) {
  return version === 'Original' ? `${sourceSetId}-ORIGINAL` : `${sourceSetId}-V${VERSION_PATTERN.exec(version)[2]}`;
}

function loadRuntimeTruth(libraryDir, index) {
  const pillars = new Set();
  const subtopics = new Map();
  const hookTypes = new Set();
  const formats = new Set();
  const scriptIds = new Set();

  for (const entry of index.source_sets) {
    const sourceSet = readJson(path.join(libraryDir, entry.file));
    if (sourceSet.source_set_id !== entry.source_set_id) {
      throw new ScriptLibraryWriteError(`Index entry ${entry.source_set_id} does not match its source-set file`);
    }
    pillars.add(sourceSet.pillar);
    if (subtopics.has(sourceSet.subtopic) && subtopics.get(sourceSet.subtopic) !== sourceSet.pillar) {
      throw new ScriptLibraryWriteError(`Runtime taxonomy maps Subtopic "${sourceSet.subtopic}" to multiple Pillars`);
    }
    subtopics.set(sourceSet.subtopic, sourceSet.pillar);
    for (const script of sourceSet.scripts) {
      if (scriptIds.has(script.script_id)) throw new ScriptLibraryWriteError(`Runtime library duplicates Script ID "${script.script_id}"`);
      scriptIds.add(script.script_id);
      hookTypes.add(script.hook_type);
      formats.add(script.format);
    }
  }
  return { pillars, subtopics, hookTypes, formats, scriptIds };
}

function nextSourceSetId(index, sourceSetsDir) {
  const ids = new Set(index.source_sets.map((entry) => entry.source_set_id));
  for (const filename of fs.readdirSync(sourceSetsDir)) {
    if (/^SET-\d{3,}\.json$/.test(filename)) ids.add(path.basename(filename, '.json'));
  }
  let maximum = 0;
  for (const id of ids) {
    const match = SOURCE_SET_PATTERN.exec(id);
    if (!match) throw new ScriptLibraryWriteError(`Index contains unsafe Source Set ID "${id}"`);
    maximum = Math.max(maximum, Number(match[1]));
  }
  return `SET-${String(maximum + 1).padStart(3, '0')}`;
}

function validateSourceSet(input, sourceSetId, taxonomy) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScriptLibraryWriteError('Source-set input must be an object');
  if (input.source_set_id != null && input.source_set_id !== sourceSetId) {
    throw new ScriptLibraryWriteError(`source_set_id must be the next safe ID "${sourceSetId}"`);
  }
  const pillar = requiredText(input.pillar, 'pillar');
  const subtopic = requiredText(input.subtopic, 'subtopic');
  const topic = requiredText(input.topic, 'topic');
  if (!taxonomy.pillars.has(pillar)) throw new ScriptLibraryWriteError(`Unknown pillar "${pillar}"`);
  if (!taxonomy.subtopics.has(subtopic)) throw new ScriptLibraryWriteError(`Unknown subtopic "${subtopic}"`);
  if (taxonomy.subtopics.get(subtopic) !== pillar) throw new ScriptLibraryWriteError(`Subtopic "${subtopic}" does not belong to pillar "${pillar}"`);
  if (!Array.isArray(input.scripts) || input.scripts.length === 0) throw new ScriptLibraryWriteError('scripts must be a non-empty array');

  const ids = new Set();
  const versions = new Set();
  const scripts = input.scripts.map((script, scriptIndex) => {
    const at = `scripts[${scriptIndex}]`;
    if (!script || typeof script !== 'object' || Array.isArray(script)) throw new ScriptLibraryWriteError(`${at} must be an object`);
    const version = requiredText(script.script_version, `${at}.script_version`);
    if (!VERSION_PATTERN.test(version)) throw new ScriptLibraryWriteError(`${at}.script_version is invalid`);
    if (versions.has(version)) throw new ScriptLibraryWriteError(`${at}.script_version duplicates "${version}"`);
    versions.add(version);
    const expectedId = canonicalScriptId(sourceSetId, version);
    const scriptId = script.script_id == null ? expectedId : requiredText(script.script_id, `${at}.script_id`);
    if (scriptId !== expectedId) throw new ScriptLibraryWriteError(`${at}.script_id must be "${expectedId}"`);
    if (ids.has(scriptId) || taxonomy.scriptIds.has(scriptId)) throw new ScriptLibraryWriteError(`${at}.script_id duplicates "${scriptId}"`);
    ids.add(scriptId);
    const hookType = requiredText(script.hook_type, `${at}.hook_type`);
    const format = requiredText(script.format, `${at}.format`);
    if (!taxonomy.hookTypes.has(hookType)) throw new ScriptLibraryWriteError(`${at}.hook_type is unknown`);
    if (!taxonomy.formats.has(format)) throw new ScriptLibraryWriteError(`${at}.format is unknown`);
    if (!Number.isInteger(script.original_slide_count) || script.original_slide_count < 1) throw new ScriptLibraryWriteError(`${at}.original_slide_count must be a positive integer`);
    if (!Number.isInteger(script.final_slide_count) || script.final_slide_count < 1 || script.final_slide_count > 12) throw new ScriptLibraryWriteError(`${at}.final_slide_count must be an integer from 1 to 12`);
    if (script.final_slide_count !== script.original_slide_count + 1) throw new ScriptLibraryWriteError(`${at}.final_slide_count must equal original_slide_count + 1`);
    if (!Array.isArray(script.slides) || script.slides.length !== script.final_slide_count) throw new ScriptLibraryWriteError(`${at}.slides must match final_slide_count`);
    const slides = script.slides.map((slide, slideIndex) => {
      const number = slideIndex + 1;
      const slideAt = `${at}.slides[${slideIndex}]`;
      if (!slide || slide.slide_number !== number) throw new ScriptLibraryWriteError(`${slideAt}.slide_number must be ${number}`);
      const isMetafi = number === 4;
      const expectedLabel = isMetafi ? 'Slide 4 — Metafi' : `Slide ${number}`;
      if (slide.slide_label !== expectedLabel) throw new ScriptLibraryWriteError(`${slideAt}.slide_label must be "${expectedLabel}"`);
      if (slide.is_metafi_slide !== isMetafi) throw new ScriptLibraryWriteError(`${slideAt}.is_metafi_slide must be ${isMetafi}`);
      return { slide_number: number, slide_label: expectedLabel, is_metafi_slide: isMetafi, text: requiredText(slide.text, `${slideAt}.text`) };
    });
    if (script.final_slide_count < 4) throw new ScriptLibraryWriteError(`${at} must include the labeled Metafi slide`);
    return { script_id: scriptId, script_version: version, hook_type: hookType, format, original_slide_count: script.original_slide_count, final_slide_count: script.final_slide_count, slides };
  });
  if (!versions.has('Original')) throw new ScriptLibraryWriteError('Source set must contain one Original script');
  return { source_set_id: sourceSetId, pillar, subtopic, topic, scripts };
}

function createScriptLibraryWriteService(options = {}) {
  const libraryDir = path.resolve(options.libraryDir || path.join(__dirname, '..', '..', 'content', 'script-library'));
  const sourceSetsDir = path.join(libraryDir, 'source-sets');
  const indexPath = path.join(libraryDir, 'index.json');
  const lockPath = path.join(libraryDir, '.injection-write.lock');

  function getNextSourceSetId() {
    const index = readJson(indexPath);
    if (!index || !Array.isArray(index.source_sets)) throw new ScriptLibraryWriteError('index.json must contain source_sets');
    return nextSourceSetId(index, sourceSetsDir);
  }

  function createSourceSet(input) {
    let lock;
    try {
      lock = fs.openSync(lockPath, 'wx');
    } catch (error) {
      throw new ScriptLibraryWriteError(`Script Library write is already in progress: ${error.message}`);
    }
    let sourceTemp;
    let indexTemp;
    let sourcePath;
    try {
      const index = readJson(indexPath);
      if (!index || !Array.isArray(index.source_sets)) throw new ScriptLibraryWriteError('index.json must contain source_sets');
      const taxonomy = loadRuntimeTruth(libraryDir, index);
      const sourceSetId = nextSourceSetId(index, sourceSetsDir);
      const sourceSet = validateSourceSet(input, sourceSetId, taxonomy);
      sourcePath = path.join(sourceSetsDir, `${sourceSetId}.json`);
      if (fs.existsSync(sourcePath)) throw new ScriptLibraryWriteError(`${sourceSetId} already exists`);
      const entry = { source_set_id: sourceSetId, file: `source-sets/${sourceSetId}.json`, pillar: sourceSet.pillar, subtopic: sourceSet.subtopic, topic: sourceSet.topic, hook_types: [...new Set(sourceSet.scripts.map((script) => script.hook_type))], script_count: sourceSet.scripts.length };
      const updatedIndex = { ...index, source_sets: [...index.source_sets, entry] };
      sourceTemp = writeTemp(sourcePath, sourceSet);
      indexTemp = writeTemp(indexPath, updatedIndex);
      if (options.beforeCommit) options.beforeCommit({ sourceSet, updatedIndex });
      fs.renameSync(sourceTemp, sourcePath);
      sourceTemp = null;
      try {
        if (options.beforeIndexCommit) options.beforeIndexCommit({ sourceSet, updatedIndex });
        fs.renameSync(indexTemp, indexPath);
        indexTemp = null;
      } catch (error) {
        fs.unlinkSync(sourcePath);
        throw error;
      }
      return sourceSet;
    } catch (error) {
      if (error instanceof ScriptLibraryWriteError) throw error;
      throw new ScriptLibraryWriteError(`Source-set write failed: ${error.message}`);
    } finally {
      for (const temporaryPath of [sourceTemp, indexTemp]) {
        if (temporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
      if (lock != null) fs.closeSync(lock);
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
  }
  return { getNextSourceSetId, createSourceSet };
}

module.exports = { ScriptLibraryWriteError, createScriptLibraryWriteService };
