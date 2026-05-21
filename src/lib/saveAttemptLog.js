const fs = require('fs');
const path = require('path');

function saveAttemptLog({ root, phaseName, attemptNumber, responseText, error, parsed }) {
  try {
    const dir = path.join(root, 'outputs', 'debug', 'latest', phaseName);
    fs.mkdirSync(dir, { recursive: true });
    if (responseText !== undefined) fs.writeFileSync(path.join(dir, `attempt-${attemptNumber}-response.txt`), responseText, 'utf8');
    if (parsed !== undefined) fs.writeFileSync(path.join(dir, `attempt-${attemptNumber}-parsed.json`), JSON.stringify(parsed, null, 2), 'utf8');
    if (error !== undefined) fs.writeFileSync(path.join(dir, `attempt-${attemptNumber}-error.json`), JSON.stringify({ message: error.message, stack: error.stack, timestamp: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[saveAttemptLog] Failed to write log for ${phaseName} attempt ${attemptNumber}:`, e.message);
  }
}

module.exports = { saveAttemptLog };
