'use strict';

const path = require('path');
const ExcelJS = require('exceljs');

class ApprovedTaxonomyError extends Error {}

function cellText(cell) {
  const value = cell.value;
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
  throw new ApprovedTaxonomyError(`Unsupported taxonomy cell value at ${cell.address}`);
}

function createApprovedTaxonomyService(options = {}) {
  const workbookPath = path.resolve(options.workbookPath || path.join(__dirname, '..', '..', 'content', 'script-library', 'source', 'script-library.xlsx'));
  async function getTaxonomy() {
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.readFile(workbookPath); } catch (error) { throw new ApprovedTaxonomyError(`Unable to read approved taxonomy workbook: ${error.message}`); }
    const sheet = workbook.getWorksheet('Taxonomy');
    if (!sheet) throw new ApprovedTaxonomyError('Workbook is missing the Taxonomy sheet');
    const pillars = new Set();
    const hookTypes = new Set();
    const formats = new Set();
    const subtopics = [];
    let section = null;
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const first = cellText(row.getCell(1));
      const second = cellText(row.getCell(2));
      if (first === 'Section A — Pillars') { section = 'pillars'; return; }
      if (first === 'Section B — Hook Types') { section = 'hooks'; return; }
      if (first === 'Section C — Formats') { section = 'formats'; return; }
      if (first === 'Section D — Suggested Subtopics') { section = 'subtopics'; return; }
      if (!first) return;
      if (section === 'pillars') pillars.add(first);
      else if (section === 'hooks') hookTypes.add(first);
      else if (section === 'formats') formats.add(first);
      else if (section === 'subtopics' && second) subtopics.push({ subtopic: first, pillar: second });
    });
    if (!pillars.size || !hookTypes.size || !formats.size || !subtopics.length) throw new ApprovedTaxonomyError('Approved taxonomy is incomplete');
    return { pillars: [...pillars], subtopics, hook_types: [...hookTypes], formats: [...formats] };
  }
  return { getTaxonomy };
}

module.exports = { ApprovedTaxonomyError, createApprovedTaxonomyService };
