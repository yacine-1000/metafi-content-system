'use strict';

const fs   = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '../src/pipeline/runPipeline.js'), 'utf8');

const REQUIRED = [
  'METAFI_CLEANED_SOURCE_OUTPUT',
  'METAFI_CLEANED_SOURCE_INPUT',
  'METAFI_SLIDER_PLAN_OUTPUT',
  'METAFI_SLIDER_PLAN_INPUT',
  'METAFI_HOOK_OUTPUT',
  'METAFI_HOOK_INPUT',
  'METAFI_BODY_OUTPUT',
  'METAFI_BODY_INPUT',
  'METAFI_FINAL_SLIDE_OUTPUT',
  'METAFI_FINAL_SLIDE_INPUT',
  'METAFI_CAPTION_OUTPUT',
  'METAFI_CAPTION_INPUT',
  'METAFI_ASSEMBLY_CONFIG_OUTPUT',
  'METAFI_ASSEMBLY_CONFIG_INPUT',
  'METAFI_RENDERS_DIR',
  'phase-outputs',
  'renders',
];

const missing = REQUIRED.filter(token => !src.includes(token));
if (missing.length > 0) {
  throw new Error(`Job isolation check FAILED — missing in runPipeline.js:\n${missing.map(m => `  - ${m}`).join('\n')}`);
}

console.log('Job isolation check passed');
