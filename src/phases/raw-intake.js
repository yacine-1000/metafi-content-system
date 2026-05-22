'use strict';

const fs = require('fs');
const path = require('path');
const { callGeminiJson } = require('../lib/callGeminiJson');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const REQUIRED_FIELDS = [
  'source_summary',
  'situation',
  'human_tension',
  'concrete_details',
  'source_phrases',
  'emotional_signals',
  'training_context',
  'possible_meanings',
  'do_not_force',
  'status',
];

const ARRAY_FIELDS = ['concrete_details', 'source_phrases', 'emotional_signals', 'training_context', 'possible_meanings', 'do_not_force'];

function validate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Output is not a JSON object'];
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) errors.push(`Missing field: ${field}`);
  }
  for (const field of ARRAY_FIELDS) {
    if (field in obj && !Array.isArray(obj[field])) errors.push(`${field} must be an array`);
  }
  if ('status' in obj && obj.status !== 'extracted') errors.push(`status must be "extracted"`);
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

  const message = prompt.replace('{{RAW_SOURCE}}', rawSource);

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