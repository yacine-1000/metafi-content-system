'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePath, ensureParentDir } = require('../lib/pathResolver');

const ROOT = path.resolve(__dirname, '../../');

const hookOutput       = JSON.parse(fs.readFileSync(resolvePath(ROOT, 'METAFI_HOOK_INPUT',        'test-outputs/hookOutput.json'),       'utf8'));
const bodyOutput       = JSON.parse(fs.readFileSync(resolvePath(ROOT, 'METAFI_BODY_INPUT',        'test-outputs/bodyOutput.json'),       'utf8'));
const finalSlideOutput = JSON.parse(fs.readFileSync(resolvePath(ROOT, 'METAFI_FINAL_SLIDE_INPUT', 'test-outputs/finalSlideOutput.json'), 'utf8'));

const errors = [];

if (!hookOutput.selected_hook || !hookOutput.selected_hook.trim()) {
  errors.push('hookOutput.selected_hook is missing or empty');
}

if (!Array.isArray(bodyOutput.body_slides)) {
  errors.push('bodyOutput.body_slides is missing or not an array');
} else if (bodyOutput.body_slides.length !== 3) {
  errors.push(`bodyOutput.body_slides must have exactly 3 items, got ${bodyOutput.body_slides.length}`);
} else {
  bodyOutput.body_slides.forEach((slide, i) => {
    if (!slide.slide_text || !slide.slide_text.trim()) {
      errors.push(`bodyOutput.body_slides[${i}] missing or empty slide_text`);
    }
  });
}

if (!finalSlideOutput.final_slide_text || !finalSlideOutput.final_slide_text.trim()) {
  errors.push('finalSlideOutput.final_slide_text is missing or empty');
}

if (errors.length > 0) {
  console.error('Assembly validation failed:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}

const IMAGE_PATHS = {
  1: 'assets/hook-images/hook-01.png',
  2: 'assets/body-images/body-01.jpg',
  3: 'assets/body-images/body-02.jpg',
  4: 'assets/body-images/body-03.jpg',
  5: 'assets/final-slide-images/final-01.png',
};

const slides = [
  { slide_number: 1, image_path: IMAGE_PATHS[1], text: hookOutput.selected_hook },
  ...bodyOutput.body_slides.map((s) => ({
    slide_number: s.slide_number,
    image_path: IMAGE_PATHS[s.slide_number],
    text: s.slide_text,
  })),
  { slide_number: 5, image_path: IMAGE_PATHS[5], text: finalSlideOutput.final_slide_text },
];

const config = { slides };

const outPath = resolvePath(ROOT, 'METAFI_ASSEMBLY_CONFIG_OUTPUT', 'test-inputs/assembly-config.json');
fs.writeFileSync(ensureParentDir(outPath), JSON.stringify(config, null, 2), 'utf8');
console.log(`✓ assembly-config.json written (${slides.length} slides)`);
