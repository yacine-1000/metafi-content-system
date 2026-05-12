'use strict';
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const REQUIRED_FIELDS = [
  'slider_plan_id',
  'raw_idea',
  'direction_bucket',
  'intended_effect',
  'content_source',
  'exploration_mode',
  'core_tension',
  'audience_frame',
  'content_thesis',
  'slider_objective',
  'slider_progression',
  'reference_input',
  'notes',
  'status',
];

const VALID_SLIDER_PROGRESSIONS = [
  'pain_insight_reframe',
  'observation_tension_realization',
  'problem_breakdown',
  'pov_progression',
  'mistake_correction',
];

const VALID_DIRECTION_BUCKETS = [
  'identity_emotional_resonance',
  'decision_confusion_planning_pain',
  'multi_sport_mixed_demand',
];

const VALID_INTENDED_EFFECTS = [
  'self_recognition',
  'tension',
  'relief',
  'reframe',
];

const VALID_CONTENT_SOURCES = [
  'audience_observation',
  'competitor_reference',
  'product_insight',
  'founder_observation',
];

const VALID_EXPLORATION_MODES = [
  'explore',
  'exploit',
];

function validate(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Output is not a JSON object'];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('slider_progression' in obj && !VALID_SLIDER_PROGRESSIONS.includes(obj.slider_progression)) {
    errors.push(`Invalid slider_progression: "${obj.slider_progression}"`);
  }

  if ('direction_bucket' in obj && !VALID_DIRECTION_BUCKETS.includes(obj.direction_bucket)) {
    errors.push(`Invalid direction_bucket: "${obj.direction_bucket}"`);
  }

  if ('intended_effect' in obj && !VALID_INTENDED_EFFECTS.includes(obj.intended_effect)) {
    errors.push(`Invalid intended_effect: "${obj.intended_effect}"`);
  }

  if ('content_source' in obj && !VALID_CONTENT_SOURCES.includes(obj.content_source)) {
    errors.push(`Invalid content_source: "${obj.content_source}"`);
  }

  if ('exploration_mode' in obj && !VALID_EXPLORATION_MODES.includes(obj.exploration_mode)) {
    errors.push(`Invalid exploration_mode: "${obj.exploration_mode}"`);
  }

  if ('reference_input' in obj && !Array.isArray(obj.reference_input)) {
    errors.push('reference_input must be an array');
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
  const promptPath = path.join(root, 'prompts', 'planning.txt');
  const inputPath = path.join(root, 'test-outputs', 'cleanedSourceBrief.json');
  const outputPath = path.join(root, 'test-outputs', 'sliderPlan.json');

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

  const brief = JSON.parse(briefRaw);

  // Pre-populate locked fields. Model only generates: core_tension, content_thesis, slider_objective, slider_progression.
  const planInput = {
    slider_plan_id: '',
    raw_idea: brief.core_pattern,
    direction_bucket: 'identity_emotional_resonance',
    intended_effect: 'self_recognition',
    content_source: 'audience_observation',
    exploration_mode: 'explore',
    core_tension: '',
    audience_frame: brief.audience_relevance,
    content_thesis: '',
    slider_objective: '',
    slider_progression: '',
    reference_input: brief.useful_phrases,
    notes: brief.notes || '',
    status: 'drafted',
  };

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  const message = `${prompt}

<planning_input>
${JSON.stringify(planInput, null, 2)}
</planning_input>

<generation_rules>
Complete only the empty fields: core_tension, content_thesis, slider_objective, slider_progression.
Preserve all other fields exactly as given.

Style rules for generated fields:
- Write like an internal operator, not a content strategist.
- Keep all wording short and plain.
- Do not reframe the source into a positive lesson or a journey metaphor.
- Do not write motivational language.
- Stay close to what actually happened: the person panicked, felt like all progress was erased, overreacted to a temporary drop.
- core_tension: one short direct sentence about the real clash in the source.
- content_thesis: one plain statement of what the content is saying. Not a lesson. Not a reframe.
- slider_objective: one short functional sentence. What this post does in the feed.
- slider_progression: choose one value from the allowed list only.
</generation_rules>`;

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

  console.log('\n--- sliderPlan ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/sliderPlan.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
