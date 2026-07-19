'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const LANGUAGE_ORDER = ['ar', 'en', 'es', 'fr'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pillar') {
      args.pillar = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--hook') {
      args.hook = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--languages') {
      args.languages = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function repoRelative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseLanguages(raw) {
  if (!raw) throw new Error('Missing required argument: --languages ar,en,es,fr');
  const requested = new Set(raw.split(',').map((item) => item.trim()).filter(Boolean));
  for (const language of requested) {
    if (!LANGUAGE_ORDER.includes(language)) throw new Error(`Unsupported language: ${language}`);
  }
  return LANGUAGE_ORDER.filter((language) => requested.has(language));
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${script} failed with exit code ${result.status}\n${details}`);
  }
  return result.stdout.trim();
}

function parseJsonFromOutput(output) {
  const start = output.lastIndexOf('\n{');
  const jsonText = start >= 0 ? output.slice(start + 1) : output;
  return JSON.parse(jsonText);
}

function pngFiles(renderedDir) {
  return fs.readdirSync(renderedDir)
    .filter((name) => /^slide-\d+\.png$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => repoRelative(path.join(renderedDir, name)));
}

function generateSlideshows({
  pillar,
  hook,
  languages: rawLanguages,
  usedScriptIds = [],
  excludedScriptIds = [],
  avoidedSourceSetIds = [],
  accountId = null,
}) {
  if (!pillar) throw new Error('Missing required argument: --pillar p1|p2|p3|p4');
  if (!hook) throw new Error('Missing required argument: --hook listicle');
  const languages = Array.isArray(rawLanguages)
    ? LANGUAGE_ORDER.filter((language) => new Set(rawLanguages).has(language))
    : parseLanguages(rawLanguages);

  const summary = {
    pillar_id: pillar,
    hook_type: hook,
    languages,
    posts: [],
  };

  for (const language of languages) {
    const selectorArgs = [
      '--pillar', pillar,
      '--hook', hook,
      '--language', language,
    ];
    if (language === 'ar' && usedScriptIds.length) selectorArgs.push('--used-script-ids', usedScriptIds.join(','));
    if (language === 'ar' && excludedScriptIds.length) selectorArgs.push('--exclude-script-ids', excludedScriptIds.join(','));
    if (language === 'ar' && avoidedSourceSetIds.length) selectorArgs.push('--avoid-source-set-ids', avoidedSourceSetIds.join(','));
    if (language === 'ar' && accountId) selectorArgs.push('--account-id', accountId);
    const selection = parseJsonFromOutput(runNode('src/generation/selectMasterScript.js', selectorArgs));

    const resolverArgs = [
      '--post', selection.output_path,
      '--language-lane', language,
    ];
    if (accountId) resolverArgs.push('--account-id', accountId);
    runNode('src/generation/resolvePostAssets.js', resolverArgs);

    runNode('src/generation/renderResolvedPost.js', [
      '--post', selection.output_path,
    ]);

    const renderedDir = path.join(ROOT, selection.output_path, 'rendered');
    summary.posts.push({
      language,
      post_id: selection.post_id,
      post_folder: selection.output_path,
      slide_count: selection.slide_count,
      rendered_files: pngFiles(renderedDir),
    });
  }

  return summary;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(generateSlideshows({
    pillar: args.pillar,
    hook: args.hook,
    languages: args.languages,
  }), null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { generateSlideshows };
