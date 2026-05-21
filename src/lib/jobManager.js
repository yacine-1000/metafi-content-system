'use strict';

const fs = require('fs');
const path = require('path');

function manifestPath(root, jobId) {
  return path.join(root, 'outputs', 'jobs', jobId, 'manifest.json');
}

function readManifest(root, jobId) {
  return JSON.parse(fs.readFileSync(manifestPath(root, jobId), 'utf8'));
}

function writeManifest(root, jobId, manifest) {
  fs.writeFileSync(manifestPath(root, jobId), JSON.stringify(manifest, null, 2), 'utf8');
}

function createJob(root) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const jobId = `job-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const jobDir = path.join(root, 'outputs', 'jobs', jobId);
  for (const sub of ['logs', 'phase-outputs', 'renders']) {
    fs.mkdirSync(path.join(jobDir, sub), { recursive: true });
  }
  const manifest = { jobId, status: 'created', createdAt: now.toISOString(), updatedAt: now.toISOString(), steps: [] };
  writeManifest(root, jobId, manifest);
  return jobId;
}

function updateJobStep(root, jobId, step) {
  const manifest = readManifest(root, jobId);
  const idx = manifest.steps.findIndex(s => s.name === step.name);
  if (idx >= 0) manifest.steps[idx] = { ...manifest.steps[idx], ...step };
  else manifest.steps.push(step);
  if (step.status === 'failed') manifest.status = 'failed';
  manifest.updatedAt = new Date().toISOString();
  writeManifest(root, jobId, manifest);
}

function updateJobStatus(root, jobId, status) {
  const manifest = readManifest(root, jobId);
  manifest.status = status;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(root, jobId, manifest);
}

function copyFileToJob(root, jobId, sourcePath, targetName) {
  if (!fs.existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);
  const dest = path.join(root, 'outputs', 'jobs', jobId, 'phase-outputs', targetName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(sourcePath, dest);
}

module.exports = { createJob, updateJobStep, updateJobStatus, copyFileToJob };
