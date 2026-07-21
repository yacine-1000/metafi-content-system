'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectMasterScriptPost } = require('./selectMasterScript');

const ROOT = path.resolve(__dirname, '../..');
const LANGUAGE_ORDER = ['ar', 'en', 'es', 'fr'];
const PROCESS_TIMEOUTS_MS = Object.freeze({ script_selection: 120000, asset_resolution: 120000, renderer: 180000 });

function diagnostic(stage, event, startedAt, details = '') {
  console.error(`[campaign-generation] ${new Date().toISOString()} stage=${stage} event=${event} elapsed_ms=${Date.now() - startedAt}${details ? ` ${details}` : ''}`);
}

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

function runNode(script, args, stage, timeoutMs) {
  const startedAt = Date.now();
  diagnostic(stage, 'start', startedAt, `script=${script} timeout_ms=${timeoutMs}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 20 * 1024 * 1024,
    // Playwright's pw:channel trace can exceed maxBuffer in seconds. It is a
    // developer diagnostic and must never be inherited by campaign workers.
    env: { ...process.env, DEBUG: '' },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    diagnostic(stage, 'timeout', startedAt, `script=${script}`);
    throw new Error(`${stage} timed out after ${timeoutMs}ms (${script})`);
  }
  if (result.error) {
    throw new Error(`${stage} process failed (${result.error.code || 'PROCESS_ERROR'}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${script} failed with exit code ${result.status}\n${details}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  diagnostic(stage, 'complete', startedAt, `script=${script}`);
  return result.stdout.trim();
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
  requiredSourceSetId = null,
  avoidedSourceSetIds = [],
  accountId = null,
  coolingScriptIds = null,
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
  const pendingRenders = [];

  for (const language of languages) {
    const postStartedAt = Date.now();
    const selectionArgs = {
      pillar, hook, language,
      usedScriptIds: language === 'ar' ? usedScriptIds : [],
      excludedScriptIds: language === 'ar' ? excludedScriptIds : [],
      requiredSourceSetId: language === 'ar' ? requiredSourceSetId : null,
      avoidedSourceSetIds: language === 'ar' ? avoidedSourceSetIds : [],
      accountId: language === 'ar' ? accountId : null,
    };
    const selectionTimings = {};
    const selectionStartedAt = Date.now();
    diagnostic('script_selection', 'start', selectionStartedAt, 'mode=in_process');
    const selection = selectMasterScriptPost(selectionArgs, { timings: selectionTimings, coolingScriptIds });
    diagnostic('script_selection', 'complete', selectionStartedAt, `profile=${JSON.stringify(selectionTimings)}`);

    const resolverArgs = [
      '--post', selection.output_path,
      '--language-lane', language,
    ];
    if (accountId) resolverArgs.push('--account-id', accountId);
    runNode('src/generation/resolvePostAssets.js', resolverArgs, 'asset_resolution', PROCESS_TIMEOUTS_MS.asset_resolution);

    pendingRenders.push({ language, selection, postStartedAt });
  }

  if (pendingRenders.length) {
    fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(ROOT, 'tmp', 'renderer-'));
    const inputPath = path.join(scratchDir, 'input.json'); const resultPath = path.join(scratchDir, 'result.json');
    let rendered;
    try {
      fs.writeFileSync(inputPath, JSON.stringify({ persistence_mode: process.env.METAFI_PERSISTENCE_MODE || 'local', result_path: resultPath,
        posts: pendingRenders.map(({ selection }) => ({ post_folder: selection.output_path, metadata: selection.metadata, publish_package: selection.publish_package,
          post_id: selection.post_id, campaign_id: selection.metadata?.campaign_id || null, slot_id: selection.metadata?.slot_id || null, account_id: selection.metadata?.account_id || null })) }, null, 2));
      runNode('src/generation/renderResolvedPost.js', ['--scratch-input', inputPath], 'renderer', PROCESS_TIMEOUTS_MS.renderer);
      rendered = JSON.parse(fs.readFileSync(resultPath, 'utf8')); rendered = rendered.posts || [rendered];
    } finally { fs.rmSync(scratchDir, { recursive: true, force: true }); }
    pendingRenders.forEach((entry, index) => { entry.rendered = rendered[index]; });
  }

  for (const { language, selection, postStartedAt, rendered } of pendingRenders) {
    const renderedDir = path.join(ROOT, selection.output_path, 'rendered');
    summary.posts.push({
      language,
      post_id: selection.post_id,
      post_folder: selection.output_path,
      slide_count: selection.slide_count,
      rendered_files: pngFiles(renderedDir),
      render_result: rendered,
    });
    diagnostic('post', 'complete', postStartedAt, `language=${language} post_id=${selection.post_id}`);
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
