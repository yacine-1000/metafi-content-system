'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.resolve(__dirname, '..');
const ARABIC_LIBRARY_DIR = path.join(ROOT, 'content', 'script-library');
const DEFAULT_WORKBOOK = 'script-library-updated.xlsx';
const SHEET_NAME = 'Script Library';
const SLIDE_TWO_TEXT = 'احفظي المقطع\nبتحتاجينه';
const EXPECTED_HEADERS = [
  'Source Set ID', 'Script ID', 'Pillar', 'Pillar Name', 'Version', 'Status',
  'Slide 1', 'Slide 2', 'Slide 3', 'Slide 4', 'Slide 5', 'Slide 6',
  'Slide 7', 'Slide 8', 'Slide 9', 'Slide 10', 'Slide 11', 'Slide 12',
];
const SOURCE_SET_ID_PATTERN = /^SET-\d{3,}$/;
const PILLAR_PATTERN = /^P[1-4]$/;
const ENGLISH_SHEET_NAME = '111 Scripts (EN)';
const ARABIC_UPDATED_SHEET_NAME = '111 Scripts';
const ENGLISH_HEADERS = [
  '#', 'Script ID', 'Variant', 'Pillar', 'Subtopic', 'Topic', 'Format', 'Slide Count',
  'Slide 1', 'Slide 2', 'Slide 3', 'Slide 4', 'Slide 5', 'Slide 6',
  'Slide 7', 'Slide 8', 'Slide 9', 'Slide 10', 'Slide 11', 'Slide 12',
];
const ENGLISH_PILLARS = Object.freeze({
  'Hybrid Athlete / Sport + Gym Balance': 'P2',
  'Workout Programming / Exercise Selection': 'P3',
});
const ENGLISH_NEW_SOURCE_SETS = Object.freeze({
  'NEW-001': 'SET-045', 'NEW-002': 'SET-046', 'NEW-003': 'SET-047', 'NEW-004': 'SET-048',
  'NEW-005': 'SET-049', 'NEW-006': 'SET-050', 'NEW-007': 'SET-051',
});

class ScriptLibraryImportError extends Error {
  constructor(message, report = null) {
    super(message);
    this.name = 'ScriptLibraryImportError';
    this.report = report;
  }
}

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

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function validateHeaders(sheet) {
  if (!sheet) throw new ScriptLibraryImportError(`Workbook is missing the "${SHEET_NAME}" sheet`);
  const actual = EXPECTED_HEADERS.map((_header, index) => textValue(
    sheet.getRow(1).getCell(index + 1),
    `${SHEET_NAME}!${sheet.getRow(1).getCell(index + 1).address}`,
  ));
  EXPECTED_HEADERS.forEach((expected, index) => {
    if (actual[index] !== expected) {
      throw new ScriptLibraryImportError(
        `${SHEET_NAME} column ${index + 1} must be "${expected}"; found "${actual[index] || ''}"`,
      );
    }
  });
}

