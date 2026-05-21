'use strict';

const fs = require('fs');
const path = require('path');
const { callGeminiJson } = require('../lib/callGeminiJson');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const REQUIRED_FIELDS = [
  'slider_plan_id',
  'selected_hook',
  'final_slide_text',
  'closing_type',
  'brand_bridge_text',
  'closing_notes',
  'status',
];

const VALID_CLOSING_TYPES = ['flat_realization', 'soft_reframe', 'comment_question'];

function validate(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Output is not a JSON object'];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('closing_type' in obj && !VALID_CLOSING_TYPES.includes(obj.closing_type)) {
    errors.push(`Invalid closing_type: "${obj.closing_type}"`);
  }

  return errors.length > 0 ? errors : null;
}

async function run() {
  const root = path.join(__dirname, '..', '..');
  const promptPath = path.join(root, 'prompts', 'final-slide.txt');
  const planPath = resolvePath(root, 'METAFI_SLIDER_PLAN_INPUT', 'test-outputs/sliderPlan.json');
  const hookPath = resolvePath(root, 'METAFI_HOOK_INPUT', 'test-outputs/hookOutput.json');
  const bodyPath = resolvePath(root, 'METAFI_BODY_INPUT', 'test-outputs/bodyOutput.json');
  const outputPath = resolvePath(root, 'METAFI_FINAL_SLIDE_OUTPUT', 'test-outputs/finalSlideOutput.json');

  for (const [label, p] of [
    ['prompts/final-slide.txt', promptPath],
    ['test-outputs/sliderPlan.json', planPath],
    ['test-outputs/hookOutput.json', hookPath],
    ['test-outputs/bodyOutput.json', bodyPath],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`Error: Missing file at ${label}`);
      process.exit(1);
    }
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const plan = fs.readFileSync(planPath, 'utf8').trim();
  const hook = fs.readFileSync(hookPath, 'utf8').trim();
  const body = fs.readFileSync(bodyPath, 'utf8').trim();

  const message = `${prompt}

<slider_plan>
${plan}
</slider_plan>

<hook_output>
${hook}
</hook_output>

<body_output>
${body}
</body_output>`;

  console.log('Sending to Gemini...');

  let parsed;
  try {
    parsed = await callGeminiJson({ root, phaseName: 'final-slide', message, validate, temperature: 0.2, maxAttempts: 3 });
  } catch (err) {
    console.error('final-slide failed:', err.message);
    if (err.validationErrors) err.validationErrors.forEach(e => console.error(` - ${e}`));
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.writeFileSync(ensureParentDir(outputPath), output, 'utf8');

  console.log('\n--- finalSlideOutput ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/finalSlideOutput.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
