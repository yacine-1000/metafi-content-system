'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../../');
const RENDERS_DIR = path.join(ROOT, 'renders');
const RAW_SOURCE_PATH = path.join(ROOT, 'test-inputs', 'raw-source.txt');
const MANUAL_INPUT_PATH = path.join(ROOT, 'test-inputs', 'manual-input.json');

const PIPELINE = ['intake', 'planning', 'hook', 'body', 'final-slide', 'assembly:build', 'assemble:test'];

const app = express();
app.use(express.json());
app.use('/renders', express.static(RENDERS_DIR));
app.use(express.static(path.join(__dirname)));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function runStep(step, log) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', step], { cwd: ROOT, shell: true });
    proc.stdout.on('data', (d) => log(d.toString()));
    proc.stderr.on('data', (d) => log(d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`[${step}] exited with code ${code}`));
    });
  });
}

app.post('/generate', async (req, res) => {
  const { source_type = 'other', raw_input = '' } = req.body;

  if (!raw_input.trim()) {
    return res.status(400).json({ error: 'raw_input is required' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const log = (line) => {
    res.write(line);
  };

  try {
    fs.writeFileSync(RAW_SOURCE_PATH, `[source_type: ${source_type}]\n\n${raw_input.trim()}`, 'utf8');
    fs.writeFileSync(MANUAL_INPUT_PATH, JSON.stringify({ source_type, raw_input }, null, 2), 'utf8');
    log(`inputs written\n`);
  } catch (err) {
    log(`ERROR writing inputs: ${err.message}\n`);
    res.end();
    return;
  }

  for (const step of PIPELINE) {
    log(`\n--- ${step} ---\n`);
    try {
      await runStep(step, log);
      log(`--- ${step} done ---\n`);
    } catch (err) {
      log(`\nERROR: ${err.message}\n`);
      res.end();
      return;
    }
  }

  log('\nDONE\n');
  res.end();
});

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`Creator UI running at http://localhost:${PORT}`);
});
