'use strict';

const path = require('path');
const fs   = require('fs');

function resolvePath(root, envName, fallbackRelativePath) {
  const override = process.env[envName];
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(root, override);
  }
  return path.join(root, fallbackRelativePath);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

module.exports = { resolvePath, ensureParentDir };
