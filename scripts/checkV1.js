'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

const checks = [
  { label: 'check:post-metadata',       cmd: 'npm', args: ['run', 'check:post-metadata'] },
  { label: 'check:job-isolation',        cmd: 'npm', args: ['run', 'check:job-isolation'] },
  { label: 'node --check server.js',     cmd: 'node', args: ['--check', 'src/ui/server.js'] },
  { label: 'node --check runPipeline',   cmd: 'node', args: ['--check', 'src/pipeline/runPipeline.js'] },
  { label: 'node --check supabasePostStore', cmd: 'node', args: ['--check', 'src/lib/supabasePostStore.js'] },
  { label: 'node --check callGeminiJson',    cmd: 'node', args: ['--check', 'src/lib/callGeminiJson.js'] },
  { label: 'node --check postMetadata',      cmd: 'node', args: ['--check', 'src/lib/postMetadata.js'] },
];

let failed = false;
for (const { label, cmd, args } of checks) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`  FAILED: ${label}`);
    failed = true;
    break;
  }
}

if (failed) process.exit(1);
console.log('\nV1 QA checks passed');
