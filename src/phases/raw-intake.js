'use strict';

const fs = require('fs');
const path = require('path');
const { callGeminiJson } = require('../lib/callGeminiJson');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const REQUIRED_FIELDS = [
  'source_brief_id',
  'source_type',
  'raw_source_excerpt',
  'cleaned_summary',
  'core_pattern',
  'emotional_signal',
  'useful_phrases',
  'audience_relevance',
  'content_potential',
  'notes',
  'status',
];

const VALID_SOURCE_TYPES = [
  'reddit_post',
  'tiktok_post',
  'tweet',
  'comment_thread',
  'founder_note',
  'competitor_post',
  'other',
];

const VALID_CONTENT_POTENTIALS = [
  'identity_slider',
  'tension_slider',
  'decision_pain_slider',
  'worldview_slider',
  'self_recognition_slider',
];

function validate(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Output is not a JSON object'];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }

  if ('source_type' in obj && !VALID_SOURCE_TYPES.includes(obj.source_type)) {
    errors.push(`Invalid source_type: "${obj.source_type}"`);
  }

  if ('content_potential' in obj && !VALID_CONTENT_POTENTIALS.includes(obj.content_potential)) {
    errors.push(`Invalid content_potential: "${obj.content_potential}"`);
  }

  if ('useful_phrases' in obj && !Array.isArray(obj.useful_phrases)) {
    errors.push('useful_phrases must be an array');
  }

  return errors.length > 0 ? errors : null;
}

async function run() {
  const root = path.join(__dirname, '..', '..');
  const promptPath = path.join(root, 'prompts', 'raw-intake.txt');
  const inputPath = path.join(root, 'test-inputs', 'raw-source.txt');
  const outputPath = resolvePath(root, 'METAFI_CLEANED_SOURCE_OUTPUT', 'test-outputs/cleanedSourceBrief.json');

  if (!fs.existsSync(promptPath)) { console.error(`Error: Missing prompt file at ${promptPath}`); process.exit(1); }
  if (!fs.existsSync(inputPath)) { console.error(`Error: Missing input file at ${inputPath}`); process.exit(1); }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const rawSource = fs.readFileSync(inputPath, 'utf8').trim();
  if (!rawSource) { console.error('Error: test-inputs/raw-source.txt is empty'); process.exit(1); }

  const message = `${prompt}\n\n<raw_source>\n${rawSource}\n</raw_source>`;

  console.log('Sending to Gemini...');

  let parsed;
  try {
    parsed = await callGeminiJson({ root, phaseName: 'raw-intake', message, validate, temperature: 0.2, maxAttempts: 3 });
  } catch (err) {
    console.error('raw-intake failed:', err.message);
    if (err.validationErrors) err.validationErrors.forEach(e => console.error(` - ${e}`));
    process.exit(1);
  }

  const output = JSON.stringify(parsed, null, 2);
  fs.writeFileSync(ensureParentDir(outputPath), output, 'utf8');

  console.log('\n--- cleanedSourceBrief ---\n');
  console.log(output);
  console.log('\nSaved → test-outputs/cleanedSourceBrief.json');
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});