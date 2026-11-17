import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp, start } from '../app/server.mjs';
import { MemoryStateStore, JsonStateStore, CosmosStateStore, ConflictError } from '../app/store.mjs';
import { createAzureAdapters, validateClaims } from '../app/azure.mjs';
import { generateSamples } from '../scripts/generate-samples.mjs';
import { evaluateSamples } from '../app/evaluation.mjs';
import { ingest } from '../app/ingestion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'demo-ids.template.json'), 'utf8'));
const localEnv = { AUTH_MODE: 'local', HOST: '127.0.0.1', PORT: '0' };

async function harness(t, options = {}) {
  const server = await createApp({ config, env: localEnv, store: new MemoryStateStore(), ...options });
  assert.equal(server.listening, false, 'factory must not bind');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(route, method = 'GET', body, headers = {}) {
    const response = await fetch(url + route, {
      method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body: result, headers: response.headers };
  }
  return { request, server, url };
}
const upload = (name, text, customerId = 'test') => ({ name, contentBase64: Buffer.from(text).toString('base64'), customerId, period: config.domain.period });

test('complete correction, confirmation, approval invalidation, immutable publication and draft action lifecycle', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/health')).body.status, 'ok');
  const initial = await request('/api/session');
  assert.equal(initial.body.user.role, 'reviewer');
  assert.equal((await request('/api/periods/2026-10/publish', 'POST', { customerId: 'test', role: 'manager' }, { 'x-role': 'manager' })).status, 403);
  const metric = config.domain.kpis[0];
  const result = await request('/api/documents', 'POST', upload('data.csv', `KPI;Value;Unit\n${metric.name};${metric.target};${metric.unit}\n`));
  assert.equal(result.status, 201);
  assert.equal(result.body.document.contentBase64, undefined);
  let record = result.body.records[0];
  assert.equal(record.status, 'on_target');
  assert.equal((await request(`/api/records/${record.id}`, 'PATCH', { value: 1, expectedVersion: 999 })).status, 409);
  await request(`/api/records/${record.id}/confirm`, 'POST', {});
  await request('/api/session', 'POST', { role: 'manager' });
  assert.equal((await request('/api/periods/2026-10/publish', 'POST', { customerId: 'test' })).status, 409);
  assert.equal((await request('/api/periods/2026-10/approve', 'POST', { customerId: 'test' })).status, 200);
  const corrected = await request(`/api/records/${record.id}`, 'PATCH', { value: metric.target + 1, comment: 'Verified against source.' });
  assert.equal(corrected.body.record.confirmed, false);
  assert.equal(corrected.body.record.rawValue, String(metric.target), 'preserve extracted provenance');
  assert.equal((await request('/api/periods/2026-10/publish', 'POST', { customerId: 'test' })).status, 422);
  await request(`/api/records/${record.id}/confirm`, 'POST', {});
  assert.equal((await request('/api/periods/2026-10/publish', 'POST', { customerId: 'test' })).status, 409);
  await request('/api/periods/2026-10/approve', 'POST', { customerId: 'test' });
  const published = await request('/api/periods/2026-10/publish', 'POST', { customerId: 'test' });
  assert.equal(published.status, 200);
  assert.equal(published.body.published[0].immutable, true);
  assert.deepEqual(published.body.published[0].rules, config.domain.kpis);
  assert.equal((await request(`/api/records/${record.id}`, 'PATCH', { value: 4 })).status, 409);
  assert.equal((await request(`/api/records/${record.id}/confirm`, 'POST', {})).status, 409);
  assert.equal((await request('/api/documents', 'POST', upload('late.txt', `${metric.name} | 5 | ${metric.unit}`))).status, 409);
  const action = await request('/api/actions', 'POST', { recordId: record.id, text: 'Validate the evidenced variance.', status: 'approved', owner: 'invented' });
  assert.equal(action.body.action.status, 'draft');
  assert.equal(action.body.action.assignment, null);
  assert.equal((await request(`/api/actions/${action.body.action.id}/approve`, 'POST', {})).body.action.status, 'approved');
  const source = await request(`/api/documents/${result.body.document.id}/source`);
  assert.equal(source.status, 200);
  assert.match(source.body, /KPI/);
  assert.match(source.headers.get('content-disposition'), /attachment/);
});

