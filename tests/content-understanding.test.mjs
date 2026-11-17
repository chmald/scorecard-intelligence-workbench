import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createAzureAdapters, createAnalyzerDefinition, parseContentUnderstanding, resolveAzureEnvironment } from '../app/azure.mjs';
import { ingest } from '../app/ingestion.mjs';
import { createApp } from '../app/server.mjs';
import { MemoryStateStore } from '../app/store.mjs';
import { configureContentUnderstanding } from '../scripts/configure-content-understanding.mjs';

const config = JSON.parse(await readFile(new URL('../demo-ids.template.json', import.meta.url), 'utf8'));
const env = {
  CONTENT_UNDERSTANDING_ENDPOINT: 'https://documents.example.test',
  CONTENT_UNDERSTANDING_ANALYZER_ID: 'document_metrics',
  CONTENT_UNDERSTANDING_COMPLETION_MODEL: 'operator-completion-model',
  CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT: 'operator-completion-deployment',
  CONTENT_UNDERSTANDING_EMBEDDING_MODEL: 'operator-embedding-model',
  CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT: 'operator-embedding-deployment',
};
const credential = { getToken: async scope => {
  assert.equal(scope, 'https://cognitiveservices.azure.com/.default');
  return { token: 'synthetic-token' };
} };
const location = '/contentunderstanding/analyzerResults/synthetic-operation?api-version=2025-11-01';
const accepted = (url = location) => new Response('', { status: 202, headers: { 'operation-location': url } });

function documentResult({ text, value = 98, label = config.domain.kpis[0].name, unit = '%', geometry = true } = {}) {
  const markdown = text ?? `Example organization\n2026-10\n${label} | 98 | ${unit} | Green`;
  const field = (type, typedValue, printed = String(typedValue)) => ({
    type, [`value${type === 'number' ? 'Number' : 'String'}`]: typedValue,
    spans: [{ offset: markdown.indexOf(printed), length: printed.length }], confidence: 0.96,
    ...(geometry ? { source: 'D(2,1,1,2,1,2,2,1,2)' } : {}),
  });
  return { contents: [{
    kind: 'document', markdown, unit: 'inch',
    fields: {
      Customer: field('string', 'Example organization'), Period: field('string', '2026-10'),
      Metrics: { type: 'array', valueArray: [{ type: 'object', valueObject: {
        Label: field('string', label), Value: field('number', value, value === 97.5 ? '97,5' : '98'),
        Unit: field('string', unit), SourceRating: field('string', 'Green'),
      } }] },
    },
  }] };
}

function extractor(result, assertions = () => {}) {
  return createAzureAdapters({ env, credential, pollInterval: 0, timeoutMs: 1000, fetchImpl: async (url, options) => {
    if (options.method === 'POST') { assertions(new URL(url), options); return accepted(); }
    return Response.json({ status: 'Succeeded', result });
  } });
}

test('CU sends GA base64 inputs, domain analyzer ID, model pointers and UTF-16 grounding offsets', async () => {
  const bytes = Buffer.from('Synthetic document');
  const rows = await extractor(documentResult(), (url, options) => {
    assert.equal(url.pathname, '/contentunderstanding/analyzers/document_metrics:analyze');
    assert.equal(url.searchParams.get('api-version'), '2025-11-01');
    assert.equal(url.searchParams.get('stringEncoding'), 'utf16');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      inputs: [{ name: 'letter.txt', mimeType: 'text/plain', data: bytes.toString('base64') }],
      modelDeployments: { 'operator-completion-model': 'operator-completion-deployment', 'operator-embedding-model': 'operator-embedding-deployment' },
    });
  }).extract(bytes, { name: 'letter.txt', mimeType: 'text/plain' });
  assert.deepEqual(rows[0].cells, [config.domain.kpis[0].name, 98, '%']);
  assert.equal(rows[0].confidence, 0.96);
  assert.equal(rows[0].page, 2);
  assert.equal(rows[0].customerRating, 'Green');
  assert.deepEqual(rows[0].evidence.Value.regions[0], { page: 2, coordinates: [1, 1, 2, 1, 2, 2, 1, 2], unit: 'inch' });
});