function parseAndValidate(sheet) {
  const errors = [];
  const warnings = [];
  const scriptIds = new Set();
  const duplicateScriptIds = new Set();
  const sourceSets = new Map();
  const scriptsPerPillar = { P1: 0, P2: 0, P3: 0, P4: 0 };
  let scriptCount = 0;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const at = (column) => `${SHEET_NAME}!${row.getCell(column).address}`;
    const readRequired = (column, label) => {
      try {
        return textValue(row.getCell(column), at(column), { required: true });
      } catch (error) {
        errors.push(`${label}: ${error.message}`);
        return null;
      }
    };
    const sourceSetId = readRequired(1, 'missing Source Set ID');
    const scriptId = readRequired(2, 'missing Script ID');
    const pillar = readRequired(3, 'missing Pillar');
    const pillarName = readRequired(4, 'missing Pillar Name');
    const version = readRequired(5, 'missing Version');
    const status = readRequired(6, 'missing Status');

    if (!sourceSetId || !scriptId || !pillar || !pillarName || !version || !status) continue;
    scriptCount += 1;
    if (!SOURCE_SET_ID_PATTERN.test(sourceSetId)) errors.push(`${at(1)} has invalid Source Set ID "${sourceSetId}"`);
    if (!PILLAR_PATTERN.test(pillar)) errors.push(`${at(3)} must be P1, P2, P3, or P4`);
    if (scriptIds.has(scriptId)) duplicateScriptIds.add(scriptId);
    scriptIds.add(scriptId);
    if (PILLAR_PATTERN.test(pillar)) scriptsPerPillar[pillar] += 1;

    const slideValues = [];
    for (let slideNumber = 1; slideNumber <= 12; slideNumber += 1) {
      try {
        slideValues.push(textValue(row.getCell(6 + slideNumber), at(6 + slideNumber)));
      } catch (error) {
        errors.push(error.message);
        slideValues.push(null);
      }
    }
    const populatedNumbers = slideValues
      .map((text, index) => (text == null ? null : index + 1))
      .filter((number) => number != null);
    const lastSlideNumber = populatedNumbers.length ? populatedNumbers[populatedNumbers.length - 1] : 0;

    if (slideValues[0] == null) errors.push(`${at(7)} is missing Slide 1`);
    if (slideValues[1] !== SLIDE_TWO_TEXT) errors.push(`${at(8)} has incorrect Slide 2`);
    if (lastSlideNumber < 3 || lastSlideNumber > 12) {
      errors.push(`${at(7)}:${at(18)} has ${lastSlideNumber} slides; expected 3 through 12`);
    }
    for (let slideNumber = 1; slideNumber <= lastSlideNumber; slideNumber += 1) {
      if (slideValues[slideNumber - 1] == null) {
        errors.push(`${at(6 + slideNumber)} is a blank gap before Slide ${lastSlideNumber}`);
      }
    }
    if (!lastSlideNumber || slideValues[lastSlideNumber - 1] == null) {
      errors.push(`${at(6 + Math.max(lastSlideNumber, 1))} has an empty final CTA`);
    }

    const slides = [];
    for (let slideNumber = 1; slideNumber <= lastSlideNumber; slideNumber += 1) {
      const text = slideValues[slideNumber - 1];
      if (text == null) continue;
      slides.push({
        slide_number: slideNumber,
        slide_label: `Slide ${slideNumber}`,
        is_metafi_slide: slideNumber === lastSlideNumber,
        text,
      });
    }

    const metadata = {
      source_set_id: sourceSetId,
      pillar,
      pillar_name: pillarName,
      subtopic: pillarName,
      topic: pillarName,
    };
    if (!sourceSets.has(sourceSetId)) sourceSets.set(sourceSetId, { ...metadata, scripts: [] });
    const sourceSet = sourceSets.get(sourceSetId);
    for (const field of ['pillar', 'pillar_name']) {
      if (sourceSet[field] !== metadata[field]) {
        errors.push(`${at(1)} conflicts with ${field} already stored for ${sourceSetId}`);
      }
    }
    sourceSet.scripts.push({
      script_id: scriptId,
      script_version: version,
      status,
      hook_type: version,
      format: 'listicle',
      original_slide_count: lastSlideNumber,
      final_slide_count: lastSlideNumber,
      slides,
    });
  }

  for (const scriptId of duplicateScriptIds) errors.push(`duplicate Script ID "${scriptId}"`);
  if (!sourceSets.size) errors.push(`${SHEET_NAME} contains no Source Sets`);
  const report = {
    source_set_count: sourceSets.size,
    script_count: scriptCount,
    scripts_per_pillar: scriptsPerPillar,
    duplicate_script_ids: [...duplicateScriptIds].sort(),
    missing_source_set_ids: errors.filter((error) => error.startsWith('missing Source Set ID')).length,
    missing_slide_1: errors.filter((error) => error.endsWith('is missing Slide 1')).length,
    incorrect_slide_2: errors.filter((error) => error.endsWith('has incorrect Slide 2')).length,
    invalid_slide_counts: errors.filter((error) => error.includes('slides; expected 3 through 12')).length,
    blank_slide_gaps: errors.filter((error) => error.includes('is a blank gap before Slide')).length,
    empty_final_cta: errors.filter((error) => error.endsWith('has an empty final CTA')).length,
    warnings,
    errors,
  };
  return { sourceSets, report };
}

