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

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${path.relative(ROOT, filePath)}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function loadIndex() {
  const index = readJson(INDEX_PATH, 'Script Library index');
  if (!Array.isArray(index.source_sets)) throw new Error('Script Library index must contain source_sets');
  return index;
}

function getSourceSet(sourceSetId) {
  if (typeof sourceSetId !== 'string' || !SOURCE_SET_ID_PATTERN.test(sourceSetId)) throw new Error('Invalid Source Set ID');
  const entry = loadIndex().source_sets.find((sourceSet) => sourceSet.source_set_id === sourceSetId);
  if (!entry) return null;
  const filePath = path.resolve(LIBRARY_DIR, entry.file);
  if (!filePath.startsWith(path.resolve(LIBRARY_DIR) + path.sep)) throw new Error('Script Library index contains an unsafe Source Set path');
  return readJson(filePath, `Source Set ${sourceSetId}`);
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
  avoidedSourceSetIds = [],
}) {
  const pillar = PILLAR_NAMES[pillarId];
  if (!pillar) return null;
  const requestedFormat = String(hookType || '').toLowerCase();
  const usedScripts = new Set(usedScriptIds);
  const avoidedSourceSets = new Set(avoidedSourceSetIds);
  const eligible = [];
  for (const indexEntry of findSourceSets({ pillar })) {
    const sourceSet = getSourceSet(indexEntry.source_set_id);
    for (const entry of sourceSet.scripts) {
      if (!requestedFormat
        || String(entry.format).toLowerCase() === requestedFormat
        || String(entry.hook_type).toLowerCase() === requestedFormat) {
        eligible.push({ sourceSet, entry });
      }
    }
  }
  if (!eligible.length) return null;
  const coolingScriptIds = accountId
    ? getCoolingScriptIds(accountId, { root: publicationRoot, now, cooldownMs })
    : new Set();
  const publicationEligible = eligible.filter(({ entry }) => !coolingScriptIds.has(entry.script_id));
  if (!publicationEligible.length) {
    throw new Error(`No eligible Arabic Script Library script remains for account "${accountId}" after confirmed-publication cooldown`);
  }
  const unused = publicationEligible.filter(({ entry }) => !usedScripts.has(entry.script_id));
  const reusePool = unused.length ? unused : publicationEligible;
  const differentSourceSets = reusePool.filter(({ sourceSet }) => !avoidedSourceSets.has(sourceSet.source_set_id));
  const selected = (differentSourceSets.length ? differentSourceSets : reusePool)[0];
  return adaptArabicScript(selected.sourceSet, selected.entry, { hookType, visualHookType });
}

module.exports = { adaptArabicScript, findSourceSets, getSourceSet, loadIndex, selectArabicRuntimeScript };