test('CU varied prose, decimal commas and Office spans normalize without geometry or business-rule inference', async () => {
  const label = config.domain.kpis[0].name;
  const text = `📄 Example organization\nFor 2026-10, the reported ${label} was 97,5 %; the source rating was Green.`;
  const result = await ingest(Buffer.from(text), 'letter.txt', { customerId: 'example', period: '2026-10' }, config.domain,
    { azureExtract: extractor(documentResult({ text, value: 97.5, geometry: false })).extract });
  assert.equal(result.document.mode, 'azure-content-understanding');
  assert.equal(result.records[0].value, 97.5);
  assert.equal(result.records[0].status, 'watch');
  assert.equal(result.records[0].customerRating, 'Green');
  assert.equal(result.records[0].source.page, undefined);
  assert.equal(result.records[0].source.fields.Value.text, '97,5');
  assert.match(result.records[0].confidenceSignal, /not a correctness guarantee/);
  assert.match(result.records[0].source.text, /97,5/);
});

test('CU missing, mismatched and malformed field evidence never produces an accepted numeric value', async () => {
  const mutations = [
    field => { delete field.valueNumber; },
    field => { delete field.spans; },
    field => { field.spans[0].offset = -1; },
    field => { field.spans[0].length = 100000; },
    field => { field.valueNumber = 999; },
    field => { field.type = 'string'; field.valueString = '98'; },
  ];
  for (const mutate of mutations) {
    const result = documentResult();
    mutate(result.contents[0].fields.Metrics.valueArray[0].valueObject.Value);
    const rows = parseContentUnderstanding(result);
    assert.equal(rows[0].cells[1], '');
    assert.equal(rows[0].confidence, 0);
    assert.match(rows[0].warning, /no numeric value/);
  }
  const uncertain = documentResult();
  delete uncertain.contents[0].fields.Metrics.valueArray[0].valueObject.Value.confidence;
  const rows = parseContentUnderstanding(uncertain);
  assert.equal(rows[0].cells[1], 98);
  assert.equal(rows[0].confidence, 0);
  const mismatched = documentResult();
  mismatched.contents[0].fields = {};
  assert.throws(() => parseContentUnderstanding(mismatched), /schema/);
});

test('CU does not rescale percentages, borrow units, overwrite source ratings or combine duplicate observations', async () => {
  const result = documentResult({ value: 0.98 });
  assert.equal(parseContentUnderstanding(result)[0].cells[1], '');
  const duplicate = documentResult();
  duplicate.contents[0].fields.Metrics.valueArray.push(structuredClone(duplicate.contents[0].fields.Metrics.valueArray[0]));
  assert.equal(parseContentUnderstanding(duplicate).length, 2);
  const missingUnit = documentResult();
  delete missingUnit.contents[0].fields.Metrics.valueArray[0].valueObject.Unit;
  const ingested = await ingest(Buffer.from('Synthetic letter'), 'letter.txt', { customerId: 'example', period: '2026-10' }, config.domain,
    { azureExtract: extractor(missingUnit).extract });
  assert.equal(ingested.records[0].unit, '');
  assert.equal(ingested.records[0].status, 'uncertain');
});