test('auditor cannot mutate; role and audit headers/body are not authority; origin writes denied', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/api/session', 'GET', undefined, { 'x-role': 'manager', 'x-audit-view': 'true' })).body.user.role, 'reviewer');
  await request('/api/session', 'POST', { role: 'auditor' });
  assert.equal((await request('/api/session')).body.user.auditView, true);
  assert.equal((await request('/api/documents', 'POST', upload('a.txt', 'x | 1'))).status, 403);
  assert.equal((await request('/api/samples/load', 'POST', {})).status, 403);
  assert.equal((await request('/api/reset', 'POST', {}, { 'x-role': 'manager' })).status, 403);
  assert.equal((await request('/api/session', 'POST', { role: 'manager' }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/api/session', 'POST', { role: 'root' })).status, 400);
});

test('missing, unknown and no-data do not invent values or allow approval', async t => {
  const { request } = await harness(t);
  let answer = await request('/api/questions', 'POST', { question: 'Show performance' });
  assert.equal(answer.body.claims.length, 0);
  assert.match(answer.body.answer, /no supported answer/i);
  const metric = config.domain.kpis[0];
  const result = await request('/api/documents', 'POST', upload('missing.csv', `KPI;Value;Unit\n${metric.name};;${metric.unit}\nAlien indicator;5;widgets\n`));
  assert.deepEqual(result.body.records.map(record => record.status), ['missing', 'unknown']);
  assert.equal(result.body.records[0].value, null);
  for (const record of result.body.records) assert.equal((await request(`/api/records/${record.id}/confirm`, 'POST', {})).status, 422);
  await request('/api/session', 'POST', { role: 'manager' });
  assert.equal((await request('/api/periods/2026-10/approve', 'POST', { customerId: 'test' })).status, 422);
  assert.equal((await request('/api/periods/2026-10/approve', 'POST', { customerId: 'empty' })).status, 422);
  answer = await request('/api/questions', 'POST', { question: 'Show missing data' });
  assert.match(answer.body.answer, /not reported/);
  assert.ok(answer.body.citations.every(citation => citation.row));
  assert.equal((await request('/api/questions', 'POST', { question: 'Write a poem' })).body.claims.length, 0);
});

test('restricted mixed documents rejected before persistence; legacy restrictions excluded from state, totals, source, answer and audit', async t => {
  const store = new MemoryStateStore();
  const { request } = await harness(t, { store });
  const metric = config.domain.kpis[0];
  const restricted = await request('/api/documents', 'POST', upload('mixed.txt', `${metric.name} | 98 | %\nrestricted secret-name | 999 | %`));
  assert.equal(restricted.status, 403);
  assert.equal((await store.read()).state.documents.length, 0);
  const safe = await request('/api/documents', 'POST', upload('public.txt', `${metric.name} | 98 | %`));
  const snapshot = await store.read();
  const secretDoc = { id: 'secret-doc', customerId: 'test', name: 'SENSITIVE-NAME.pdf', restricted: true, contentBase64: Buffer.from('SECRET-TEXT').toString('base64') };
  snapshot.state.documents.push(secretDoc);
  snapshot.state.records.push({ ...safe.body.records[0], id: 'secret-row', documentId: 'secret-doc', restricted: true, value: 876543, source: { text: 'SECRET-TEXT' } });
  snapshot.state.actions.push({ id: 'hidden-action', recordId: safe.body.records[0].id, text: 'SECRET-TEXT', restricted: true });
  snapshot.state.auditLog.push({ id: 'secret-event', entityId: 'secret-doc', text: 'SECRET-TEXT' });
  await store.write(snapshot.state, snapshot.etag);
  await request('/api/session', 'POST', { role: 'auditor' });
  const state = await request('/api/state');
  assert.equal(state.body.summary.total, 1);
  assert.equal(state.body.hiddenItems, true);
  assert.doesNotMatch(JSON.stringify(state.body), /SENSITIVE-NAME|SECRET-TEXT|876543/);
  const answer = await request('/api/questions', 'POST', { question: 'Show metric evidence' });
  assert.doesNotMatch(JSON.stringify(answer.body), /SECRET-TEXT|876543|secret-doc/);
  assert.equal((await request('/api/documents/secret-doc/source')).status, 404);
});

test('strict errors and fail-closed cloud/local binding', async t => {
  const { request, url } = await harness(t);
  assert.equal((await request('/api/documents', 'POST', upload('../escape.txt', 'x'))).status, 400);
  assert.equal((await request('/api/documents', 'POST', upload('script.exe', 'x'))).status, 415);
  assert.equal((await request('/api/documents', 'POST', { name: 'x.txt', contentBase64: 'not base64!' })).status, 400);
  assert.equal((await request('/api/documents', 'POST', upload('empty.txt', ''))).status, 422);
  assert.equal((await request('/api/documents', 'POST', upload('bad.json', '{'))).status, 400);
  assert.equal((await request('/api/records/nope', 'PATCH', { value: 3 })).status, 404);
  const malformed = await fetch(url + '/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  await assert.rejects(createApp({ config, env: { NODE_ENV: 'production', AUTH_MODE: 'local' }, store: new MemoryStateStore() }), /disabled/);
  await assert.rejects(createApp({ config, env: { AUTH_MODE: 'entra' }, store: new MemoryStateStore() }), /issuer, audience and tenant/);
  await assert.rejects(start({ config, env: { ...localEnv, HOST: '0.0.0.0' }, store: new MemoryStateStore() }), /loopback/);
});

test('atomic JSON survives a new store/app and rejects stale revisions', async t => {
  const directory = path.join(root, 'tests', '.state', randomUUID());
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'state.json');
  const first = new JsonStateStore(filename);
  const { request } = await harness(t, { store: first });
  const metric = config.domain.kpis[0];
  assert.equal((await request('/api/documents', 'POST', upload('persist.txt', `${metric.name} | 97,4 | ${metric.unit}`))).status, 201);
  const second = new JsonStateStore(filename);
  const after = await second.read();
  assert.equal(after.state.records[0].value, 97.4);
  assert.equal(await second.write(after.state, after.etag), 2, 'atomic replacement overwrites an existing state file');
  const restarted = await harness(t, { store: second });
  assert.equal((await restarted.request('/api/state')).body.records.length, 1);
  await assert.rejects(second.write(after.state, 0), ConflictError);
});

test('Cosmos ETags use conditional replace and translate conflicts', async () => {
  let last;
  const container = {
    item: (id, partition) => {
      assert.equal(id, 'workbench'); assert.equal(partition, 'workbench');
      return {
        read: async () => ({ resource: { _etag: 'etag-a', state: { marker: true } } }),
        replace: async (document, options) => { last = { document, options }; return { resource: { _etag: 'etag-b' } }; },
      };
    },
  };
  const store = new CosmosStateStore(container);
  assert.equal((await store.read()).etag, 'etag-a');
  assert.equal(await store.write({ marker: true }, 'etag-a'), 'etag-b');
  assert.equal(last.options.accessCondition.condition, 'etag-a');
  container.item = () => ({ replace: async () => { throw { code: 412 }; } });
  await assert.rejects(store.write({}, 'stale'), ConflictError);
});

test('live mode receives only filtered evidence, refuses ungrounded output and never silently falls back', async t => {
  const store = new MemoryStateStore();
  const captured = [];
  const { request } = await harness(t, {
    store,
    env: { ...localEnv, ANSWER_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: 'https://model.example.test', AZURE_OPENAI_DEPLOYMENT: 'operator-supplied' },
    credential: { getToken: async () => ({ token: 'test-only' }) },
    fetchImpl: async (url, options) => {
      captured.push(JSON.parse(options.body));
      return Response.json({ output_text: '{"claims":[{"text":"Unsupported invented value 999999","evidenceIds":["nonexistent"]}]}' });
    },
  });
  let answer = await request('/api/questions', 'POST', { question: 'Show performance' });
  assert.equal(captured.length, 0, 'no evidence means no model request');
  assert.equal(answer.body.mode, 'azure-responses');
  assert.match(answer.body.answer, /No local answer was substituted/);
  const metric = config.domain.kpis[0];
  await request('/api/documents', 'POST', upload('safe.txt', `${metric.name} | ${metric.target} | ${metric.unit}`));
  const snapshot = await store.read();
  snapshot.state.documents.push({ id: 'hidden', customerId: 'test', name: 'SECRET-NAME', restricted: true });
  snapshot.state.records.push({ id: 'hidden-row', documentId: 'hidden', customerId: 'test', value: 7654321, source: { text: 'SECRET-TEXT' } });
  await store.write(snapshot.state, snapshot.etag);
  answer = await request('/api/questions', 'POST', { question: 'Show performance' });
  assert.equal(captured.length, 1);
  assert.doesNotMatch(JSON.stringify(captured), /SECRET-NAME|SECRET-TEXT|7654321/);
  assert.equal(answer.body.claims.length, 0);
  assert.equal(answer.body.citations.length, 0);
  assert.equal(answer.body.hiddenItems, true);
  assert.match(answer.body.answer, /cannot provide a supported answer/);
});

test('source rating is independent, baseline gaps are explicit and a domain-only replacement works over HTTP', async t => {
  const replacement = structuredClone(config);
  replacement.cosmosEndpoint = 'https://must-not-contact.example.test';
  replacement.domain = {
    title: 'Water quality evidence', entityLabel: 'Laboratory', period: '2026-11', rulesVersion: 'water-synthetic-v1', confidenceThreshold: 0.9,
    kpis: [{ id: 'clarity', name: 'Water clarity', aliases: ['Clarte'], unit: 'NTU', direction: 'lower', target: 1, watch: 2, warning: 3, internalBaseline: { value: 1.5, synthetic: true, provenance: 'Synthetic laboratory baseline' } }],
  };
  const { request } = await harness(t, { config: replacement, env: { ...localEnv, STATE_PROVIDER: 'local' } });
  const result = await request('/api/documents', 'POST', { name: 'water.csv', customerId: 'lab', period: '2026-11', contentBase64: Buffer.from('Customer;Period;KPI;Value;Unit;Customer rating\nLaboratory;2026-11;Clarte;4,5;NTU;Source accepted\n').toString('base64') });
  assert.equal(result.status, 201);
  const record = result.body.records[0];
  assert.equal(record.value, 4.5);
  assert.equal(record.status, 'critical');
  assert.equal(record.customerRating, 'Source accepted');
  assert.equal(record.sourceRating, 'Source accepted');
  assert.equal(record.baselineComparison.gap, 3);
  assert.equal(record.baselineComparison.synthetic, true);
  await request(`/api/records/${record.id}`, 'PATCH', { value: 1 });
  const confirmed = await request(`/api/records/${record.id}/confirm`, 'POST', {});
  assert.equal(confirmed.body.record.customerRating, 'Source accepted');
  assert.equal(confirmed.body.record.status, 'on_target');
  assert.equal(confirmed.body.record.baselineComparison.gap, -0.5);
  const answer = await request('/api/questions', 'POST', { question: 'Show Water clarity' });
  assert.match(answer.body.answer, /internal baseline 1.5/);
  assert.match(answer.body.answer, /Source\/customer rating: Source accepted/);
  const state = await request('/api/state');
  assert.equal(state.body.summary.score, undefined);
  assert.equal((await request('/api/session')).body.config.rulesVersion, 'water-synthetic-v1');
});

test('bounded Cosmos state rejects oversized source atomically with a meaningful 413', async t => {
  const store = new MemoryStateStore();
  const { request } = await harness(t, {
    store, env: { ...localEnv, COSMOS_ENDPOINT: 'https://never-contact.example.test', STATE_PROVIDER: 'cosmos' },
    credential: { getToken: async () => ({ token: 'test-only' }) },
  });
  const metric = config.domain.kpis[0];
  assert.equal((await request('/api/documents', 'POST', upload('small.txt', `${metric.name} | ${metric.target} | ${metric.unit}`))).status, 201);
  const before = await store.read();
  const large = await request('/api/documents', 'POST', upload('large.txt', `${metric.name} | ${metric.target} | ${metric.unit}\n${'x'.repeat(1_400_000)}`));
  assert.equal(large.status, 413);
  assert.match(large.body.error, /bounded|capacity/i);
  assert.deepEqual(await store.read(), before, 'failed capacity check must not partially persist state or audit');
});

test('Entra verifies signed access tokens from bearer/platform transport and rejects role forging, ID tokens and wrong claims', async t => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-test-key', alg: 'RS256', use: 'sig' };
  const tenant = '11111111-1111-4111-8111-111111111111';
  const api = '22222222-2222-4222-8222-222222222222';
  const env = {
    AUTH_MODE: 'entra', AZURE_TENANT_ID: tenant, ENTRA_ISSUER: `https://login.microsoftonline.com/${tenant}/v2.0`, ENTRA_AUDIENCE: api,
    ENTRA_CLIENT_ID: '33333333-3333-4333-8333-333333333333', ENTRA_API_SCOPE: `api://${api}/access_as_user`,
    ENTRA_JWKS_URI: 'https://keys.example.test/keys',
  };
  const { request } = await harness(t, { env, authFetchImpl: async () => Response.json({ keys: [jwk] }) });
  const token = (overrides = {}, issuer = env.ENTRA_ISSUER, audience = api) => new SignJWT({
    tid: tenant, ver: '2.0', scp: 'access_as_user', roles: ['reviewer'], oid: 'test-subject', name: 'Synthetic signed user', ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal((await request('/api/session', 'GET', undefined, { 'x-ms-client-principal': '{"roles":["manager"]}', 'x-role': 'manager' })).status, 401);
  const publicConfig = await request('/api/auth/config');
  assert.equal(publicConfig.status, 200);
  assert.deepEqual(publicConfig.body, { authMode: 'entra', tenantId: tenant, clientId: env.ENTRA_CLIENT_ID, scope: env.ENTRA_API_SCOPE, redirectPath: '/auth/callback' });
  assert.match(publicConfig.headers.get('content-security-policy'), /connect-src 'self' https:\/\/login.microsoftonline.com/);
  const reviewer = await token();
  let session = await request('/api/session', 'GET', undefined, { Authorization: `Bearer ${reviewer}`, 'x-role': 'manager', 'x-audit-view': 'true' });
  assert.equal(session.body.user.role, 'reviewer'); assert.equal(session.body.user.auditView, false);
  assert.deepEqual(session.body.roles, []);
  session = await request('/api/session', 'GET', undefined, { 'x-ms-token-aad-access-token': await token({ roles: ['auditor'] }), 'x-role': 'manager' });
  assert.equal(session.body.user.role, 'auditor'); assert.equal(session.body.user.auditView, true);
  assert.equal((await request('/api/session', 'POST', { role: 'manager' }, { Authorization: `Bearer ${reviewer}` })).status, 403);
  assert.equal((await request('/api/session', 'GET', undefined, { Authorization: `Bearer ${await token({}, env.ENTRA_ISSUER, 'wrong-api')}` })).status, 401);
  assert.equal((await request('/api/session', 'GET', undefined, { Authorization: `Bearer ${await token({ tid: 'wrong-tenant' })}` })).status, 401);
  assert.equal((await request('/api/session', 'GET', undefined, { Authorization: `Bearer ${await token({ scp: undefined })}` })).status, 401, 'ID token without API delegated scope is rejected');
  assert.equal((await request('/api/session', 'GET', undefined, { Authorization: `Bearer ${await token({ roles: ['unassigned'] })}` })).status, 401);
  assert.equal((await request('/api/session', 'GET', undefined, { Authorization: `Bearer ${await token({}, 'https://other.example.test/issuer')}` })).status, 401);
  assert.equal((await request('/auth/callback')).status, 200);
});

test('annual monthly sum abstains on gaps, respects year boundaries, invalidates dependent approval and freezes published evidence', async t => {
  const annualConfig = structuredClone(config);
  annualConfig.domain = {
    title: 'Annual evidence test', period: '2026-02', kpis: [
      { id: 'incidents', name: 'Reported incidents', aliases: ['Incidents'], unit: 'items', direction: 'annual_cumulative', annualLimit: 4, accumulation: 'monthly_sum' },
    ],
  };
  const { request } = await harness(t, { config: annualConfig });
  const annualUpload = (period, value) => ({ name: `${period}.json`, customerId: 'lab', period, contentBase64: Buffer.from(JSON.stringify([{ kpi: 'Incidents', value, unit: 'items', customerRating: 'Source accepted' }])).toString('base64') });
  let result = await request('/api/documents', 'POST', annualUpload('2026-02', 3));
  const februaryId = result.body.records[0].id;
  assert.equal(result.body.records[0].assessment.annualTotal, null);
  assert.equal(result.body.records[0].status, 'missing');
  await request(`/api/records/${februaryId}/confirm`, 'POST', {});
  await request('/api/session', 'POST', { role: 'manager' });
  assert.equal((await request('/api/periods/2026-02/approve', 'POST', { customerId: 'lab' })).status, 422);
  result = await request('/api/documents', 'POST', annualUpload('2026-01', 2));
  const januaryId = result.body.records[0].id;
  await request(`/api/records/${januaryId}/confirm`, 'POST', {});
  let state = (await request('/api/state')).body;
  let february = state.records.find(record => record.id === februaryId);
  assert.equal(february.assessment.annualTotal, 5);
  assert.equal(february.status, 'critical');
  assert.equal(february.customerRating, 'Source accepted');
  assert.equal((await request('/api/periods/2026-02/approve', 'POST', { customerId: 'lab' })).status, 200);
  await request(`/api/records/${januaryId}`, 'PATCH', { value: 1 });
  await request(`/api/records/${januaryId}/confirm`, 'POST', {});
  state = (await request('/api/state')).body;
  assert.equal(state.approvals['lab:2026-02'], undefined);
  february = state.records.find(record => record.id === februaryId);
  assert.equal(february.assessment.annualTotal, 4);
  assert.equal(february.status, 'on_target');
  assert.equal((await request('/api/periods/2026-02/publish', 'POST', { customerId: 'lab' })).status, 409);
  await request('/api/periods/2026-02/approve', 'POST', { customerId: 'lab' });
  const published = await request('/api/periods/2026-02/publish', 'POST', { customerId: 'lab' });
  assert.equal(published.status, 200);
  assert.equal(published.body.published[0].evidence.length, 2);
  assert.equal((await request(`/api/records/${januaryId}`, 'PATCH', { value: 99 })).status, 409);
  const nextYear = await request('/api/documents', 'POST', annualUpload('2027-02', 3));
  assert.equal(nextYear.body.records[0].assessment.annualTotal, null);
  assert.equal(nextYear.body.records[0].status, 'missing');
  const answer = await request('/api/questions', 'POST', { question: 'Show incidents' });
  const annualClaim = answer.body.claims.find(claim => claim.evidenceIds.includes(februaryId) && claim.evidenceIds.includes(januaryId));
  assert.ok(annualClaim);
  assert.ok(answer.body.citations.some(citation => citation.id === januaryId));
});

test('source-reported YTD is compared only to its explicit annual limit; absent configuration fails closed', async t => {
  const annualConfig = structuredClone(config);
  annualConfig.domain = {
    title: 'Source YTD', period: '2026-10', kpis: [{ id: 'events', name: 'Year events', aliases: [], unit: 'items', direction: 'annual_cumulative', annualLimit: 10, accumulation: 'reported_ytd' }],
  };
  const { request } = await harness(t, { config: annualConfig });
  const result = await request('/api/documents', 'POST', upload('year.txt', 'Year events | 7 | items'));
  assert.equal(result.body.records[0].assessment.annualTotal, 7);
  assert.equal(result.body.records[0].status, 'on_target');
  assert.equal(result.body.records[0].baselineComparison.available, false);
  assert.equal(result.body.records[0].baselineComparison.gap, null);
  delete annualConfig.domain.kpis[0].annualLimit;
  await assert.rejects(createApp({ config: annualConfig, env: localEnv, store: new MemoryStateStore() }), /explicit limit/);
});

test('sample generation performs real five-format extraction, aliases, uncertainty and retargeting', async t => {
  const directory = path.join(root, 'tests', '.state', randomUUID());
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await generateSamples({ directory, config });
  const evaluation = await evaluateSamples(directory, config.domain);
  assert.equal(evaluation.summary.passed, evaluation.summary.total, JSON.stringify(evaluation.results.filter(result => !result.passed)));
  assert.ok(evaluation.summary.total > 15);
  const multilingual = await ingest(await readFile(path.join(directory, 'synthetic-decimal.txt')), 'synthetic-decimal.txt', { customerId: 'alpine', period: config.domain.period }, config.domain);
  assert.equal(multilingual.records[0].value, config.domain.kpis[0].target - 0.6);
  const spreadsheet = await ingest(await readFile(path.join(directory, 'synthetic-alpine.xlsx')), 'synthetic-alpine.xlsx', { customerId: 'alpine', period: config.domain.period }, config.domain);
  assert.ok(spreadsheet.records.some(record => record.status === 'missing'));
  assert.ok(spreadsheet.records.some(record => record.status === 'uncertain'));
  assert.ok(spreadsheet.records.every(record => record.source.cell));
  const different = { title: 'Water quality evidence', period: '2026-11', confidenceThreshold: 0.9, kpis: [{ id: 'clarity', name: 'Water clarity', aliases: ['Clarte'], unit: 'NTU', direction: 'lower', target: 1, watch: 2, warning: 3 }] };
  const retargeted = await ingest(Buffer.from('Clarte | 2,5 | NTU'), 'water.txt', { customerId: 'lab', period: different.period }, different);
  assert.equal(retargeted.records[0].kpiId, 'clarity');
  assert.equal(retargeted.records[0].status, 'warning');
  const differentDirectory = path.join(directory, 'retargeted');
  await generateSamples({ directory: differentDirectory, config: { domain: different } });
  const retargetedEvaluation = await evaluateSamples(differentDirectory, different);
  assert.equal(retargetedEvaluation.summary.passed, retargetedEvaluation.summary.total);
});

test('Azure Responses uses grounded evidence and rejects unsupported claims', async () => {
  const calls = [];
  const credential = { getToken: async scope => { calls.push({ scope }); return { token: 'test-only' }; } };
  const env = { AZURE_OPENAI_ENDPOINT: 'https://model.example.test', AZURE_OPENAI_DEPLOYMENT: 'operator-supplied' };
  const evidence = [{ id: 'r1', kpiName: 'Metric', value: 98, source: { text: 'Metric 98' } }];
  assert.deepEqual(validateClaims([{ text: 'Metric 999', evidenceIds: ['r1'] }], evidence), []);
  assert.deepEqual(validateClaims([{ text: 'Metric 98', evidenceIds: ['fake'] }], evidence), []);
  assert.deepEqual(validateClaims([{ text: 'Metric predicts bankruptcy', evidenceIds: ['r1'] }], evidence), []);
  const model = createAzureAdapters({ env, credential, fetchImpl: async (url, options) => {
    assert.match(String(url), /\/openai\/v1\/responses$/);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'operator-supplied'); assert.equal(payload.store, false);
    assert.equal(payload.text.format.type, 'json_schema'); assert.equal(payload.text.format.strict, true);
    assert.deepEqual(JSON.parse(payload.input).evidence, evidence);
    return Response.json({ output: [{ content: [{ type: 'output_text', text: '{"claims":[{"text":"Metric 98","evidenceIds":["r1"]}]}' }] }] });
  } });
  assert.equal((await model.answer('Metric?', evidence)).claims.length, 1);
  assert.ok(calls.some(call => call.scope === 'https://ai.azure.com/.default'));
});
