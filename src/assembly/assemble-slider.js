'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { performance } = require('perf_hooks');
const { resolvePath } = require('../lib/pathResolver');

const ROOT = path.resolve(__dirname, '../../');
const CONFIG_PATH = resolvePath(ROOT, 'METAFI_ASSEMBLY_CONFIG_INPUT', 'test-inputs/assembly-config.json');
const RENDERS_DIR = resolvePath(ROOT, 'METAFI_RENDERS_DIR', 'renders');
const OPERATION_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 5000;

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function diagnostic(stage, event, startedAt, details = '') {
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  console.error(`[renderer] ${new Date().toISOString()} stage=${stage} event=${event} elapsed_ms=${elapsedMs}${details ? ` ${details}` : ''}`);
  return elapsedMs;
}

const FONT_PATH = fs.existsSync(path.join(ROOT, 'assets', 'fonts', 'monasabat.ttf'))
  ? path.join(ROOT, 'assets', 'fonts', 'monasabat.ttf')
  : null;

const FONT_FILE_URL = FONT_PATH ? 'file:///' + FONT_PATH.replace(/\\/g, '/') : null;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeText(str) {
  return str.replace(/[\r\n]+/g, ' ').replace(/  +/g, ' ').trim();
}

function prepareText(str) {
  if (process.env.METAFI_PRESERVE_LINE_BREAKS === '1') {
    return String(str).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  return normalizeText(String(str));
}

function renderTextHtml(str) {
  const escaped = escapeHtml(str);
  if (process.env.METAFI_PRESERVE_LINE_BREAKS === '1') {
    return escaped.replace(/\n/g, '<br>');
  }
  return escaped;
}

function imageToDataUrl(imgPath) {
  const buf = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).toLowerCase().slice(1);
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const STYLES = {
  'style-a': {
    fontFamily: '"Monasabat", "Tahoma", Arial, sans-serif',
    fontWeight: '400',
    fontSize: '56px',
    lineHeight: '1.24',
    maxWidth: '940px',
    width: '90%',
    top: '45%',
    textShadow: [
      '4px 0 0 #000',
      '-4px 0 0 #000',
      '0 4px 0 #000',
      '0 -4px 0 #000',
      '4px 4px 0 #000',
      '-4px 4px 0 #000',
      '4px -4px 0 #000',
      '-4px -4px 0 #000',
      '3px 0 0 #000',
      '-3px 0 0 #000',
      '0 3px 0 #000',
      '0 -3px 0 #000',
      '3px 3px 0 #000',
      '-3px 3px 0 #000',
      '3px -3px 0 #000',
      '-3px -3px 0 #000',
    ].join(', '),
  },
  'style-b': {
    fontFamily: '"Segoe UI", Tahoma, Arial, sans-serif',
    fontSize: '55px',
    lineHeight: '1.02',
    maxWidth: '820px',
    textShadow: [
      '-1px -1px 0 rgba(0,0,0,0.75)',
       '1px -1px 0 rgba(0,0,0,0.75)',
      '-1px  1px 0 rgba(0,0,0,0.75)',
       '1px  1px 0 rgba(0,0,0,0.75)',
    ].join(', '),
  },
  'style-c': {
    fontFamily: 'Tahoma, Arial, sans-serif',
    fontSize: '58px',
    lineHeight: '1',
    maxWidth: '800px',
    textShadow: '0 2px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.55)',
  },
  'style-d': {
    fontFamily: "'Almarai', 'Cairo', sans-serif",
    fontSize: '85px',
    lineHeight: '1.2',
    maxWidth: '900px',
    top: '45%',
    textShadow: [
      '2px 2px 0 #000',
      '-2px -2px 0 #000',
      '2px -2px 0 #000',
      '-2px 2px 0 #000',
      '0px 2px 0 #000',
      '2px 0px 0 #000',
      '0px -2px 0 #000',
      '-2px 0px 0 #000',
      '4px 4px 10px rgba(0,0,0,0.5)',
    ].join(', '),
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Almarai:wght@700;800&family=Cairo:wght@700;800&display=swap',
  },
};

function buildHtml(dataUrl, text, language, role, style) {
  const s = style || STYLES['style-a'];
  const direction = language === 'ar' ? 'rtl' : 'ltr';
  const top = role === 'cta' ? '18%' : (s.top || '45%');
  const fontLink = s.googleFontsUrl
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${s.googleFontsUrl}" rel="stylesheet">`
    : '';
  const fontFace = FONT_FILE_URL
    ? `@font-face { font-family: "Monasabat"; src: url("${FONT_FILE_URL}") format("truetype"); font-weight: 400; font-style: normal; }`
    : '';
  return `<!DOCTYPE html>
<html lang="${language}" dir="${direction}">
<head>
<meta charset="utf-8">
${fontLink}
<style>
  ${fontFace}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px;
    height: 1920px;
    overflow: hidden;
    position: relative;
    background: #000;
  }
  .bg {
    position: absolute;
    inset: 0;
    background-image: url('${dataUrl}');
    background-size: cover;
    background-position: center;
  }
  .text-block {
    position: absolute;
    top: ${top};
    left: 50%;
    transform: translate(-50%, -50%);
    width: ${s.width || 'auto'};
    max-width: ${s.maxWidth};
    color: #ffffff;
    font-family: ${s.fontFamily};
    font-size: ${s.fontSize};
    font-weight: ${s.fontWeight || '800'};
    line-height: ${s.lineHeight};
    text-align: center;
    direction: ${direction};
    white-space: normal;
    word-break: normal;
    overflow-wrap: normal;
    text-wrap: balance;
    letter-spacing: normal;
    -webkit-text-stroke: 0;
    text-shadow: ${s.textShadow};
  }
</style>
</head>
<body>
  <div class="bg"></div>
  <div class="text-block">${renderTextHtml(text)}</div>
</body>
</html>`;
}

function imageUrl(imgPath, mode = 'base64') {
  return mode === 'file' ? pathToFileURL(imgPath).href : imageToDataUrl(imgPath);
}

async function waitForRenderReadiness(page, slideNumber) {
  const imageStartedAt = performance.now();
  await withTimeout(page.evaluate(async () => {
    const background = getComputedStyle(document.querySelector('.bg')).backgroundImage;
    const match = background.match(/^url\(["']?(.*?)["']?\)$/);
    if (!match) throw new Error('Background image URL is missing');
    const image = new Image();
    image.src = match[1];
    if (image.decode) await image.decode();
    else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
  }), OPERATION_TIMEOUT_MS, `slide ${slideNumber} background image decode`);
  const imageMs = diagnostic('background_image', 'ready', imageStartedAt, `slide=${slideNumber}`);

  const fontStartedAt = performance.now();
  const fontState = await withTimeout(page.evaluate(async () => {
    await document.fonts.ready;
    const text = document.querySelector('.text-block');
    const computed = getComputedStyle(text);
    return { family: computed.fontFamily, ready: document.fonts.status === 'loaded' };
  }), OPERATION_TIMEOUT_MS, `slide ${slideNumber} font readiness`);
  const fontMs = diagnostic('font_loading', 'ready', fontStartedAt, `slide=${slideNumber} family=${JSON.stringify(fontState.family)} status=${fontState.ready ? 'loaded' : 'pending'}`);

  const layoutStartedAt = performance.now();
  await withTimeout(page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))), OPERATION_TIMEOUT_MS, `slide ${slideNumber} layout completion`);
  const layoutMs = diagnostic('layout', 'ready', layoutStartedAt, `slide=${slideNumber}`);
  return { image_ms: imageMs, font_ms: fontMs, layout_ms: layoutMs };
}

async function renderSlides(config, outDir, style, label, options = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const renderStartedAt = performance.now();
  const ownsBrowser = !options.browser;
  const launchStartedAt = performance.now();
  const browser = options.browser || await withTimeout(chromium.launch(), OPERATION_TIMEOUT_MS, 'browser launch');
  const launchMs = ownsBrowser ? diagnostic('browser_launch', 'complete', launchStartedAt) : 0;
  const contextStartedAt = performance.now();
  const context = await withTimeout(browser.newContext({ viewport: { width: 1080, height: 1920 } }), OPERATION_TIMEOUT_MS, 'browser context creation');
  const contextMs = diagnostic('browser_context', 'complete', contextStartedAt);
  const reusePage = (options.pageMode || process.env.METAFI_RENDER_PAGE_MODE || 'reuse') === 'reuse';
  const selectedImageMode = options.imageMode || process.env.METAFI_RENDER_IMAGE_MODE || 'base64';
  let page = null;
  const slideTimings = [];

  try {
    if (reusePage) {
      const pageStartedAt = performance.now();
      page = await withTimeout(context.newPage(), OPERATION_TIMEOUT_MS, 'post page creation');
      diagnostic('page_creation', 'complete', pageStartedAt, 'scope=post');
    }
    for (const slide of config.slides) {
    const slideStartedAt = performance.now();
    const imgAbsPath = path.join(ROOT, slide.image_path);

    if (!fs.existsSync(imgAbsPath)) {
      console.warn(`[${label}] Image not found, skipping slide ${slide.slide_number}: ${imgAbsPath}`);
      continue;
    }

    const sourceStartedAt = performance.now();
    const sourceUrl = imageUrl(imgAbsPath, selectedImageMode);
    const sourceMs = diagnostic('image_source', 'complete', sourceStartedAt, `slide=${slide.slide_number} mode=${selectedImageMode} bytes=${fs.statSync(imgAbsPath).size}`);
    const html = buildHtml(sourceUrl, prepareText(slide.text), slide.language, slide.role, style);

    if (!reusePage) {
      const pageStartedAt = performance.now();
      page = await withTimeout(context.newPage(), OPERATION_TIMEOUT_MS, `slide ${slide.slide_number} page creation`);
      diagnostic('page_creation', 'complete', pageStartedAt, `slide=${slide.slide_number}`);
    }
    try {
    const htmlStartedAt = performance.now();
    await withTimeout(page.setContent(html, { waitUntil: 'domcontentloaded' }), OPERATION_TIMEOUT_MS, `slide ${slide.slide_number} HTML setup`);
    const htmlMs = diagnostic('html_setup', 'complete', htmlStartedAt, `slide=${slide.slide_number}`);
    const readiness = await waitForRenderReadiness(page, slide.slide_number);

    const outPath = path.join(outDir, `slide-${slide.slide_number}.png`);
    const screenshotStartedAt = performance.now();
    await withTimeout(page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1080, height: 1920 } }), OPERATION_TIMEOUT_MS, `slide ${slide.slide_number} screenshot`);
    const screenshotMs = diagnostic('screenshot', 'complete', screenshotStartedAt, `slide=${slide.slide_number}`);
    const totalMs = diagnostic('slide', 'complete', slideStartedAt, `slide=${slide.slide_number}`);
    slideTimings.push({ slide: slide.slide_number, source_ms: sourceMs, html_ms: htmlMs, ...readiness, screenshot_ms: screenshotMs, total_ms: totalMs });

    console.log(`[${label}] ✓ slide-${slide.slide_number}.png`);
    } finally {
      if (!reusePage && page) {
        const closeStartedAt = performance.now();
        try { await withTimeout(page.close(), CLOSE_TIMEOUT_MS, `slide ${slide.slide_number} page close`); diagnostic('page_cleanup', 'complete', closeStartedAt, `slide=${slide.slide_number}`); }
        catch (error) { console.error(`[renderer] ${new Date().toISOString()} stage=page_cleanup event=warning slide=${slide.slide_number} error=${error.message}`); }
        page = null;
      }
    }
  }
  } finally {
    if (page) {
      const pageCloseStartedAt = performance.now();
      try { await withTimeout(page.close(), CLOSE_TIMEOUT_MS, 'post page cleanup'); diagnostic('page_cleanup', 'complete', pageCloseStartedAt, 'scope=post'); }
      catch (error) { console.error(`[renderer] ${new Date().toISOString()} stage=page_cleanup event=warning error=${error.message}`); }
    }
    const contextCloseStartedAt = performance.now();
    try { await withTimeout(context.close(), CLOSE_TIMEOUT_MS, 'browser context cleanup'); diagnostic('context_cleanup', 'complete', contextCloseStartedAt); }
    catch (error) { console.error(`[renderer] ${new Date().toISOString()} stage=context_cleanup event=warning error=${error.message}`); }
    if (ownsBrowser) {
      const closeStartedAt = performance.now();
      try { await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, 'browser close'); diagnostic('browser_close', 'complete', closeStartedAt); }
      catch (error) { console.error(`[renderer] ${new Date().toISOString()} stage=browser_close event=timeout error=${error.message}`); }
    }
  }
  const totalMs = diagnostic('render_post', 'complete', renderStartedAt, `slides=${slideTimings.length} page_mode=${reusePage ? 'reuse' : 'per-slide'} image_mode=${selectedImageMode}`);
  return { total_ms: totalMs, launch_ms: launchMs, context_ms: contextMs, slide_timings: slideTimings };
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const stylesMode = process.argv.includes('--styles');

  if (stylesMode) {
    for (const [name, style] of Object.entries(STYLES)) {
      const outDir = path.join(RENDERS_DIR, name);
      console.log(`\n--- ${name} ---`);
      await renderSlides(config, outDir, style, name);
      console.log(`--- ${name} done ---`);
    }
    console.log(`\nDone — 4 style folders written to renders/`);
  } else {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
    await renderSlides(config, RENDERS_DIR, STYLES['style-a'], 'default');
    console.log(`\nDone — ${config.slides.length} slides written to renders/`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { STYLES, buildHtml, renderSlides, waitForRenderReadiness };