test('native structured uploads stay local and known restricted inputs never reach CU', async () => {
  let called = false;
  const options = { azureExtract: async () => { called = true; throw new Error('Remote extraction must not be called'); } };
  const native = await ingest(Buffer.from(`${config.domain.kpis[0].name},98,%`), 'source.csv', { customerId: 'example', period: '2026-10' }, config.domain, options);
  assert.equal(native.document.mode, 'local-real-extraction');
  assert.equal(native.records[0].value, 98);
  await assert.rejects(ingest(Buffer.from('Confidential notes'), 'letter.txt', {}, config.domain, options), /Restricted/);
  await assert.rejects(ingest(Buffer.from('synthetic'), 'letter.txt', { restricted: true }, config.domain, options), /Restricted/);
  await assert.rejects(ingest(Buffer.from('synthetic'), 'scan.png', {}, config.domain), /requires.*Content Understanding/);
  assert.equal(called, false);
  const wrongPeriod = documentResult();
  wrongPeriod.contents[0].markdown = wrongPeriod.contents[0].markdown.replace('2026-10', '2026-11');
  wrongPeriod.contents[0].fields.Period.valueString = '2026-11';
  await assert.rejects(ingest(Buffer.from('Synthetic letter'), 'letter.txt', { customerId: 'example', period: '2026-10' }, config.domain,
    { azureExtract: extractor(wrongPeriod).extract }), /reporting period differs/);
});

test('CU polling fails closed on unsafe locations, service failure, unexpected states and timeouts', async () => {
  for (const url of [
    'https://attacker.example/contentunderstanding/analyzerResults/x?api-version=2025-11-01',
    '/documentintelligence/result/x?api-version=2025-11-01',
    '/contentunderstanding/defaults?api-version=2025-11-01',
    `${location}#fragment`, location.replace('2025-11-01', '2026-06-01-preview'),
  ]) {
    const adapter = createAzureAdapters({ env, credential, fetchImpl: async () => accepted(url) });
    await assert.rejects(adapter.extract(Buffer.from('synthetic')), /Unsafe/);
  }
  for (const status of ['Failed', 'Canceled', 'Unknown']) {
    const adapter = createAzureAdapters({ env, credential, pollInterval: 0, fetchImpl: async (url, options) => options.method === 'POST' ? accepted() : Response.json({ status }) });
    await assert.rejects(adapter.extract(Buffer.from('synthetic')), /failed|Unknown/);
  }
  const timed = createAzureAdapters({ env, credential, timeoutMs: 10, pollInterval: 1, fetchImpl: async (url, options) => options.method === 'POST' ? accepted() : Response.json({ status: 'Running' }) });
  await assert.rejects(timed.extract(Buffer.from('synthetic')), /timed out/);
});

test('embedded restricted PDF text is rejected locally before custom-analyzer model input', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Confidential source: do not send to the remote analyzer.');
  let called = false;
  await assert.rejects(ingest(Buffer.from(await pdf.save()), 'synthetic-notice.pdf', { customerId: 'example', period: '2026-10' }, config.domain,
    { azureExtract: async () => { called = true; return []; } }), /Restricted/);
  assert.equal(called, false);
});

test('analyzer setup fills only missing model mappings, creates literal grounded fields and verifies persistence', async () => {
  let models = { unrelated: 'preserved' }, analyzer, creates = 0;
  const definition = createAnalyzerDefinition(config.domain, env);
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    assert.equal(url.searchParams.has('allowReplace'), false);
    if (url.pathname.endsWith('/defaults')) {
      if (options.method === 'PATCH') {
        assert.equal(options.headers['Content-Type'], 'application/merge-patch+json');
        models = { ...models, ...JSON.parse(options.body).modelDeployments };
      }
      return Response.json({ modelDeployments: models });
    }
    if (url.pathname.includes('/operations/')) return Response.json({ status: 'succeeded' });
    if (options.method === 'GET') return analyzer ? Response.json(analyzer) : new Response('', { status: 404 });
    assert.equal(options.method, 'PUT');
    analyzer = { ...JSON.parse(options.body), status: 'ready' }; creates++;
    return new Response('', { status: 201, headers: { 'operation-location': '/contentunderstanding/analyzers/document_metrics/operations/new?api-version=2025-11-01' } });
  };
  const adapter = createAzureAdapters({ env, credential, fetchImpl });
  assert.equal((await adapter.configureAnalyzer(config.domain)).status, 'ready');
  await adapter.configureAnalyzer(config.domain);
  assert.equal(creates, 1);
  assert.equal(models.unrelated, 'preserved');
  assert.equal(analyzer.fieldSchema.fields.Metrics.items.properties.Value.method, 'extract');
  assert.equal(analyzer.fieldSchema.fields.Metrics.items.properties.Value.estimateSourceAndConfidence, true);
  assert.ok(JSON.stringify(definition).includes(config.domain.kpis[0].aliases[0]));
  assert.ok(!JSON.stringify(definition).includes('internalBaseline'));
  const different = structuredClone(config.domain);
  different.kpis[0].name = 'Different domain label';
  await assert.rejects(adapter.configureAnalyzer(different), /Select a new analyzer ID/);
  models[env.CONTENT_UNDERSTANDING_COMPLETION_MODEL] = 'different-deployment';
  await assert.rejects(adapter.configureAnalyzer(config.domain), /model mapping differs/);
});

