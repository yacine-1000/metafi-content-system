'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function readFile(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

function assertContains(rel, tokens) {
  const content = readFile(rel);
  const missing = tokens.filter(t => !content.includes(t));
  if (missing.length) throw new Error(`${rel} missing tokens:\n${missing.map(t => `  - ${t}`).join('\n')}`);
}

// File existence checks
const REQUIRED_FILES = [
  'knowledge/metafi-content-doctrine.md',
  'prompts/strategy-check.txt',
  'schemas/strategy-check.schema.json',
  'src/phases/strategy-check.js',
  'prompts/raw-intake.txt',
  'prompts/planning.txt',
];
const missingFiles = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(root, f)));
if (missingFiles.length) throw new Error(`Missing files:\n${missingFiles.map(f => `  - ${f}`).join('\n')}`);

// Syntax checks
const SYNTAX_CHECKS = [
  'src/phases/strategy-check.js',
  'src/pipeline/runPipeline.js',
  'src/ui/server.js',
  'src/lib/postMetadata.js',
];
for (const file of SYNTAX_CHECKS) {
  console.log(`▶ node --check ${file}`);
  const r = spawnSync('node', ['--check', file], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Syntax check failed: ${file}`);
}

// package.json script assertion
const pkg = JSON.parse(readFile('package.json'));
if (!pkg.scripts || !pkg.scripts['strategy-check']) throw new Error('package.json missing script: strategy-check');

// pipeline wiring assertions
assertContains('src/pipeline/runPipeline.js', ['strategy-check', 'METAFI_STRATEGY_CHECK_OUTPUT']);

// strategy-check soft guardrail fields
const STRATEGY_FIELDS = ['allowed', 'content_type', 'content_relationship', 'advisory_notes'];
assertContains('prompts/strategy-check.txt',        STRATEGY_FIELDS);
assertContains('schemas/strategy-check.schema.json', STRATEGY_FIELDS);
assertContains('src/phases/strategy-check.js',       STRATEGY_FIELDS);

// redesigned raw-intake fields
assertContains('prompts/raw-intake.txt', [
  'source_summary', 'human_tension', 'concrete_details', 'possible_meanings', 'do_not_force',
]);

// redesigned planning fields
assertContains('prompts/planning.txt', [
  'chosen_angle', 'human_truth', 'texture_to_preserve', 'what_not_to_force', 'content_relationship',
]);

console.log('\nV2 QA checks passed');