function parse111ScriptsAndValidate(sheet, sheetName) {
  if (!sheet) throw new ScriptLibraryImportError(`Workbook is missing the "${sheetName}" sheet`);
  ENGLISH_HEADERS.forEach((header, offset) => {
    const actual = textValue(sheet.getRow(1).getCell(offset + 1), `${sheetName}!${sheet.getRow(1).getCell(offset + 1).address}`);
    if (actual !== header) throw new ScriptLibraryImportError(`${sheetName} column ${offset + 1} must be "${header}"; found "${actual || ''}"`);
  });
  const errors = [];
  const duplicateScriptIds = new Set();
  const scriptIds = new Set();
  const sourceSets = new Map();
  const scriptsPerPillar = { P1: 0, P2: 0, P3: 0, P4: 0 };
  let scriptCount = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const at = (column) => `${sheetName}!${row.getCell(column).address}`;
    const required = (column, label) => {
      try { return textValue(row.getCell(column), at(column), { required: true }); } catch (error) { errors.push(`${label}: ${error.message}`); return null; }
    };
    const originalId = required(2, 'missing Script ID');
    const variant = required(3, 'missing Variant');
    const pillarName = required(4, 'missing Pillar');
    const subtopic = required(5, 'missing Subtopic');
    const topic = required(6, 'missing Topic');
    const format = required(7, 'missing Format');
    const declaredSlideCount = required(8, 'missing Slide Count');
    if (!originalId || !variant || !pillarName || !subtopic || !topic || !format || !declaredSlideCount) continue;
    const sourceSetId = originalId.match(/^(SET-\d{3,})-/)?.[1] || ENGLISH_NEW_SOURCE_SETS[originalId];
    const variantNumber = variant.match(/^Variant (\d+)$/)?.[1];
    const version = variant === 'Original' ? 'ORIGINAL' : variantNumber ? `V${variantNumber}` : null;
    const pillar = ENGLISH_PILLARS[pillarName];
    if (!sourceSetId) errors.push(`${at(2)} cannot derive Source Set ID from "${originalId}"`);
    if (!version) errors.push(`${at(3)} has unsupported Variant "${variant}"`);
    if (!pillar) errors.push(`${at(4)} has unmapped Pillar "${pillarName}"`);
    if (!sourceSetId || !version || !pillar) continue;
    scriptCount += 1;
    const scriptId = `${sourceSetId}-${version}`;
    if (scriptIds.has(scriptId)) duplicateScriptIds.add(scriptId);
    scriptIds.add(scriptId);
    scriptsPerPillar[pillar] += 1;
    const slideValues = [];
    for (let slideNumber = 1; slideNumber <= 12; slideNumber += 1) {
      let text;
      try { text = textValue(row.getCell(8 + slideNumber), at(8 + slideNumber)); } catch (error) { errors.push(error.message); text = null; }
      slideValues.push(text);
    }
    const expectedSlideCount = Number(declaredSlideCount);
    if (!Number.isInteger(expectedSlideCount) || expectedSlideCount < 5 || expectedSlideCount > 12) errors.push(`${at(8)} must be an integer from 5 to 12`);
    if (slideValues[0] == null) errors.push(`${at(9)} is missing Slide 1`);
    if (slideValues.slice(expectedSlideCount).some((text) => text != null)) errors.push(`${at(8)} has content after Slide Count`);
    const slides = slideValues.slice(0, expectedSlideCount).map((text, offset) => ({
      slide_number: offset + 1,
      slide_label: `Slide ${offset + 1}`,
      is_metafi_slide: offset + 1 === 5,
      // A blank source cell remains a blank slide; no script text is changed or synthesized.
      text: text == null ? '' : text,
    }));
    if (slideValues[4] == null) errors.push(`Script ID "${scriptId}" (${at(13)}) is missing the designated Slide 5 Metafi promotion`);
    if (slides.filter((slide) => slide.is_metafi_slide).length !== 1) errors.push(`Script ID "${scriptId}" must contain exactly one Metafi slide marker`);
    const metadata = { source_set_id: sourceSetId, pillar, pillar_name: pillarName, subtopic, topic };
    if (!sourceSets.has(sourceSetId)) sourceSets.set(sourceSetId, { ...metadata, scripts: [] });
    const sourceSet = sourceSets.get(sourceSetId);
    for (const field of ['pillar', 'pillar_name', 'subtopic', 'topic']) if (sourceSet[field] !== metadata[field]) errors.push(`${at(2)} conflicts with ${field} already stored for ${sourceSetId}`);
    sourceSet.scripts.push({ script_id: scriptId, script_version: version, status: 'Ready', hook_type: version, format, original_slide_count: expectedSlideCount, final_slide_count: expectedSlideCount, slides });
  }
  for (const scriptId of duplicateScriptIds) errors.push(`duplicate Script ID "${scriptId}"`);
  if (!sourceSets.size) errors.push(`${sheetName} contains no Source Sets`);
  return { sourceSets, report: { source_set_count: sourceSets.size, script_count: scriptCount, scripts_per_pillar: scriptsPerPillar, duplicate_script_ids: [...duplicateScriptIds].sort(), missing_source_set_ids: 0, missing_slide_1: errors.filter((error) => error.endsWith('is missing Slide 1')).length, incorrect_slide_2: 0, invalid_slide_counts: errors.filter((error) => error.includes('Slide Count')).length, blank_slide_gaps: 0, empty_final_cta: 0, warnings: [], errors } };
}

