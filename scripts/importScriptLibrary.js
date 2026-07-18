'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.resolve(__dirname, '..');
const LIBRARY_DIR = path.join(ROOT, 'content', 'script-library');
const WORKBOOK_PATH = path.join(LIBRARY_DIR, 'source', 'script-library.xlsx');
const SOURCE_SETS_DIR = path.join(LIBRARY_DIR, 'source-sets');
const INDEX_PATH = path.join(LIBRARY_DIR, 'index.json');
const EXPECTED_HEADERS = [
  'Script ID', 'Source Set ID', 'Script Version', 'Pillar', 'Subtopic', 'Topic',
  'Hook Type', 'Format', 'Original Slide Count', 'Final Slide Count',
  'Slide 1', 'Slide 2', 'Slide 3', 'Slide 4 — Metafi', 'Slide 5', 'Slide 6',
  'Slide 7', 'Slide 8', 'Slide 9', 'Slide 10', 'Slide 11', 'Slide 12',
];
const SOURCE_SET_ID_PATTERN = /^SET-\d{3,}$/;

class ScriptLibraryImportError extends Error {}

function textValue(cell, location, { required = false } = {}) {
  const value = cell.value;
  if (value == null || value === '') {
    if (required) throw new ScriptLibraryImportError(`${location} is required`);
    return null;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
  if (value && Object.prototype.hasOwnProperty.call(value, 'formula')) {
    throw new ScriptLibraryImportError(`${location} must contain text, not a formula`);
  }
  throw new ScriptLibraryImportError(`${location} contains an unsupported Excel value`);
}

function integerValue(cell, location) {
  const value = cell.value;
  if (!Number.isInteger(value) || value <= 0) throw new ScriptLibraryImportError(`${location} must be a positive integer`);
  return value;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function taxonomyValues(sheet) {
  if (!sheet) throw new ScriptLibraryImportError('Workbook is missing the "Taxonomy" sheet');
  const sections = { pillars: new Set(), hookTypes: new Set(), formats: new Set(), subtopics: new Map() };
  let section = null;
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const first = textValue(row.getCell(1), `Taxonomy!A${row.number}`);
    const second = textValue(row.getCell(2), `Taxonomy!B${row.number}`);
    if (first === 'Section A — Pillars') { section = 'pillars'; return; }
    if (first === 'Section B — Hook Types') { section = 'hookTypes'; return; }
    if (first === 'Section C — Formats') { section = 'formats'; return; }
    if (first === 'Section D — Suggested Subtopics') { section = 'subtopics'; return; }
    if (!first) return;
    if (section === 'pillars') sections.pillars.add(first);
    else if (section === 'hookTypes') sections.hookTypes.add(first);
    else if (section === 'formats') sections.formats.add(first);
    else if (section === 'subtopics') sections.subtopics.set(first, second);
  });
  if (!sections.pillars.size || !sections.hookTypes.size || !sections.formats.size) {
    throw new ScriptLibraryImportError('Taxonomy sheet is missing required Pillars, Hook Types, or Formats sections');
  }
  return sections;
}

function validateHeaders(sheet) {
  if (!sheet) throw new ScriptLibraryImportError('Workbook is missing the "Scripts" sheet');
  const actual = EXPECTED_HEADERS.map((_header, index) => textValue(sheet.getRow(1).getCell(index + 1), `Scripts!${sheet.getRow(1).getCell(index + 1).address}`));
  EXPECTED_HEADERS.forEach((expected, index) => {
    if (actual[index] !== expected) throw new ScriptLibraryImportError(`Scripts column ${index + 1} must be "${expected}"; found "${actual[index] || ''}"`);
  });
}

