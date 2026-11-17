import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function generateSamples({ directory = path.join(root, 'samples'), config } = {}) {
  config ??= JSON.parse(await readFile(path.join(root, 'demo-ids.template.json'), 'utf8'));
  const domain = config.domain ?? config;
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { default: ExcelJS } = await import('exceljs');
  await mkdir(directory, { recursive: true });
  const customers = [{ id: 'northstar', name: 'Northstar Components' }, { id: 'alpine', name: 'Alpine Mobility' }, { id: 'harbor', name: 'Harbor Systems' }];
  const files = [];
  async function atomicFile(name, bytes) {
    const target = path.join(directory, name);
    const pending = `${target}.${randomUUID()}.pending`;
    try { await writeFile(pending, bytes); await rename(pending, target); }
    finally { await rm(pending, { force: true }); }
  }
  function metricRows(variant) {
    return domain.kpis.map((kpi, index) => {
      const annual = kpi.direction === 'annual_cumulative' || kpi.ruleType === 'annual_cumulative';
      const value = variant === 1 && index === 1 ? '' : variant === 2 ? annual ? kpi.annualLimit + 1 : kpi.warning + (kpi.direction === 'higher' ? -1 : 1) : annual ? kpi.annualLimit : kpi.target;
      return { kpi: variant === 1 ? (kpi.aliases?.at(-1) || kpi.name) : kpi.name, value, unit: kpi.unit, uncertain: variant === 1 && index === 2, customerRating: 'Source accepted (synthetic)' };
    });
  }
  async function save(name, bytes, customerId, expected) {
    await atomicFile(name, bytes);
    files.push({ name, customerId, period: domain.period, expected });
  }
  const pdfRows = metricRows(0);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText('PUBLIC SYNTHETIC PERFORMANCE FIXTURE', { x: 40, y: 750, size: 14, font });
  page.drawText('Not customer data. Text-native PDF; no OCR claim.', { x: 40, y: 720, size: 10, font });
  pdfRows.forEach((row, index) => page.drawText(`${row.kpi} | ${row.value} | ${row.unit} | Customer rating: ${row.customerRating}`, { x: 40, y: 670 - index * 30, size: 9, font }));
  await save('synthetic-northstar.pdf', await pdf.save(), 'northstar', pdfRows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Public synthetic fixture generator';
  const sheet = workbook.addWorksheet('Metrics');
  sheet.addRow(['KPI', 'Value', 'Unit', 'Signal', 'Customer rating']);
  const excelRows = metricRows(1);
  for (const row of excelRows) sheet.addRow([row.kpi, row.value === '' ? '' : String(row.value).replace('.', ','), row.unit, row.uncertain ? 'uncertain' : '', row.customerRating]);
  await save('synthetic-alpine.xlsx', await workbook.xlsx.writeBuffer(), 'alpine', excelRows);
  const csvRows = metricRows(2);
  await save('synthetic-harbor.csv', `KPI;Value;Unit;Customer rating\n${csvRows.map(row => `${row.kpi};${row.value};${row.unit};${row.customerRating}`).join('\n')}\n`, 'harbor', csvRows);
  const first = domain.kpis[0];
  const decimal = Math.round(((first.target ?? first.annualLimit) - 0.6) * 10) / 10;
  const textRows = [{ kpi: first.aliases?.at(-1) || first.name, value: decimal, unit: first.unit }, { kpi: 'Unmapped synthetic indicator', value: 12, unit: 'items' }];
  await save('synthetic-decimal.txt', `PUBLIC SYNTHETIC FIXTURE\n${textRows.map(row => `${row.kpi} | ${String(row.value).replace('.', ',')} | ${row.unit}`).join('\n')}\n`, 'alpine', textRows);
  const jsonRows = metricRows(0);
  await save('synthetic-harbor.json', JSON.stringify({ synthetic: true, records: jsonRows }, null, 2), 'harbor', jsonRows);
  const manifest = { synthetic: true, description: 'Public generated sources; expected input values are ground truth, not prerecorded extraction.', customers, files };
  await atomicFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await generateSamples();
  console.log(`Generated ${manifest.files.length} public synthetic PDF/XLSX/CSV/TXT/JSON sources.`);
}
