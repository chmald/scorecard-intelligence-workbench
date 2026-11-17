import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assessRecords, classify, matchKpi, normalize, parseNumber } from './rules.mjs';

export class InputError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}

export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/)[0];
  const delimiter = firstLine.includes(';') ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index <= text.length; index++) {
    const character = text[index] ?? '\n';
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(field); field = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else field += character;
  }
  if (quoted) throw new InputError('Unclosed CSV quote.');
  return rows;
}

export function isRestricted(value) {
  return /\b(restricted|confidential)\b/i.test(String(value ?? ''));
}

export const localFileTypes = ['.pdf', '.xlsx', '.csv', '.txt', '.json'];
const cloudFileTypes = new Set(['.pdf', '.txt', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.docx', '.pptx', '.html', '.md', '.eml', '.msg']);
export const usesAzureExtraction = name => cloudFileTypes.has(path.extname(name).toLowerCase());
export function sourceMimeType(name) {
  return ({
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.html': 'text/html', '.md': 'text/markdown', '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook',
  })[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export async function extractRows(bytes, name, { azureExtract } = {}) {
  const extension = path.extname(name).toLowerCase();
  if (azureExtract && usesAzureExtraction(name)) {
    if (extension === '.pdf') {
      const localRows = await extractRows(bytes, name);
      if (localRows.some(row => isRestricted(row.text))) throw new InputError('Restricted source rejected before Azure extraction.', 403, 'RESTRICTED_SOURCE');
    }
    return azureExtract(bytes, { name, mimeType: sourceMimeType(name) });
  }
  if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    let document, loadingTask;
    try {
      loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
      document = await loadingTask.promise;
      const rows = [];
      if (document.numPages > 100) throw new InputError('PDF exceeds 100 pages.', 413);
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const lines = new Map();
        for (const item of content.items) {
          if (!item.str) continue;
          const y = Math.round(item.transform[5] / 3) * 3;
          const line = lines.get(y) ?? [];
          line.push({ x: item.transform[4], text: item.str });
          lines.set(y, line);
        }
        for (const [, line] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
          rows.push({ text: line.sort((a, b) => a.x - b.x).map(i => i.text).join(' '), page: pageNumber });
        }
      }
      return rows;
    } finally { await loadingTask?.destroy?.(); }
  }
  if (extension === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const rows = [];
    workbook.eachSheet(sheet => sheet.eachRow((row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, cell => cells.push(cell.text));
      rows.push({ cells, text: cells.join(' | '), row: rowNumber, cell: `${sheet.name}!B${rowNumber}` });
    }));
    return rows;
  }
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (extension === '.csv') return parseCsv(text).map((cells, index) => ({ cells, text: cells.join(' | '), row: index + 1 }));
  if (extension === '.txt') return text.split(/\r?\n/).filter(Boolean).map((line, index) => ({ text: line, row: index + 1 }));
  if (extension === '.json') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new InputError('Invalid JSON document.'); }
    const entries = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(entries)) throw new InputError('JSON source must be an array or have a records array.');
    if (isRestricted(JSON.stringify(parsed))) throw new InputError('Restricted source rejected before persistence.', 403, 'RESTRICTED_SOURCE');
    return entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new InputError('Invalid JSON row.');
      return { cells: [entry.kpi ?? entry.kpiName ?? entry.metric ?? '', entry.value ?? '', entry.unit ?? '', entry.uncertain ? 'uncertain' : ''], customerRating: entry.customerRating ?? entry.sourceRating ?? null, text: `${entry.kpi ?? entry.kpiName ?? entry.metric ?? ''} | ${entry.value ?? ''} | ${entry.unit ?? ''}${entry.customerRating || entry.sourceRating ? ` | Customer rating: ${entry.customerRating ?? entry.sourceRating}` : ''}`, row: index + 1, uncertain: entry.uncertain === true };
    });
  }
  if (cloudFileTypes.has(extension)) throw new InputError('This source format requires the configured Content Understanding extraction provider.', 415, 'CLOUD_EXTRACTION_REQUIRED');
  throw new InputError('Unsupported source format.', 415, 'UNSUPPORTED_FORMAT');
}

