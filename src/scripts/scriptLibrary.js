'use strict';

const fs = require('fs');
const path = require('path');
const { getCoolingScriptIds } = require('../publication/publicationService');

const ROOT = path.resolve(__dirname, '../..');
const LIBRARY_DIR = path.join(ROOT, 'content', 'script-library');
const INDEX_PATH = path.join(LIBRARY_DIR, 'index.json');
const SOURCE_SET_ID_PATTERN = /^SET-\d{3,}$/;
const PILLAR_NAMES = Object.freeze({
  p1: 'Changed Week / What Should I Train Today?',
  p2: 'Hybrid Athlete / Sport + Gym Balance',
  p3: 'Workout Programming / Exercise Selection',
  p4: 'Body Transformation / Aesthetic Progress',
});
const PILLAR_IDS = Object.freeze(Object.fromEntries(Object.entries(PILLAR_NAMES).map(([id, name]) => [name, id])));
let indexCache = null;
const sourceSetCache = new Map();

function fileVersion(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}:${stat.size}`;
}

function invalidateScriptLibraryCache() {
  indexCache = null;
  sourceSetCache.clear();
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${path.relative(ROOT, filePath)}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function loadIndex() {
  const version = fileVersion(INDEX_PATH);
  if (indexCache && indexCache.version === version) return indexCache.value;
  const index = readJson(INDEX_PATH, 'Script Library index');
  if (!Array.isArray(index.source_sets)) throw new Error('Script Library index must contain source_sets');
  indexCache = { version, value: index };
  return index;
}

function getSourceSet(sourceSetId) {
  if (typeof sourceSetId !== 'string' || !SOURCE_SET_ID_PATTERN.test(sourceSetId)) throw new Error('Invalid Source Set ID');
  const entry = loadIndex().source_sets.find((sourceSet) => sourceSet.source_set_id === sourceSetId);
  if (!entry) return null;
  const filePath = path.resolve(LIBRARY_DIR, entry.file);
  if (!filePath.startsWith(path.resolve(LIBRARY_DIR) + path.sep)) throw new Error('Script Library index contains an unsafe Source Set path');
  const version = fileVersion(filePath);
  const cached = sourceSetCache.get(sourceSetId);
  if (cached && cached.version === version) return cached.value;
  const value = readJson(filePath, `Source Set ${sourceSetId}`);
  sourceSetCache.set(sourceSetId, { version, value });
  return value;
}

function findSourceSets({ pillar, subtopic, hook_type: hookType } = {}) {
  return loadIndex().source_sets.filter((sourceSet) => (
    (!pillar || sourceSet.pillar === pillar)
    && (!subtopic || sourceSet.subtopic === subtopic)
    && (!hookType || sourceSet.hook_types.includes(hookType))
  ));
}

function adaptArabicScript(sourceSet, entry, { hookType, visualHookType }) {
  if (!sourceSet || !entry || !Array.isArray(entry.slides)) throw new Error('Arabic Script Library entry is invalid');
  const slides = entry.slides.map((slide) => ({
    slide_number: slide.slide_number,
    role: slide.slide_number === 1 ? 'hook' : slide.slide_number === 4 ? 'app' : 'body',
    asset_bank: slide.slide_number === 1 ? 'visual_hooks' : slide.slide_number === 4 ? 'app_icon_home_screen' : 'body_slides',
    text: slide.text,
  }));
  const hookSlide = slides.find((slide) => slide.slide_number === 1);
  const appSlide = slides.find((slide) => slide.slide_number === 4);
  if (!hookSlide || !appSlide) throw new Error(`Arabic Script Library entry ${entry.script_id} must contain slides 1 and 4`);
  return {
    topic: {
      id: sourceSet.source_set_id,
      pillar_id: PILLAR_IDS[sourceSet.pillar] || sourceSet.pillar,
      topic_name: sourceSet.topic,
    },
    script: {
      id: entry.script_id,
      master_script_id: entry.script_id,
      hook_type: hookType,
      visual_hook_type: visualHookType,
      slide_count: entry.final_slide_count,
      cta_slide: 4,
      language: 'ar',
      versions: {
        ar: {
          hook_text: hookSlide.text,
          slides,
        },
      },
    },
  };
}

function selectArabicRuntimeScript({
  pillarId,
  hookType,
  visualHookType,
  accountId = null,
  publicationRoot,
  now,
  cooldownMs,
  usedScriptIds = [],
  excludedScriptIds = [],
  requiredSourceSetId = null,
  avoidedSourceSetIds = [],
  timings = null,
  coolingScriptIds: providedCoolingScriptIds = null,
}) {
  const mark = (stage, startedAt) => { if (timings) timings[stage] = (timings[stage] || 0) + (performance.now() - startedAt); };
  const pillar = PILLAR_NAMES[pillarId];
  if (!pillar) return null;
  const requestedFormat = String(hookType || '').toLowerCase();
  const usedScripts = new Set(usedScriptIds);
  const excludedScripts = new Set(excludedScriptIds);
  const avoidedSourceSets = new Set(avoidedSourceSetIds);
  const eligible = [];
  let startedAt = performance.now();
  const sourceSets = findSourceSets({ pillar });
  mark('script_library_loading_ms', startedAt);
  startedAt = performance.now();
  const filteredSourceSets = requiredSourceSetId ? sourceSets.filter((entry) => entry.source_set_id === requiredSourceSetId) : sourceSets;
  mark('source_set_filtering_ms', startedAt);
  startedAt = performance.now();
  for (const indexEntry of filteredSourceSets) {
    const sourceSet = getSourceSet(indexEntry.source_set_id);
    for (const entry of sourceSet.scripts) {
      if (!requestedFormat
        || String(entry.format).toLowerCase() === requestedFormat
        || String(entry.hook_type).toLowerCase() === requestedFormat) {
        eligible.push({ sourceSet, entry });
      }
    }
  }
  mark('hook_format_filtering_ms', startedAt);
  if (!eligible.length) return null;
  startedAt = performance.now();
  const coolingScriptIds = providedCoolingScriptIds || (accountId
    ? getCoolingScriptIds(accountId, { root: publicationRoot, now, cooldownMs })
    : new Set());
  mark('cooldown_lookup_ms', startedAt);
  const publicationEligible = eligible.filter(({ entry }) => !coolingScriptIds.has(entry.script_id) && !excludedScripts.has(entry.script_id));
  if (!publicationEligible.length) {
    throw new Error(`No eligible Arabic Script Library script remains for account "${accountId}" after publication cooldown and slot exclusions`);
  }
  const unused = publicationEligible.filter(({ entry }) => !usedScripts.has(entry.script_id));
  const reusePool = unused.length ? unused : publicationEligible;
  const differentSourceSets = reusePool.filter(({ sourceSet }) => !avoidedSourceSets.has(sourceSet.source_set_id));
  startedAt = performance.now();
  const selected = (differentSourceSets.length ? differentSourceSets : reusePool)[0];
  mark('final_script_choice_ms', startedAt);
  return adaptArabicScript(selected.sourceSet, selected.entry, { hookType, visualHookType });
}

module.exports = { adaptArabicScript, findSourceSets, getSourceSet, invalidateScriptLibraryCache, loadIndex, selectArabicRuntimeScript };
