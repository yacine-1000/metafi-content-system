'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { createJob, updateJobStep, updateJobStatus, copyFileToJob } = require('../lib/jobManager');

const root = path.resolve(__dirname, '..', '..');
const jobId = createJob(root);
console.log(`jobId: ${jobId}`);

const steps = [
  { name: 'intake',         cmd: 'npm', args: ['run', 'intake'],         copy: { src: 'test-outputs/cleanedSourceBrief.json', dest: 'cleanedSourceBrief.json' } },
  { name: 'planning',       cmd: 'npm', args: ['run', 'planning'],       copy: { src: 'test-outputs/sliderPlan.json',          dest: 'sliderPlan.json' } },
  { name: 'hook',           cmd: 'npm', args: ['run', 'hook'],           copy: { src: 'test-outputs/hookOutput.json',          dest: 'hookOutput.json' } },
  { name: 'body',           cmd: 'npm', args: ['run', 'body'],           copy: { src: 'test-outputs/bodyOutput.json',          dest: 'bodyOutput.json' } },
  { name: 'final-slide',    cmd: 'npm', args: ['run', 'final-slide'],    copy: { src: 'test-outputs/finalSlideOutput.json',    dest: 'finalSlideOutput.json' } },
  { name: 'assembly-build', cmd: 'npm', args: ['run', 'assembly:build'], copy: { src: 'test-inputs/assembly-config.json',      dest: 'assembly-config.json' } },
  { name: 'assemble-test',  cmd: 'npm', args: ['run', 'assemble:test'] },
  { name: 'caption',        cmd: 'npm', args: ['run', 'caption'],        copy: { src: 'test-outputs/captionOutput.json',       dest: 'captionOutput.json' } },
];

for (const step of steps) {
  updateJobStep(root, jobId, { name: step.name, status: 'running', startedAt: new Date().toISOString() });
  const result = spawnSync(step.cmd, step.args, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    const error = result.error ? result.error.message : `exit code ${result.status}`;
    updateJobStep(root, jobId, { name: step.name, status: 'failed', completedAt: new Date().toISOString(), error });
    updateJobStatus(root, jobId, 'failed');
    console.error(`FAILED step: ${step.name}`);
    process.exit(1);
  }
  if (step.copy) {
    try {
      copyFileToJob(root, jobId, path.join(root, step.copy.src), step.copy.dest);
    } catch (err) {
      updateJobStep(root, jobId, { name: step.name, status: 'failed', completedAt: new Date().toISOString(), error: err.message });
      updateJobStatus(root, jobId, 'failed');
      console.error(`FAILED copy after step: ${step.name} — ${err.message}`);
      process.exit(1);
    }
  }
  updateJobStep(root, jobId, { name: step.name, status: 'completed', completedAt: new Date().toISOString() });
}

updateJobStatus(root, jobId, 'completed');
console.log(`completed jobId: ${jobId}`);
process.exit(0);
