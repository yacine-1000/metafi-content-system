'use strict';
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

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

  return errors;
}

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  const root = path.join(__dirname, '..', '..');
  const promptPath = path.join(root, 'prompts', 'final-slide.txt');
  const planPath = path.join(root, 'test-outputs', 'sliderPlan.json');
  const hookPath = path.join(root, 'test-outputs', 'hookOutput.json');
  const bodyPath = path.join(root, 'test-outputs', 'bodyOutput.json');
  const outputPath = path.join(root, 'test-outputs', 'finalSlideOutput.json');

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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
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
</body_output>`;

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
  fs.writeFileSync(outputPath, output, 'utf8');

  console.log('\n--- finalSlideOutput ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/finalSlideOutput.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
