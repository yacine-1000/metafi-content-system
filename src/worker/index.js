'use strict';

require('dotenv').config();
const { createRenderingWorker, validateWorkerEnvironment } = require('./renderingWorker');

async function main() {
  const worker = createRenderingWorker({ config: validateWorkerEnvironment(process.env) });
  let stopping = false;
  const shutdown = async (signal) => { if (stopping) return; stopping = true; await worker.stop(signal); process.exitCode = 0; };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => { console.error(error.message); process.exitCode = 1; }));
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => { console.error(error.message); process.exitCode = 1; }));
  await worker.start();
}

if (require.main === module) main().catch((error) => { console.error(`[rendering-worker] startup failed: ${error.message}`); process.exitCode = 1; });

module.exports = { main };