function resolveLibraryOptions({ libraryDir = ARABIC_LIBRARY_DIR, workbookName = DEFAULT_WORKBOOK, language = 'ar' } = {}) {
  const resolvedLibraryDir = path.resolve(libraryDir);
  return {
    libraryDir: resolvedLibraryDir,
    workbookPath: path.join(resolvedLibraryDir, 'source', workbookName),
    sourceSetsDir: path.join(resolvedLibraryDir, 'source-sets'),
    indexPath: path.join(resolvedLibraryDir, 'index.json'),
    language,
  };
}

async function importScriptLibrary(options = {}) {
  const { workbookPath, sourceSetsDir, indexPath, language } = resolveLibraryOptions(options);
  if (!fs.existsSync(workbookPath)) {
    throw new ScriptLibraryImportError(`Workbook is missing: ${path.relative(ROOT, workbookPath)}`);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const uses111Schema = language === 'en' || path.basename(workbookPath) === DEFAULT_WORKBOOK;
  const sheetName = language === 'en' ? ENGLISH_SHEET_NAME : ARABIC_UPDATED_SHEET_NAME;
  const sheet = workbook.getWorksheet(uses111Schema ? sheetName : SHEET_NAME);
  if (!uses111Schema) validateHeaders(sheet);
  // Workbook content stays read-only; its 111-script schema is normalized only in memory.
  const { sourceSets, report } = uses111Schema ? parse111ScriptsAndValidate(sheet, sheetName) : parseAndValidate(sheet);
  if (report.errors.length) {
    throw new ScriptLibraryImportError(`Validation failed with ${report.errors.length} error(s)`, report);
  }

  const ordered = Array.from(sourceSets.values()).sort((left, right) => (
    left.source_set_id.localeCompare(right.source_set_id, undefined, { numeric: true })
  ));
  fs.mkdirSync(sourceSetsDir, { recursive: true });
  for (const sourceSet of ordered) {
    writeJsonAtomic(path.join(sourceSetsDir, `${sourceSet.source_set_id}.json`), sourceSet);
  }
  const expectedFiles = new Set(ordered.map((sourceSet) => `${sourceSet.source_set_id}.json`));
  for (const filename of fs.readdirSync(sourceSetsDir)) {
    if (path.extname(filename).toLowerCase() === '.json' && !expectedFiles.has(filename)) {
      fs.unlinkSync(path.join(sourceSetsDir, filename));
    }
  }
  const index = {
    source_sets: ordered.map((sourceSet) => ({
      source_set_id: sourceSet.source_set_id,
      file: `source-sets/${sourceSet.source_set_id}.json`,
      pillar: sourceSet.pillar,
      pillar_name: sourceSet.pillar_name,
      subtopic: sourceSet.subtopic,
      topic: sourceSet.topic,
      hook_types: Array.from(new Set(sourceSet.scripts.map((script) => script.hook_type))),
      script_count: sourceSet.scripts.length,
    })),
  };
  writeJsonAtomic(indexPath, index);
  return report;
}

if (require.main === module) {
  const english = process.argv.includes('--language=en');
  importScriptLibrary(english ? {
    libraryDir: path.join(ROOT, 'content', 'script-library-en'),
    workbookName: 'script-library.xlsx',
    language: 'en',
  } : undefined)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`Script Library import failed: ${error.message}`);
      if (error.report) console.error(JSON.stringify(error.report, null, 2));
      process.exitCode = 1;
    });
}

module.exports = { ScriptLibraryImportError, importScriptLibrary, resolveLibraryOptions };
