'use strict';

const fs = require('fs');
const path = require('path');
const { getCoolingScriptIds } = require('../publication/publicationService');

const ROOT = path.resolve(__dirname, '../..');
const LIBRARY_DIRECTORIES = Object.freeze({
  ar: path.join(ROOT, 'content', 'script-library'),
  en: path.join(ROOT, 'content', 'script-library-en'),
});
const SOURCE_SET_ID_PATTERN = /^SET-\d{3,}$/;
const PILLAR_NAMES = Object.freeze({
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  p4: 'P4',
});
const PILLAR_IDS = Object.freeze(Object.fromEntries(Object.entries(PILLAR_NAMES).map(([id, name]) => [name, id])));
const indexCache = new Map();
const sourceSetCache = new Map();

function getLibraryDir(language = 'ar') {
  const libraryDir = LIBRARY_DIRECTORIES[language];
  if (!libraryDir) throw new Error(`Unsupported Script Library language: ${language}`);
  return libraryDir;
}

function fileVersion(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}:${stat.size}`;
}

function invalidateScriptLibraryCache(language = null) {
  if (language == null) {
    indexCache.clear();
    sourceSetCache.clear();
    return;
  }
  getLibraryDir(language);
  indexCache.delete(language);
  for (const key of sourceSetCache.keys()) if (key.startsWith(`${language}:`)) sourceSetCache.delete(key);
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${path.relative(ROOT, filePath)}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function loadIndex(language = 'ar') {
  const indexPath = path.join(getLibraryDir(language), 'index.json');
  const version = fileVersion(indexPath);
  const cached = indexCache.get(language);
  if (cached && cached.version === version) return cached.value;
  const index = readJson(indexPath, 'Script Library index');
  if (!Array.isArray(index.source_sets)) throw new Error('Script Library index must contain source_sets');
  indexCache.set(language, { version, value: index });
  return index;
}

function getSourceSet(sourceSetId, language = 'ar') {
  if (typeof sourceSetId !== 'string' || !SOURCE_SET_ID_PATTERN.test(sourceSetId)) throw new Error('Invalid Source Set ID');
  const libraryDir = getLibraryDir(language);
  const entry = loadIndex(language).source_sets.find((sourceSet) => sourceSet.source_set_id === sourceSetId);
  if (!entry) return null;
  const filePath = path.resolve(libraryDir, entry.file);
  if (!filePath.startsWith(path.resolve(libraryDir) + path.sep)) throw new Error('Script Library index contains an unsafe Source Set path');
  const version = fileVersion(filePath);
  const cacheKey = `${language}:${sourceSetId}`;
  const cached = sourceSetCache.get(cacheKey);
  if (cached && cached.version === version) return cached.value;
  const value = readJson(filePath, `Source Set ${sourceSetId}`);
  sourceSetCache.set(cacheKey, { version, value });
  return value;
}

function findSourceSets({ pillar, subtopic, hook_type: hookType, language = 'ar' } = {}) {
  return loadIndex(language).source_sets.filter((sourceSet) => (
    (!pillar || sourceSet.pillar === pillar)
    && (!subtopic || sourceSet.subtopic === subtopic)
    && (!hookType || sourceSet.hook_types.includes(hookType))
  ));
}

function adaptLibraryScript(sourceSet, entry, { language, hookType, visualHookType }) {
  if (!sourceSet || !entry || !Array.isArray(entry.slides)) throw new Error(`${language} Script Library entry is invalid`);
  const metafiSlides = entry.slides.filter((slide) => slide && slide.is_metafi_slide === true);
  if (metafiSlides.length !== 1) throw new Error(`${language} Script Library entry ${entry.script_id} must contain exactly one is_metafi_slide marker; found ${metafiSlides.length}`);
  const ctaSlideNumber = metafiSlides[0].slide_number;
  if (!Number.isInteger(ctaSlideNumber)) throw new Error(`${language} Script Library entry ${entry.script_id} has an invalid Metafi slide number`);
  const slides = entry.slides.map((slide) => ({
    slide_number: slide.slide_number,
    role: slide.slide_number === 1 ? 'hook' : slide.slide_number === ctaSlideNumber ? 'app' : 'body',
    asset_bank: slide.slide_number === 1 ? 'visual_hooks' : slide.slide_number === ctaSlideNumber ? 'app_icon_home_screen' : 'body_slides',
    text: slide.text,
  }));
  const hookSlide = slides.find((slide) => slide.slide_number === 1);
  const appSlide = slides.find((slide) => slide.slide_number === ctaSlideNumber);
  if (!hookSlide || !appSlide) throw new Error(`${language} Script Library entry ${entry.script_id} must contain a hook and a marked app CTA`);
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
      cta_slide: ctaSlideNumber,
      language,
      versions: {
        [language]: {
          hook_text: hookSlide.text,
          slides,
        },
      },
    },
  };
}

function selectLibraryRuntimeScript({
  language = 'ar',
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
  if (!LIBRARY_DIRECTORIES[language]) return null;
  const sourceSets = findSourceSets({ pillar, language });
  mark('script_library_loading_ms', startedAt);
  startedAt = performance.now();
  const filteredSourceSets = requiredSourceSetId ? sourceSets.filter((entry) => entry.source_set_id === requiredSourceSetId) : sourceSets;
  mark('source_set_filtering_ms', startedAt);
  startedAt = performance.now();
  for (const indexEntry of filteredSourceSets) {
    const sourceSet = getSourceSet(indexEntry.source_set_id, language);
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
    throw new Error(`No eligible ${language} Script Library script remains for account "${accountId}" after publication cooldown and slot exclusions`);
  }
  const unused = publicationEligible.filter(({ entry }) => !usedScripts.has(entry.script_id));
  const reusePool = unused.length ? unused : publicationEligible;
  const differentSourceSets = reusePool.filter(({ sourceSet }) => !avoidedSourceSets.has(sourceSet.source_set_id));
  startedAt = performance.now();
  const selected = (differentSourceSets.length ? differentSourceSets : reusePool)[0];
  mark('final_script_choice_ms', startedAt);
  return adaptLibraryScript(selected.sourceSet, selected.entry, { language, hookType, visualHookType });
}

function adaptArabicScript(sourceSet, entry, options) {
  return adaptLibraryScript(sourceSet, entry, { ...options, language: 'ar' });
}

function selectArabicRuntimeScript(options) {
  return selectLibraryRuntimeScript({ ...options, language: 'ar' });
}

module.exports = { adaptArabicScript, adaptLibraryScript, findSourceSets, getLibraryDir, getSourceSet, invalidateScriptLibraryCache, loadIndex, selectArabicRuntimeScript, selectLibraryRuntimeScript };
