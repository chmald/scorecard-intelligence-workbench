export function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const statusLabels = Object.freeze({
  on_target: 'On Track', watch: 'On Track (watch)', warning: 'Warning', critical: 'Off Track',
  missing: 'Not Measured', uncertain: 'Not Measured', unknown: 'Not Measured',
});

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(/%$/, '');
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return null;
  const number = Number(text.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

export function classify(value, kpi, confidence = 1, threshold = 0.9) {
  if (!kpi) return 'unknown';
  if (value === null || !Number.isFinite(value)) return 'missing';
  if (confidence < threshold) return 'uncertain';
  if (kpi.direction === 'annual_cumulative' || kpi.ruleType === 'annual_cumulative') {
    return Number.isFinite(kpi.annualLimit) ? value <= kpi.annualLimit ? 'on_target' : 'critical' : 'unknown';
  }
  if (kpi.direction === 'higher') {
    if (value >= kpi.target) return 'on_target';
    if (value >= kpi.watch) return 'watch';
    if (value >= kpi.warning) return 'warning';
    return 'critical';
  }
  if (value <= kpi.target) return 'on_target';
  if (value <= kpi.watch) return 'watch';
  if (value <= kpi.warning) return 'warning';
  return 'critical';
}

export function assessRecords(records, domain) {
  for (const record of records) {
    const kpi = domain.kpis.find(item => item.id === record.kpiId);
    const confidence = record.confirmed ? 1 : record.confidence;
    record.status = classify(record.value, kpi, confidence, domain.confidenceThreshold);
    record.statusLabel = statusLabels[record.status];
    const baseline = kpi?.internalBaseline;
    const baselineValue = typeof baseline === 'number' ? baseline : baseline?.value;
    const available = Number.isFinite(baselineValue) && Number.isFinite(record.value) && record.unit === kpi?.unit && (!baseline?.unit || baseline.unit === record.unit);
    const gap = available ? Number((record.value - baselineValue).toFixed(12)) : null;
    record.baselineComparison = {
      available, baseline: Number.isFinite(baselineValue) ? baselineValue : null, gap,
      unit: record.unit, provenance: baseline?.provenance || 'Configured internal baseline',
      synthetic: baseline?.synthetic === true,
      explanation: available ? `Reported value ${record.value} ${record.unit}; internal baseline ${baselineValue} ${record.unit}; arithmetic gap ${gap} ${record.unit}. No overall customer score is inferred.` : 'No comparable internal baseline/value is available; no gap was inferred.',
    };
    if (!kpi) {
      record.assessment = { complete: false, ruleType: 'unknown', explanation: 'Metric is not mapped to a configured rule.', evidenceIds: [record.id] };
      continue;
    }
    if (kpi.direction !== 'annual_cumulative' && kpi.ruleType !== 'annual_cumulative') {
      record.assessment = { complete: record.value !== null, ruleType: kpi.direction, target: kpi.target, evidenceIds: [record.id], explanation: record.value === null ? 'Source value is missing; no outcome was inferred.' : `Configured ${kpi.direction}-is-better rule: reported ${record.value} ${record.unit}, target ${kpi.target} ${kpi.unit}; internal status ${record.statusLabel}. Source/customer rating is independent.` };
      continue;
    }
    const year = record.period.slice(0, 4);
    const relevant = records.filter(item => item.customerId === record.customerId && item.kpiId === record.kpiId && item.period.slice(0, 4) === year && item.period <= record.period);
    let total = record.value;
    let complete = Number.isFinite(total);
    let dependencies = [record];
    if (kpi.accumulation === 'monthly_sum') {
      dependencies = relevant;
      const month = Number(record.period.slice(5, 7));
      const groups = Array.from({ length: month }, (_, index) => relevant.filter(item => item.period === `${year}-${String(index + 1).padStart(2, '0')}`));
      complete = groups.every(group => group.length === 1 && Number.isFinite(group[0].value));
      total = complete ? Number(groups.reduce((sum, group) => sum + group[0].value, 0).toFixed(12)) : null;
      if (complete && groups.some(group => !group[0].confirmed && group[0].confidence < (domain.confidenceThreshold ?? 0.9))) {
        complete = false;
        total = null;
      }
    }
    record.status = complete ? classify(total, kpi, confidence, domain.confidenceThreshold) : 'missing';
    record.statusLabel = statusLabels[record.status];
    record.assessment = {
      ruleType: 'annual_cumulative', accumulation: kpi.accumulation, year, annualLimit: kpi.annualLimit,
      annualTotal: complete ? total : null, complete, evidenceIds: dependencies.map(item => item.id),
      explanation: complete ? `${year} ${kpi.accumulation === 'reported_ytd' ? 'source-reported year-to-date' : 'complete monthly sum through ' + record.period} value ${total} ${record.unit}; configured annual limit ${kpi.annualLimit} ${kpi.unit}; internal status ${record.statusLabel}.` : 'Annual comparison abstained: missing, ambiguous, or uncertain monthly evidence; no cumulative total was invented.',
    };
  }
  return records;
}

export function matchKpi(label, domain) {
  const key = normalize(label);
  return domain.kpis.find(kpi => [kpi.id, kpi.name, ...(kpi.aliases ?? [])].some(alias => normalize(alias) === key));
}

export function summarize(records) {
  const counts = { total: records.length, confirmed: 0, on_target: 0, watch: 0, warning: 0, critical: 0, missing: 0, uncertain: 0, unknown: 0 };
  for (const record of records) {
    if (record.confirmed) counts.confirmed++;
    if (Object.hasOwn(counts, record.status)) counts[record.status]++;
  }
  return { ...counts, needsReview: records.filter(r => !r.confirmed).length, hasData: records.length > 0 };
}
