import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ingest } from './ingestion.mjs';
import { matchKpi, parseNumber } from './rules.mjs';

export async function evaluateSamples(directory, domain) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
  catch { return { summary: { passed: 0, total: 0, accuracy: null, fixtureOnly: true }, results: [], limitations: ['Generate sample sources before evaluation. No measurements available.'] }; }
  const results = [];
  for (const fixture of manifest.files) {
    const bytes = await readFile(path.join(directory, fixture.name));
    const { records } = await ingest(bytes, fixture.name, { customerId: fixture.customerId, period: fixture.period }, domain);
    for (let index = 0; index < fixture.expected.length; index++) {
      const expected = fixture.expected[index];
      const actual = records[index];
      const expectedId = matchKpi(expected.kpi, domain)?.id ?? 'unknown';
      const expectedValue = parseNumber(expected.value);
      results.push({
        name: `${fixture.name}: row ${index + 1}`,
        passed: actual?.value === expectedValue && actual?.kpiId === expectedId && (expected.customerRating === undefined || actual?.customerRating === expected.customerRating) && Boolean(actual?.source.page || actual?.source.cell || actual?.source.row),
        expected: { kpiId: expectedId, value: expectedValue, ...(expected.customerRating ? { customerRating: expected.customerRating } : {}) },
        actual: actual ? { kpiId: actual.kpiId, value: actual.value, ...(expected.customerRating ? { customerRating: actual.customerRating } : {}) } : null,
      });
    }
    results.push({ name: `${fixture.name}: row count`, passed: records.length === fixture.expected.length, expected: fixture.expected.length, actual: records.length });
  }
  const passed = results.filter(result => result.passed).length;
  return {
    summary: { passed, total: results.length, accuracy: results.length ? passed / results.length : null, fixtureOnly: true },
    results,
    limitations: ['Tiny public synthetic fixture only; not an accuracy estimate for a customer corpus.', 'Local confidence is a deterministic parsing signal, not calibrated probability.', 'No scan/chart OCR, live Azure, latency, or business target attainment measured.', 'Human confirmation, approval and publication remain mandatory.'],
  };
}