function parseScripts(sheet, taxonomy) {
  const scriptIds = new Set();
  const sourceSets = new Map();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const at = (column) => `Scripts!${row.getCell(column).address}`;
    const scriptId = textValue(row.getCell(1), at(1), { required: true });
    const sourceSetId = textValue(row.getCell(2), at(2), { required: true });
    const scriptVersion = textValue(row.getCell(3), at(3), { required: true });
    const pillar = textValue(row.getCell(4), at(4), { required: true });
    const subtopic = textValue(row.getCell(5), at(5), { required: true });
    const topic = textValue(row.getCell(6), at(6), { required: true });
    const hookType = textValue(row.getCell(7), at(7), { required: true });
    const format = textValue(row.getCell(8), at(8), { required: true });
    const originalSlideCount = integerValue(row.getCell(9), at(9));
    const finalSlideCount = integerValue(row.getCell(10), at(10));

    if (scriptIds.has(scriptId)) throw new ScriptLibraryImportError(`${at(1)} duplicates Script ID "${scriptId}"`);
    scriptIds.add(scriptId);
    if (!SOURCE_SET_ID_PATTERN.test(sourceSetId)) throw new ScriptLibraryImportError(`${at(2)} has unsafe Source Set ID "${sourceSetId}"`);
    if (!scriptId.startsWith(`${sourceSetId}-`)) throw new ScriptLibraryImportError(`${at(1)} must begin with "${sourceSetId}-"`);
    if (!taxonomy.pillars.has(pillar)) throw new ScriptLibraryImportError(`${at(4)} uses unknown Pillar "${pillar}"`);
    if (!taxonomy.hookTypes.has(hookType)) throw new ScriptLibraryImportError(`${at(7)} uses unknown Hook Type "${hookType}"`);
    if (!taxonomy.formats.has(format)) throw new ScriptLibraryImportError(`${at(8)} uses unknown Format "${format}"`);
    if (taxonomy.subtopics.has(subtopic) && taxonomy.subtopics.get(subtopic) !== pillar) {
      throw new ScriptLibraryImportError(`${at(5)} maps Subtopic "${subtopic}" to the wrong Pillar`);
    }
    if (finalSlideCount > 12) throw new ScriptLibraryImportError(`${at(10)} cannot exceed the workbook's 12 slide columns`);

    const slides = [];
    for (let slideNumber = 1; slideNumber <= 12; slideNumber += 1) {
      const column = 10 + slideNumber;
      const text = textValue(row.getCell(column), at(column));
      if (slideNumber <= finalSlideCount && text == null) throw new ScriptLibraryImportError(`${at(column)} is required by Final Slide Count ${finalSlideCount}`);
      if (slideNumber > finalSlideCount && text != null) throw new ScriptLibraryImportError(`${at(column)} contains text beyond Final Slide Count ${finalSlideCount}`);
      if (text != null) {
        slides.push({
          slide_number: slideNumber,
          slide_label: EXPECTED_HEADERS[column - 1],
          is_metafi_slide: EXPECTED_HEADERS[column - 1].includes('— Metafi'),
          text,
        });
      }
    }
    if (slides.length !== finalSlideCount) throw new ScriptLibraryImportError(`${at(10)} does not match populated slide cells`);

    const setMetadata = { source_set_id: sourceSetId, pillar, subtopic, topic };
    if (!sourceSets.has(sourceSetId)) sourceSets.set(sourceSetId, { ...setMetadata, scripts: [] });
    const sourceSet = sourceSets.get(sourceSetId);
    for (const field of ['pillar', 'subtopic', 'topic']) {
      if (sourceSet[field] !== setMetadata[field]) throw new ScriptLibraryImportError(`${at(2)} conflicts with ${field} already stored for ${sourceSetId}`);
    }
    if (sourceSet.scripts.some((script) => script.script_version === scriptVersion)) {
      throw new ScriptLibraryImportError(`${at(3)} duplicates Script Version "${scriptVersion}" within ${sourceSetId}`);
    }
    sourceSet.scripts.push({
      script_id: scriptId,
      script_version: scriptVersion,
      hook_type: hookType,
      format,
      original_slide_count: originalSlideCount,
      final_slide_count: finalSlideCount,
      slides,
    });
  }
  if (!sourceSets.size) throw new ScriptLibraryImportError('Scripts sheet contains no Source Sets');
  for (const sourceSet of sourceSets.values()) {
    if (!sourceSet.scripts.some((script) => script.script_version === 'Original')) {
      throw new ScriptLibraryImportError(`${sourceSet.source_set_id} is missing its Original script`);
    }
  }
  return sourceSets;
}

async function importScriptLibrary() {
  if (!fs.existsSync(WORKBOOK_PATH)) throw new ScriptLibraryImportError(`Workbook is missing: ${path.relative(ROOT, WORKBOOK_PATH)}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_PATH);
  const scriptsSheet = workbook.getWorksheet('Scripts');
  validateHeaders(scriptsSheet);
  const taxonomy = taxonomyValues(workbook.getWorksheet('Taxonomy'));
  const sourceSets = parseScripts(scriptsSheet, taxonomy);
  const ordered = Array.from(sourceSets.values()).sort((left, right) => left.source_set_id.localeCompare(right.source_set_id, undefined, { numeric: true }));
  fs.mkdirSync(SOURCE_SETS_DIR, { recursive: true });
  for (const sourceSet of ordered) writeJsonAtomic(path.join(SOURCE_SETS_DIR, `${sourceSet.source_set_id}.json`), sourceSet);
  const expectedFiles = new Set(ordered.map((sourceSet) => `${sourceSet.source_set_id}.json`));
  for (const filename of fs.readdirSync(SOURCE_SETS_DIR)) {
    if (SOURCE_SET_ID_PATTERN.test(path.parse(filename).name) && path.extname(filename) === '.json' && !expectedFiles.has(filename)) {
      fs.unlinkSync(path.join(SOURCE_SETS_DIR, filename));
    }
  }
  const index = {
    source_sets: ordered.map((sourceSet) => ({
      source_set_id: sourceSet.source_set_id,
      file: `source-sets/${sourceSet.source_set_id}.json`,
      pillar: sourceSet.pillar,
      subtopic: sourceSet.subtopic,
      topic: sourceSet.topic,
      hook_types: Array.from(new Set(sourceSet.scripts.map((script) => script.hook_type))),
      script_count: sourceSet.scripts.length,
    })),
  };
  writeJsonAtomic(INDEX_PATH, index);
  return { source_set_count: ordered.length, script_count: ordered.reduce((count, sourceSet) => count + sourceSet.scripts.length, 0) };
}

if (require.main === module) {
  importScriptLibrary()
    .then((summary) => console.log(`Imported ${summary.script_count} scripts across ${summary.source_set_count} Source Sets.`))
    .catch((error) => {
      console.error(`Script Library import failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { ScriptLibraryImportError, importScriptLibrary };