test('CU setup and startup reject incomplete configuration before any token or data-plane call', async () => {
  const incomplete = { ...env, CONTENT_UNDERSTANDING_EMBEDDING_MODEL: '' };
  const unexpected = { getToken: () => { throw new Error('Unexpected token request'); } };
  await assert.rejects(configureContentUnderstanding({ env: incomplete, config, credential: unexpected }), /EMBEDDING_MODEL is required/);
  await assert.rejects(createApp({ config, env: { ...incomplete, EXTRACTION_PROVIDER: 'azure', AUTH_MODE: 'local', HOST: '127.0.0.1' }, store: new MemoryStateStore(), credential: unexpected }), /EMBEDDING_MODEL is required/);
  assert.equal(resolveAzureEnvironment({ CONTENT_UNDERSTANDING_ENDPOINT: env.CONTENT_UNDERSTANDING_ENDPOINT }, { contentUnderstandingEndpoint: 'https://other.example.test' }).CONTENT_UNDERSTANDING_ENDPOINT, env.CONTENT_UNDERSTANDING_ENDPOINT);
});

test('HTTP CU upload retains source confidence and human review while local sessions advertise only local formats', async t => {
  const fetchImpl = async (url, options) => options.method === 'POST' ? accepted() : Response.json({ status: 'Succeeded', result: documentResult() });
  const server = await createApp({ config, env: { ...env, EXTRACTION_PROVIDER: 'azure', AUTH_MODE: 'local', HOST: '127.0.0.1' }, store: new MemoryStateStore(), credential, fetchImpl });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.ok((await session.json()).config.acceptedFileTypes.includes('.png'));
  const uploaded = await fetch(`${base}/api/documents`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'letter.txt', customerId: 'example', period: '2026-10', contentBase64: Buffer.from('Synthetic authorized letter').toString('base64') }) });
  assert.equal(uploaded.status, 201);
  const result = await uploaded.json();
  assert.equal(result.records[0].confirmed, false);
  assert.equal(result.records[0].confidence, 0.96);
  assert.equal(result.document.mode, 'azure-content-understanding');
  const manager = await fetch(`${base}/api/session`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'manager' }) });
  const managerCookie = manager.headers.get('set-cookie').split(';')[0];
  const publication = await fetch(`${base}/api/periods/2026-10/publish`, { method: 'POST', headers: { Cookie: managerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: 'example' }) });
  assert.equal(publication.status, 422);
  assert.equal((await publication.json()).code, 'REVIEW_REQUIRED');
  const local = await createApp({ config, env: { AUTH_MODE: 'local', HOST: '127.0.0.1' }, store: new MemoryStateStore() });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  t.after(() => new Promise(resolve => { local.closeIdleConnections(); local.close(resolve); }));
  const localSession = await (await fetch(`http://127.0.0.1:${local.address().port}/api/session`)).json();
  assert.equal(localSession.config.acceptedFileTypes.includes('.png'), false);
});
