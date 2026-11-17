import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const template = JSON.parse(await readFile(path.join(root, 'demo-ids.template.json'), 'utf8'));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:mjs|js|html|css)$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

test('workload labels and aliases are configured rather than embedded in shared application code', async () => {
  const labels = template.domain.kpis.flatMap(kpi => [kpi.name, ...kpi.aliases])
    .filter(label => label.length > 5);
  for (const file of await sourceFiles(path.join(root, 'app'))) {
    const content = (await readFile(file, 'utf8')).toLowerCase();
    for (const label of labels) {
      assert.ok(!content.includes(label.toLowerCase()), `${path.relative(root, file)} embeds a configured workload label`);
    }
  }
});

test('the portable template contains placeholders rather than populated deployment identifiers', () => {
  assert.equal(template._template, true);
  for (const key of ['tenantId', 'subscriptionId', 'resourceGroup', 'appUrl', 'contentUnderstandingEndpoint', 'contentUnderstandingCompletionModel', 'contentUnderstandingCompletionDeployment', 'contentUnderstandingEmbeddingModel', 'contentUnderstandingEmbeddingDeployment', 'modelEndpoint', 'modelDeployment', 'cosmosEndpoint']) {
    assert.equal(template[key], '', `${key} must remain an empty deployment placeholder`);
  }
  assert.ok(template.domain.kpis.length > 0);
  assert.match(template.domain._note, /only workload-specific/i);
});

test('a different domain can upload evidence and calculate statuses without application changes', async t => {
  const { createApp } = await import('../app/server.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-domain-'));
  const config = structuredClone(template);
  config.domain = {
    ...config.domain,
    title: 'Facility Resource Review',
    entityLabel: 'Facility',
    toolName: 'facility_evidence',
    toolDescription: 'Retrieve authorized facility readings with source evidence.',
    kpis: [
      { id: 'energy', name: 'Energy intensity', aliases: ['Specific energy'], unit: 'kWh/m2', direction: 'lower', target: 50, watch: 60, warning: 75 },
      { id: 'availability', name: 'Plant availability', aliases: ['Uptime'], unit: '%', direction: 'higher', target: 99, watch: 98, warning: 95 }
    ]
  };
  const server = await createApp({
    config,
    env: { HOST: '127.0.0.1', PORT: '0', AUTH_MODE: 'local', STATE_FILE: path.join(directory, 'state.json') }
  });
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  async function request(url, data) {
    const response = await fetch(base + url, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await response.json();
    assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  await request('/api/session', { role: 'reviewer' });
  const session = await request('/api/session');
  assert.equal(session.config.title, config.domain.title);
  assert.deepEqual(session.config.kpis.map(kpi => kpi.id), ['energy', 'availability']);
  const csv = [
    'Metric,Value,Unit',
    'Specific energy,65,kWh/m2',
    'Uptime,99.5,%'
  ].join('\n');
  const imported = await request('/api/documents', {
    name: 'facility-readings.csv',
    mediaType: 'text/csv',
    period: config.domain.period,
    contentBase64: Buffer.from(csv).toString('base64')
  });
  const energy = imported.records.find(record => record.kpiId === 'energy');
  const availability = imported.records.find(record => record.kpiId === 'availability');
  assert.ok(energy && availability, `Configured aliases must identify both metrics: ${JSON.stringify(imported)}`);
  assert.equal(energy?.value, 65);
  assert.equal(energy?.status.toLowerCase(), 'warning');
  assert.equal(availability?.value, 99.5);
  assert.equal(availability?.status, 'on_target');
  const state = await request('/api/state');
  assert.equal(state.records.length, 2);
  for (const original of template.domain.kpis) {
    assert.ok(!JSON.stringify(state).includes(original.name), 'The configured replacement must not retain an example metric');
  }
});
