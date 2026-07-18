'use strict';

const fs = require('fs');
const path = require('path');
const { selectArabicRuntimeScript } = require('../scripts/scriptLibrary');

const ROOT = path.resolve(__dirname, '../..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function parseArgs(argv) {
  const args = { language: 'ar', usedScriptIds: [], avoidedSourceSetIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pillar') {
      args.pillar = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--hook') {
      args.hook = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--language') {
      args.language = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--used-script-ids') {
      args.usedScriptIds = argv[i + 1].split(',').filter(Boolean);
      i += 1;
    } else if (argv[i] === '--avoid-source-set-ids') {
      args.avoidedSourceSetIds = argv[i + 1].split(',').filter(Boolean);
      i += 1;
    }
  }
  return args;
}

function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function safeIdSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getActivePillarIds(pillars) {
  const activeIds = new Set(pillars.active_pillars.filter((pillar) => pillar.active).map((pillar) => pillar.id));
  return pillars.default_order.filter((pillarId) => activeIds.has(pillarId));
}

function selectPillarId(pillars, requestedPillarId) {
  const activeIds = getActivePillarIds(pillars);
  const configuredIds = pillars.active_pillars.map((pillar) => pillar.id);
  if (requestedPillarId) {
    if (!configuredIds.includes(requestedPillarId)) {
      throw new Error(`Unknown pillar: ${requestedPillarId}`);
    }
    return requestedPillarId;
  }
  if (!activeIds.length) throw new Error('No active pillars found');
  return activeIds[0];
}

function selectMasterScript(topicBank, pillarId, hookType) {
  const topics = topicBank.topics_by_pillar[pillarId] || [];
  for (const topic of topics) {
    if (topic.active === false) continue;
    const scripts = Array.isArray(topic.master_scripts) ? topic.master_scripts : [];
    const script = scripts.find((item) =>
      item.active !== false &&
      (!hookType || item.hook_type === hookType)
    );
    if (script) return { topic, script };
  }
  throw new Error(`No active approved master script found for pillar "${pillarId}" and hook "${hookType || 'any'}"`);
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateVersion(script, language) {
  const version = script.versions && script.versions[language];
  if (!version) throw new Error(`No approved "${language}" version found for master script: ${script.master_script_id || script.id}`);
  if (typeof version.hook_text !== 'string') throw new Error(`Version "${language}" is missing hook_text`);
  if (!Array.isArray(version.slides)) throw new Error(`Version "${language}" is missing slides`);
  if (version.slides.length !== script.slide_count) {
    throw new Error(`Version "${language}" slide count does not match script slide_count`);
  }
  for (const slide of version.slides) {
    if (typeof slide.slide_number !== 'number') throw new Error(`Version "${language}" has a slide without slide_number`);
    if (typeof slide.role !== 'string') throw new Error(`Version "${language}" slide ${slide.slide_number} missing role`);
    if (typeof slide.asset_bank !== 'string') throw new Error(`Version "${language}" slide ${slide.slide_number} missing asset_bank`);
    if (typeof slide.text !== 'string') throw new Error(`Version "${language}" slide ${slide.slide_number} missing text`);
  }
  const ctaSlide = version.slides.find((slide) => slide.slide_number === script.cta_slide);
  if (!ctaSlide || !['cta', 'app'].includes(ctaSlide.role) || ctaSlide.asset_bank !== 'app_icon_home_screen') {
    throw new Error(`Version "${language}" must keep CTA on slide ${script.cta_slide}`);
  }
  return version;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pillars = readJson('content/banks/pillars.json');
  const topicBank = readJson('content/banks/topic-bank.json');
  const ctaRules = readJson('content/banks/cta-rules.json');
  const postingRules = readJson('content/banks/posting-rules.json');

  const pillarId = selectPillarId(pillars, args.pillar);
  const language = args.language;
  if (!['ar', 'en', 'es', 'fr'].includes(language)) {
    throw new Error(`Unsupported language: ${language}`);
  }
  const legacyVisualSelection = language === 'ar'
    ? (() => {
      try { return selectMasterScript(topicBank, pillarId); }
      catch { return selectMasterScript(topicBank, getActivePillarIds(pillars)[0]); }
    })()
    : null;
  const librarySelection = language === 'ar' ? selectArabicRuntimeScript({
    pillarId,
    hookType: args.hook,
    visualHookType: legacyVisualSelection.script.visual_hook_type,
    usedScriptIds: args.usedScriptIds,
    avoidedSourceSetIds: args.avoidedSourceSetIds,
  }) : null;
  const { topic, script } = librarySelection || selectMasterScript(topicBank, pillarId, args.hook);
  const version = validateVersion(script, language);

  const ctaType = ctaRules.default_cta_type;
  if (!ctaRules.allowed_cta_types.includes(ctaType)) {
    throw new Error(`Default CTA type is not allowed: ${ctaType}`);
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const masterScriptId = script.master_script_id || script.id;
  const postId = `post-${timestamp(now)}-${pillarId}-${safeIdSegment(script.hook_type)}-${language}`;

  const publishPackage = {
    post_id: postId,
    account: 'account_1',
    language,
    pillar_id: pillarId,
    topic_id: topic.id,
    master_script_id: masterScriptId,
    hook_type: script.hook_type,
    hook_text: version.hook_text,
    visual_hook_type: script.visual_hook_type,
    slide_count: script.slide_count,
    cta_type: ctaType,
    cta_slide: script.cta_slide,
    slides: copyJson(version.slides).map((slide) => slide.role === 'app' ? { ...slide, role: 'cta' } : slide),
    caption: version.hook_text
  };

  const expectedFields = postingRules.output_package_fields;
  const actualFields = Object.keys(publishPackage);
  const missingFields = expectedFields.filter((field) => !(field in publishPackage));
  if (missingFields.length > 0) {
    throw new Error(`publish-package missing posting-rules fields: ${missingFields.join(', ')}`);
  }
  if (!actualFields.includes('language')) {
    throw new Error('publish-package missing language');
  }

  const metadata = {
    post_id: postId,
    created_at: createdAt,
    updated_at: createdAt,
    status: 'draft',
    review_status: 'pending',
    buffer_status: 'not_sent',
    language,
    pillar_id: pillarId,
    topic_id: topic.id,
    master_script_id: masterScriptId,
    hook_type: script.hook_type,
    statuses: {
      generation: 'completed',
      review: 'pending',
      upload: 'not_started',
      buffer: 'not_started',
      publish: 'not_started',
      strategy: 'not_checked'
    },
    assets: {
      slide_count: script.slide_count,
      slides_path: null,
      rendered_path: null,
      caption_path: 'caption.txt',
      publish_package_path: 'publish-package.json'
    },
    strategy_metadata: {
      pillar_id: pillarId,
      topic_id: topic.id,
      master_script_id: masterScriptId,
      hook_type: script.hook_type,
      language
    },
    errors: []
  };

  const postDir = path.join(ROOT, 'outputs', 'posts', postId);
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, 'publish-package.json'), JSON.stringify(publishPackage, null, 2), 'utf8');
  fs.writeFileSync(path.join(postDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  fs.writeFileSync(path.join(postDir, 'caption.txt'), version.hook_text, 'utf8');

  console.log(JSON.stringify({
    post_id: postId,
    output_path: path.relative(ROOT, postDir).replace(/\\/g, '/'),
    language,
    pillar_id: pillarId,
    topic_id: topic.id,
    master_script_id: masterScriptId,
    hook_type: script.hook_type,
    slide_count: script.slide_count,
    cta_slide: script.cta_slide
  }, null, 2));
}

main();
