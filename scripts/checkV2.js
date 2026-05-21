'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

// File existence checks
const REQUIRED_FILES = [
  'knowledge/metafi-content-doctrine.md',
  'prompts/strategy-check.txt',
  'schemas/strategy-check.schema.json',
  'src/phases/strategy-check.js',
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
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!pkg.scripts || !pkg.scripts['strategy-check']) throw new Error('package.json missing script: strategy-check');

// pipeline wiring assertions
const pipeline = fs.readFileSync(path.join(root, 'src/pipeline/runPipeline.js'), 'utf8');
const PIPELINE_TOKENS = ['strategy-check', 'METAFI_STRATEGY_CHECK_OUTPUT'];
const missingTokens = PIPELINE_TOKENS.filter(t => !pipeline.includes(t));
if (missingTokens.length) throw new Error(`runPipeline.js missing tokens:\n${missingTokens.map(t => `  - ${t}`).join('\n')}`);

console.log('\nV2 QA checks passed');
