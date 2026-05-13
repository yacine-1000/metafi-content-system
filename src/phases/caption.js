'use strict';
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

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

  return errors;
}

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  const root = path.join(__dirname, '..', '..');
  const promptPath    = path.join(root, 'prompts', 'caption.txt');
  const planPath      = path.join(root, 'test-outputs', 'sliderPlan.json');
  const hookPath      = path.join(root, 'test-outputs', 'hookOutput.json');
  const bodyPath      = path.join(root, 'test-outputs', 'bodyOutput.json');
  const finalPath     = path.join(root, 'test-outputs', 'finalSlideOutput.json');
  const outputPath    = path.join(root, 'test-outputs', 'captionOutput.json');

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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
    },
  });

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

  const result = await model.generateContent(message);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('Model returned invalid JSON:\n');
    console.error(text);
    process.exit(1);
  }

  const errors = validate(parsed);
  if (errors.length > 0) {
    console.error('Output failed validation:');
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');

  console.log('\n--- captionOutput ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/captionOutput.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
