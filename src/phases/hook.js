'use strict';

const fs = require('fs');
const path = require('path');
const { callGeminiJson } = require('../lib/callGeminiJson');

const REQUIRED_FIELDS = [
  'slider_plan_id',
  'hook_type',
  'hook_options',
  'selected_hook',
  'selection_reason',
  'status',
];

const VALID_HOOK_TYPES = [
  'observation',
  'self_recognition',
  'tension',
  'dry_comedic',
  'pov',
  'contrarian',
];

function validate(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Output is not a JSON object'];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('hook_type' in obj && !VALID_HOOK_TYPES.includes(obj.hook_type)) {
    errors.push(`Invalid hook_type: "${obj.hook_type}"`);
  }

  if ('hook_options' in obj) {
    if (!Array.isArray(obj.hook_options)) {
      errors.push('hook_options must be an array');
    } else if (obj.hook_options.length !== 3) {
      errors.push(`hook_options must contain exactly 3 items, got ${obj.hook_options.length}`);
    }
  }

  return errors.length > 0 ? errors : null;
}

async function run() {
  const root = path.join(__dirname, '..', '..');
  const promptPath = path.join(root, 'prompts', 'hook.txt');
  const inputPath = path.join(root, 'test-outputs', 'sliderPlan.json');
  const outputPath = path.join(root, 'test-outputs', 'hookOutput.json');

  if (!fs.existsSync(promptPath)) {
    console.error(`Error: Missing prompt file at ${promptPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error('Error: test-outputs/sliderPlan.json not found. Run planning first.');
    process.exit(1);
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const plan = fs.readFileSync(inputPath, 'utf8').trim();

  if (!plan) {
    console.error('Error: test-outputs/sliderPlan.json is empty');
    process.exit(1);
  }

  const message = `${prompt}

<slider_plan>
${plan}
</slider_plan>`;

  console.log('Sending to Gemini...');

  let parsed;
  try {
    parsed = await callGeminiJson({ root, phaseName: 'hook', message, validate, temperature: 0.2, maxAttempts: 3 });
  } catch (err) {
    console.error('hook failed:', err.message);
    if (err.validationErrors) err.validationErrors.forEach(e => console.error(` - ${e}`));
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');

  console.log('\n--- hookOutput ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/hookOutput.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
