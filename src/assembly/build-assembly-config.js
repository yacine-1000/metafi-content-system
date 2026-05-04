'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../');

const hookOutput      = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-outputs/hookOutput.json'), 'utf8'));
const bodyOutput      = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-outputs/bodyOutput.json'), 'utf8'));
const finalSlideOutput = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-outputs/finalSlideOutput.json'), 'utf8'));

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

const outPath = path.join(ROOT, 'test-inputs/assembly-config.json');
fs.writeFileSync(outPath, JSON.stringify(config, null, 2), 'utf8');
console.log(`✓ assembly-config.json written (${slides.length} slides)`);
