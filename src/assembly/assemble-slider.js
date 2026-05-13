'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../');
const CONFIG_PATH = path.join(ROOT, 'test-inputs', 'assembly-config.json');
const RENDERS_DIR = path.join(ROOT, 'renders');

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
    top: '21%',
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
    top: '25%',
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

function buildHtml(dataUrl, text, style) {
  const s = style || STYLES['style-a'];
  const fontLink = s.googleFontsUrl
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${s.googleFontsUrl}" rel="stylesheet">`
    : '';
  const fontFace = FONT_FILE_URL
    ? `@font-face { font-family: "Monasabat"; src: url("${FONT_FILE_URL}") format("truetype"); font-weight: 400; font-style: normal; }`
    : '';
  return `<!DOCTYPE html>
<html>
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
    top: ${s.top || '28%'};
    left: 50%;
    transform: translateX(-50%);
    width: ${s.width || 'auto'};
    max-width: ${s.maxWidth};
    color: #ffffff;
    font-family: ${s.fontFamily};
    font-size: ${s.fontSize};
    font-weight: ${s.fontWeight || '800'};
    line-height: ${s.lineHeight};
    text-align: center;
    direction: rtl;
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
  <div class="text-block">${escapeHtml(text)}</div>
</body>
</html>`;
}

async function renderSlides(config, outDir, style, label) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();

  for (const slide of config.slides) {
    const imgAbsPath = path.join(ROOT, slide.image_path);

    if (!fs.existsSync(imgAbsPath)) {
      console.warn(`[${label}] Image not found, skipping slide ${slide.slide_number}: ${imgAbsPath}`);
      continue;
    }

    const dataUrl = imageToDataUrl(imgAbsPath);
    const html = buildHtml(dataUrl, normalizeText(slide.text), style);

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1080, height: 1920 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    if (style && style.googleFontsUrl) {
      await page.evaluate(() => document.fonts.ready);
    }
    await page.waitForTimeout(300);

    const outPath = path.join(outDir, `slide-${slide.slide_number}.png`);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
    await page.close();

    console.log(`[${label}] ✓ slide-${slide.slide_number}.png`);
  }

  await browser.close();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
