'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../');
const CONFIG_PATH = path.join(ROOT, 'test-inputs', 'assembly-config.json');
const RENDERS_DIR = path.join(ROOT, 'renders');

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function imageToDataUrl(imgPath) {
  const buf = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).toLowerCase().slice(1);
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function buildHtml(dataUrl, text) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
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
    top: 28%;
    left: 50%;
    transform: translateX(-50%);
    max-width: 780px;
    color: #ffffff;
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    font-size: 55px;
    font-weight: 700;
    line-height: 1.12;
    text-align: center;
    direction: rtl;
    white-space: pre-line;
    letter-spacing: normal;
    -webkit-text-stroke: 0;
    text-shadow:
      -1px -1px 0 rgba(0,0,0,0.95),
       0px -1px 0 rgba(0,0,0,0.95),
       1px -1px 0 rgba(0,0,0,0.95),
      -1px  0px 0 rgba(0,0,0,0.95),
       1px  0px 0 rgba(0,0,0,0.95),
      -1px  1px 0 rgba(0,0,0,0.95),
       0px  1px 0 rgba(0,0,0,0.95),
       1px  1px 0 rgba(0,0,0,0.95);
  }
</style>
</head>
<body>
  <div class="bg"></div>
  <div class="text-block">${escapeHtml(text)}</div>
</body>
</html>`;
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!fs.existsSync(RENDERS_DIR)) {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
  }

  const browser = await chromium.launch();

  for (const slide of config.slides) {
    const imgAbsPath = path.join(ROOT, slide.image_path);

    if (!fs.existsSync(imgAbsPath)) {
      console.warn(`Image not found, skipping slide ${slide.slide_number}: ${imgAbsPath}`);
      continue;
    }

    const dataUrl = imageToDataUrl(imgAbsPath);
    const html = buildHtml(dataUrl, slide.text);

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1080, height: 1920 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    const outPath = path.join(RENDERS_DIR, `slide-${slide.slide_number}.png`);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
    await page.close();

    console.log(`✓ slide-${slide.slide_number}.png`);
  }

  await browser.close();
  console.log(`\nDone — ${config.slides.length} slides written to renders/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
