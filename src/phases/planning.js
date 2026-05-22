'use strict';

const fs = require('fs');
const path = require('path');
const { callGeminiJson } = require('../lib/callGeminiJson');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const REQUIRED_FIELDS = [
  'slider_plan_id',
  'chosen_angle',
  'why_this_angle',
  'content_relationship',
  'human_truth',
  'texture_to_preserve',
  'what_not_to_force',
  'slide_count',
  'slide_roles',
  'tone_direction',
  'status',
];

const VALID_CONTENT_RELATIONSHIPS = ['direct', 'adjacent', 'broad', 'off_world'];

const SLIDE_ROLE_FIELDS = ['slide_number', 'role', 'purpose', 'key_point'];

function validate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Output is not a JSON object'];
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('content_relationship' in obj && !VALID_CONTENT_RELATIONSHIPS.includes(obj.content_relationship)) {
    errors.push(`Invalid content_relationship: "${obj.content_relationship}"`);
  }

  if ('chosen_angle' in obj && !VALID_CONTENT_RELATIONSHIPS.includes(obj.chosen_angle)) {
    errors.push(`Invalid chosen_angle: "${obj.chosen_angle}"`);
  }

  if ('slide_count' in obj && obj.slide_count !== 5) {
    errors.push(`slide_count must be 5`);
  }

  if ('texture_to_preserve' in obj && !Array.isArray(obj.texture_to_preserve)) {
    errors.push('texture_to_preserve must be an array');
  }

  if ('what_not_to_force' in obj && !Array.isArray(obj.what_not_to_force)) {
    errors.push('what_not_to_force must be an array');
  }

  if ('slide_roles' in obj) {
    if (!Array.isArray(obj.slide_roles)) {
      errors.push('slide_roles must be an array');
    } else {
      if (obj.slide_roles.length !== 5) errors.push(`slide_roles must have exactly 5 items (got ${obj.slide_roles.length})`);
      obj.slide_roles.forEach((slide, i) => {
        for (const f of SLIDE_ROLE_FIELDS) {
          if (!(f in slide)) errors.push(`slide_roles[${i}] missing field: ${f}`);
        }
      });
    }
  }

  if ('status' in obj && obj.status !== 'planned') errors.push('status must be "planned"');

  return errors.length > 0 ? errors : null;
}

async function run() {
  const root = path.join(__dirname, '..', '..');
  const promptPath = path.join(root, 'prompts', 'planning.txt');
  const inputPath = resolvePath(root, 'METAFI_CLEANED_SOURCE_INPUT', 'test-outputs/cleanedSourceBrief.json');
  const outputPath = resolvePath(root, 'METAFI_SLIDER_PLAN_OUTPUT', 'test-outputs/sliderPlan.json');

  if (!fs.existsSync(promptPath)) {
    console.error(`Error: Missing prompt file at ${promptPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error('Error: test-outputs/cleanedSourceBrief.json not found. Run intake first.');
    process.exit(1);
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const briefRaw = fs.readFileSync(inputPath, 'utf8').trim();

  if (!briefRaw) {
    console.error('Error: test-outputs/cleanedSourceBrief.json is empty');
    process.exit(1);
  }

  const message = prompt.replace('{{SOURCE_NOTES}}', briefRaw);

  console.log('Sending to Gemini...');

  let parsed;
  try {
    parsed = await callGeminiJson({ root, phaseName: 'planning', message, validate, temperature: 0.3, maxAttempts: 3 });
  } catch (err) {
    console.error('planning failed:', err.message);
    if (err.validationErrors) err.validationErrors.forEach(e => console.error(` - ${e}`));
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.writeFileSync(ensureParentDir(outputPath), output, 'utf8');

  console.log('\n--- sliderPlan ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/sliderPlan.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