export async function ingest(bytes, name, metadata, domain, options = {}) {
  if (!bytes.length) throw new InputError('Empty document.', 422);
  if (Array.isArray(domain.acceptedFileTypes) && !domain.acceptedFileTypes.includes(path.extname(name).toLowerCase())) throw new InputError('This source format is disabled by the domain configuration.', 415);
  if (metadata.restricted || isRestricted(name) || isRestricted(bytes.toString('utf8'))) throw new InputError('Restricted source rejected before extraction.', 403, 'RESTRICTED_SOURCE');
  let rows;
  try { rows = await extractRows(bytes, name, options); }
  catch (error) {
    if (error instanceof InputError || error.status === 502) throw error;
    throw new InputError('Could not parse document. Check format and encryption.', 422, 'EXTRACTION_FAILED');
  }
  if (rows.some(row => isRestricted(row.text) || row.cells?.some(isRestricted))) {
    throw new InputError('Restricted source rejected before persistence. Upload a separately authorized source.', 403, 'RESTRICTED_SOURCE');
  }
  const documentId = randomUUID();
  const records = [];
  const warnings = [];
  let ratingColumn = -1;
  let metricColumn = 0, valueColumn = 1, unitColumn = 2;
  for (const row of rows) {
    if (row.sourcePeriod && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.sourcePeriod) && row.sourcePeriod !== metadata.period) throw new InputError('Extracted reporting period differs from the selected period. Correct the upload scope before continuing.', 422, 'PERIOD_MISMATCH');
    let cells = row.cells;
    if (!cells) cells = row.text.includes('|') ? row.text.split(/\s*\|\s*/) : row.text.split(/\s*[;:=]\s*/);
    if (cells.length < 2) continue;
    const headerMetric = cells.findIndex(cell => ['kpi', 'metric', 'indicator'].includes(normalize(cell)));
    const headerValue = cells.findIndex(cell => ['value', 'wert', 'valeur'].includes(normalize(cell)));
    if (headerMetric >= 0 && headerValue >= 0) {
      metricColumn = headerMetric; valueColumn = headerValue;
      unitColumn = cells.findIndex(cell => ['unit', 'einheit', 'unite'].includes(normalize(cell)));
      ratingColumn = cells.findIndex(cell => ['customerrating', 'sourcerating', 'kundenbewertung', 'evaluationclient'].includes(normalize(cell)));
      continue;
    }
    const label = String(cells[metricColumn] ?? '').trim();
    if (!label) continue;
    if (/^(kpi|metric|indicator)$/i.test(label)) {
      ratingColumn = cells.findIndex(cell => ['customerrating', 'sourcerating', 'kundenbewertung', 'evaluationclient'].includes(normalize(cell)));
      continue;
    }
    const kpi = matchKpi(label, domain);
    const rawValue = String(cells[valueColumn] ?? '').trim();
    const value = parseNumber(rawValue);
    if (!kpi && value === null && !row.cells) continue;
    const cloud = row.provider === 'azure-content-understanding';
    const confidence = cloud ? row.confidence : row.uncertain || /\b(uncertain|estimate|unverified)\b/i.test(cells.slice(2).join(' ')) ? 0.5 : value === null ? 0 : 1;
    const unit = String(cells[unitColumn] ?? '').trim() || (cloud ? '' : kpi?.unit || '');
    const confidenceSignal = cloud ? 'Content Understanding field confidence with source grounding; not a correctness guarantee' : 'deterministic parsing signal; not calibrated probability';
    const customerRating = row.customerRating ?? (ratingColumn >= 0 ? cells[ratingColumn] : cells.slice(3).find(cell => /^(customer|source) rating\s*:/i.test(cell))?.replace(/^(customer|source) rating\s*:\s*/i, '')) ?? null;
    records.push({
      id: randomUUID(), documentId, customerId: metadata.customerId, period: metadata.period,
      synthetic: metadata.synthetic === true,
      kpiId: kpi?.id ?? 'unknown', kpiName: kpi?.name ?? label.slice(0, 100),
      value, rawValue, unit, confidence, confidenceSignal,
      customerRating: customerRating === null || customerRating === '' ? null : String(customerRating).slice(0, 100),
      sourceRating: customerRating === null || customerRating === '' ? null : String(customerRating).slice(0, 100),
      status: classify(value, kpi, confidence, domain.confidenceThreshold),
      confirmed: false, version: 1,
      source: { file: name, text: row.text.slice(0, 1200), ...(row.page ? { page: row.page } : {}), ...(row.cell ? { cell: row.cell } : {}), ...(row.row ? { row: row.row } : {}), ...(cloud ? { fields: row.evidence, customer: row.sourceCustomer, period: row.sourcePeriod } : {}) },
    });
    if (row.warning) warnings.push(row.warning);
    if (!kpi) warnings.push(`Unknown metric: ${label.slice(0, 100)}. Not mapped to a configured rule.`);
  }
  if (!records.length) warnings.push('No metric rows extracted. Scanned PDFs/charts require the opt-in Azure extraction provider; no values were invented.');
  return {
    document: { id: documentId, name, ...metadata, format: path.extname(name).slice(1), mode: options.azureExtract && usesAzureExtraction(name) ? 'azure-content-understanding' : 'local-real-extraction', recordCount: records.length, uploadedAt: new Date().toISOString(), contentBase64: bytes.toString('base64') },
    records: assessRecords(records, domain), warnings,
  };
}
