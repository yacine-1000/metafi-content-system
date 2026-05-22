'use strict';

const fs   = require('fs');
const path = require('path');
const { callGeminiJson }        = require('../lib/callGeminiJson');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const SCORE_FIELDS = ['core_pain_fit', 'real_life_specificity', 'metafi_differentiation', 'tone_fit', 'product_restraint'];

function validate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Output is not a JSON object'];
  const errors = [];
  const required = ['content_type', 'content_relationship', 'allowed', 'strategy_score', 'score_breakdown', 'drift_risk', 'metafi_fit', 'primary_pain', 'fix_required', 'issues', 'improvement_suggestions', 'advisory_notes', 'reasoning_summary', 'status'];
  for (const f of required) if (!(f in obj)) errors.push(`Missing field: ${f}`);
  if (!['direct_metafi', 'sports_gym', 'gym_life_relatable', 'general_fitness', 'off_brand'].includes(obj.content_type)) errors.push(`Invalid content_type: "${obj.content_type}"`);
  if (!['direct', 'adjacent', 'broad', 'off_world'].includes(obj.content_relationship)) errors.push(`Invalid content_relationship: "${obj.content_relationship}"`);
  if ('allowed' in obj && typeof obj.allowed !== 'boolean') errors.push('allowed must be a boolean');
  if (!['low', 'medium', 'high'].includes(obj.drift_risk)) errors.push(`Invalid drift_risk: "${obj.drift_risk}"`);
  if (!['strong', 'usable', 'needs_fix', 'reject'].includes(obj.metafi_fit)) errors.push(`Invalid metafi_fit: "${obj.metafi_fit}"`);
  if (obj.status !== 'checked') errors.push(`status must be "checked"`);
  if (!Array.isArray(obj.issues)) errors.push('issues must be an array');
  if (!Array.isArray(obj.improvement_suggestions)) errors.push('improvement_suggestions must be an array');
  if (!Array.isArray(obj.advisory_notes)) errors.push('advisory_notes must be an array');
  if (obj.score_breakdown && typeof obj.score_breakdown === 'object') {
    const sum = SCORE_FIELDS.reduce((acc, k) => acc + (Number(obj.score_breakdown[k]) || 0), 0);
    if (sum !== Number(obj.strategy_score)) errors.push(`strategy_score ${obj.strategy_score} does not equal sum of score_breakdown (${sum})`);
  }
  return errors.length > 0 ? errors : null;
}

async function run() {
  const root = path.join(__dirname, '..', '..');

  const doctrinePath  = path.join(root, 'knowledge', 'metafi-content-doctrine.md');
  const promptPath    = path.join(root, 'prompts', 'strategy-check.txt');
  const briefPath     = resolvePath(root, 'METAFI_CLEANED_SOURCE_INPUT', 'test-outputs/cleanedSourceBrief.json');
  const planPath      = resolvePath(root, 'METAFI_SLIDER_PLAN_INPUT',    'test-outputs/sliderPlan.json');
  const hookPath      = resolvePath(root, 'METAFI_HOOK_INPUT',           'test-outputs/hookOutput.json');
  const bodyPath      = resolvePath(root, 'METAFI_BODY_INPUT',           'test-outputs/bodyOutput.json');
  const finalPath     = resolvePath(root, 'METAFI_FINAL_SLIDE_INPUT',    'test-outputs/finalSlideOutput.json');
  const captionPath   = resolvePath(root, 'METAFI_CAPTION_INPUT',        'test-outputs/captionOutput.json');
  const outputPath    = resolvePath(root, 'METAFI_STRATEGY_CHECK_OUTPUT','test-outputs/strategyCheck.json');

  for (const [label, p] of [
    ['knowledge/metafi-content-doctrine.md', doctrinePath],
    ['prompts/strategy-check.txt', promptPath],
    ['cleanedSourceBrief.json', briefPath],
    ['sliderPlan.json', planPath],
    ['hookOutput.json', hookPath],
    ['bodyOutput.json', bodyPath],
    ['finalSlideOutput.json', finalPath],
    ['captionOutput.json', captionPath],
  ]) {
    if (!fs.existsSync(p)) { console.error(`Error: Missing file: ${label} at ${p}`); process.exit(1); }
  }

  const doctrine = fs.readFileSync(doctrinePath, 'utf8');
  const prompt   = fs.readFileSync(promptPath, 'utf8')
    .replace('{{METAFI_CONTENT_DOCTRINE}}', doctrine)
    .replace('{{CLEANED_SOURCE_BRIEF}}',    fs.readFileSync(briefPath,  'utf8'))
    .replace('{{SLIDER_PLAN}}',             fs.readFileSync(planPath,   'utf8'))
    .replace('{{HOOK_OUTPUT}}',             fs.readFileSync(hookPath,   'utf8'))
    .replace('{{BODY_OUTPUT}}',             fs.readFileSync(bodyPath,   'utf8'))
    .replace('{{FINAL_SLIDE_OUTPUT}}',      fs.readFileSync(finalPath,  'utf8'))
    .replace('{{CAPTION_OUTPUT}}',          fs.readFileSync(captionPath,'utf8'));

  console.log('Sending to Gemini...');
  let parsed;
  try {
    parsed = await callGeminiJson({ root, phaseName: 'strategy-check', message: prompt, validate, temperature: 0.1, maxAttempts: 3 });
  } catch (err) {
    console.error('strategy-check failed:', err.message);
    if (err.validationErrors) err.validationErrors.forEach(e => console.error(` - ${e}`));
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.writeFileSync(ensureParentDir(outputPath), output, 'utf8');
  console.log('\n--- strategyCheck ---\n');
  console.log(output);
  console.log('\nSaved →', outputPath);
}

run().catch(err => { console.error(err?.message || err); process.exit(1); });
