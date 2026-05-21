'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { createJob, updateJobStep, updateJobStatus, copyFileToJob } = require('../lib/jobManager');

const root  = path.resolve(__dirname, '..', '..');
const jobId = createJob(root);
console.log(`jobId: ${jobId}`);

const phaseOutputsDir = path.join(root, 'outputs', 'jobs', jobId, 'phase-outputs');
const p = (name) => path.join(phaseOutputsDir, name);

const PHASE_ENV = {
  'intake':      { METAFI_CLEANED_SOURCE_OUTPUT: p('cleanedSourceBrief.json') },
  'planning':    { METAFI_CLEANED_SOURCE_INPUT:  p('cleanedSourceBrief.json'), METAFI_SLIDER_PLAN_OUTPUT:  p('sliderPlan.json') },
  'hook':        { METAFI_SLIDER_PLAN_INPUT:     p('sliderPlan.json'),         METAFI_HOOK_OUTPUT:         p('hookOutput.json') },
  'body':        { METAFI_CLEANED_SOURCE_INPUT:  p('cleanedSourceBrief.json'), METAFI_SLIDER_PLAN_INPUT:   p('sliderPlan.json'), METAFI_HOOK_INPUT:  p('hookOutput.json'), METAFI_BODY_OUTPUT:        p('bodyOutput.json') },
  'final-slide': { METAFI_SLIDER_PLAN_INPUT:     p('sliderPlan.json'),         METAFI_HOOK_INPUT:          p('hookOutput.json'), METAFI_BODY_INPUT:  p('bodyOutput.json'), METAFI_FINAL_SLIDE_OUTPUT: p('finalSlideOutput.json') },
  'caption':        { METAFI_SLIDER_PLAN_INPUT: p('sliderPlan.json'), METAFI_HOOK_INPUT: p('hookOutput.json'), METAFI_BODY_INPUT: p('bodyOutput.json'), METAFI_FINAL_SLIDE_INPUT: p('finalSlideOutput.json'), METAFI_CAPTION_OUTPUT: p('captionOutput.json') },
  'strategy-check': { METAFI_CLEANED_SOURCE_INPUT: p('cleanedSourceBrief.json'), METAFI_SLIDER_PLAN_INPUT: p('sliderPlan.json'), METAFI_HOOK_INPUT: p('hookOutput.json'), METAFI_BODY_INPUT: p('bodyOutput.json'), METAFI_FINAL_SLIDE_INPUT: p('finalSlideOutput.json'), METAFI_CAPTION_INPUT: p('captionOutput.json'), METAFI_STRATEGY_CHECK_OUTPUT: p('strategyCheck.json') },
  'assembly-build': { METAFI_SLIDER_PLAN_INPUT: p('sliderPlan.json'), METAFI_HOOK_INPUT: p('hookOutput.json'), METAFI_BODY_INPUT: p('bodyOutput.json'), METAFI_FINAL_SLIDE_INPUT: p('finalSlideOutput.json'), METAFI_CAPTION_INPUT: p('captionOutput.json'), METAFI_ASSEMBLY_CONFIG_OUTPUT: p('assembly-config.json') },
  'assemble-test':  { METAFI_ASSEMBLY_CONFIG_INPUT: p('assembly-config.json'), METAFI_RENDERS_DIR: path.join(root, 'outputs', 'jobs', jobId, 'renders') },
};

const steps = [
  { name: 'intake',         cmd: 'npm', args: ['run', 'intake'] },
  { name: 'planning',       cmd: 'npm', args: ['run', 'planning'] },
  { name: 'hook',           cmd: 'npm', args: ['run', 'hook'] },
  { name: 'body',           cmd: 'npm', args: ['run', 'body'] },
  { name: 'final-slide',    cmd: 'npm', args: ['run', 'final-slide'] },
  { name: 'assembly-build', cmd: 'npm', args: ['run', 'assembly:build'] },
  { name: 'assemble-test',  cmd: 'npm', args: ['run', 'assemble:test'] },
  { name: 'caption',         cmd: 'npm', args: ['run', 'caption'] },
  { name: 'strategy-check', cmd: 'npm', args: ['run', 'strategy-check'] },
];

for (const step of steps) {
  updateJobStep(root, jobId, { name: step.name, status: 'running', startedAt: new Date().toISOString() });
  const env = { ...process.env, ...(PHASE_ENV[step.name] || {}) };
  const result = spawnSync(step.cmd, step.args, { cwd: root, stdio: 'inherit', shell: true, env });
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
