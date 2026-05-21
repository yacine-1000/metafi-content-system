'use strict';

const fs = require('fs');
const path = require('path');
const { callGeminiJson } = require('../lib/callGeminiJson');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const REQUIRED_FIELDS = ['caption', 'hashtags', 'caption_notes', 'status'];

function validate(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Output is not a JSON object'];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('caption' in obj && typeof obj.caption === 'string' && !obj.caption.trim()) {
    errors.push('caption must not be empty');
  }

  if ('hashtags' in obj) {
    if (!Array.isArray(obj.hashtags)) {
      errors.push('hashtags must be an array');
    } else {
      if (obj.hashtags.length !== 4) {
        errors.push(`hashtags must have exactly 4 items, got ${obj.hashtags.length}`);
      }
      obj.hashtags.forEach((tag, i) => {
        if (typeof tag !== 'string' || !tag.startsWith('#')) {
          errors.push(`hashtags[${i}] must be a string starting with #`);
        }
      });
    }
  }

  return errors.length > 0 ? errors : null;
}

async function run() {
  const root = path.join(__dirname, '..', '..');
  const promptPath    = path.join(root, 'prompts', 'caption.txt');
  const planPath      = resolvePath(root, 'METAFI_SLIDER_PLAN_INPUT',   'test-outputs/sliderPlan.json');
  const hookPath      = resolvePath(root, 'METAFI_HOOK_INPUT',          'test-outputs/hookOutput.json');
  const bodyPath      = resolvePath(root, 'METAFI_BODY_INPUT',          'test-outputs/bodyOutput.json');
  const finalPath     = resolvePath(root, 'METAFI_FINAL_SLIDE_INPUT',   'test-outputs/finalSlideOutput.json');
  const outputPath    = resolvePath(root, 'METAFI_CAPTION_OUTPUT', 'test-outputs/captionOutput.json');

  for (const [label, p] of [
    ['prompts/caption.txt', promptPath],
    ['test-outputs/sliderPlan.json', planPath],
    ['test-outputs/hookOutput.json', hookPath],
    ['test-outputs/bodyOutput.json', bodyPath],
    ['test-outputs/finalSlideOutput.json', finalPath],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`Error: Missing file at ${label}`);
      process.exit(1);
    }
  }

  const prompt     = fs.readFileSync(promptPath, 'utf8');
  const plan       = fs.readFileSync(planPath, 'utf8').trim();
  const hook       = fs.readFileSync(hookPath, 'utf8').trim();
  const body       = fs.readFileSync(bodyPath, 'utf8').trim();
  const finalSlide = fs.readFileSync(finalPath, 'utf8').trim();

  const message = `${prompt}

<slider_plan>
${plan}
</slider_plan>

<hook_output>
${hook}
</hook_output>

<body_output>
${body}
</body_output>

<final_slide_output>
${finalSlide}
</final_slide_output>`;

  console.log('Sending to Gemini...');

  let parsed;
  try {
    parsed = await callGeminiJson({ root, phaseName: 'caption', message, validate, temperature: 0.3, maxAttempts: 3 });
  } catch (err) {
    console.error('caption failed:', err.message);
    if (err.validationErrors) err.validationErrors.forEach(e => console.error(` - ${e}`));
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.writeFileSync(ensureParentDir(outputPath), output, 'utf8');

  console.log('\n--- captionOutput ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/captionOutput.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
