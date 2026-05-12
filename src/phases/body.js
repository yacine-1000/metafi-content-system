'use strict';
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const REQUIRED_FIELDS = [
  'slider_plan_id',
  'selected_hook',
  'body_slide_count',
  'body_slides',
  'body_notes',
  'status',
];

const VALID_SLIDE_ROLES = ['build', 'tension', 'realization'];

function validate(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Output is not a JSON object'];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('body_slides' in obj) {
    if (!Array.isArray(obj.body_slides)) {
      errors.push('body_slides must be an array');
    } else {
      if (obj.body_slides.length !== 3) {
        errors.push(`body_slides must have exactly 3 items, got ${obj.body_slides.length}`);
      }
      const EXPECTED_SLIDE_NUMBERS = [2, 3, 4];
      obj.body_slides.forEach((slide, i) => {
        const prefix = `body_slides[${i}]`;
        for (const f of ['slide_number', 'slide_role', 'slide_text', 'text_intent']) {
          if (!(f in slide)) errors.push(`${prefix} missing field: ${f}`);
        }
        if ('slide_number' in slide && slide.slide_number !== EXPECTED_SLIDE_NUMBERS[i]) {
          errors.push(`${prefix} slide_number must be ${EXPECTED_SLIDE_NUMBERS[i]}, got ${slide.slide_number}`);
        }
        if ('slide_role' in slide && !VALID_SLIDE_ROLES.includes(slide.slide_role)) {
          errors.push(`${prefix} invalid slide_role: "${slide.slide_role}"`);
        }
      });
    }
  }

  if ('body_slide_count' in obj) {
    if (obj.body_slide_count !== 3) {
      errors.push(`body_slide_count must be exactly 3, got ${obj.body_slide_count}`);
    } else if (Array.isArray(obj.body_slides) && obj.body_slide_count !== obj.body_slides.length) {
      errors.push(`body_slide_count (${obj.body_slide_count}) does not match body_slides length (${obj.body_slides.length})`);
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
  const promptPath = path.join(root, 'prompts', 'body.txt');
  const briefPath = path.join(root, 'test-outputs', 'cleanedSourceBrief.json');
  const planPath = path.join(root, 'test-outputs', 'sliderPlan.json');
  const hookPath = path.join(root, 'test-outputs', 'hookOutput.json');
  const outputPath = path.join(root, 'test-outputs', 'bodyOutput.json');

  for (const [label, p] of [
    ['prompts/body.txt', promptPath],
    ['test-outputs/cleanedSourceBrief.json', briefPath],
    ['test-outputs/sliderPlan.json', planPath],
    ['test-outputs/hookOutput.json', hookPath],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`Error: Missing file at ${label}`);
      process.exit(1);
    }
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const brief = fs.readFileSync(briefPath, 'utf8').trim();
  const plan = fs.readFileSync(planPath, 'utf8').trim();
  const hook = fs.readFileSync(hookPath, 'utf8').trim();

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  const message = `${prompt}

<cleaned_source_brief>
${brief}
</cleaned_source_brief>

<slider_plan>
${plan}
</slider_plan>

<hook_output>
${hook}
</hook_output>`;

  console.log('Sending to Gemini...');

  const result = await model.generateContent(message);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('Model returned invalid JSON:\n');
    console.error(text);
    process.exit(1);
  }

  const errors = validate(parsed);
  if (errors.length > 0) {
    console.error('Output failed validation:');
    for (const error of errors) {
      console.error(` - ${error}`);
    }
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');

  console.log('\n--- bodyOutput ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/bodyOutput.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
