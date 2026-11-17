import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createAuth, isAzure, isLoopback, roles } from './auth.mjs';
import { createCredential, createAzureAdapters, resolveAzureEnvironment, validateContentUnderstanding } from './azure.mjs';
import { JsonStateStore, CosmosStateStore, emptyState } from './store.mjs';
import { ingest, InputError, localFileTypes, sourceMimeType } from './ingestion.mjs';
import { assessRecords, classify, summarize, normalize, statusLabels } from './rules.mjs';
import { evaluateSamples } from './evaluation.mjs';
import { generateSamples } from '../scripts/generate-samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'app', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const safeDocument = ({ contentBase64, ...document }) => document;
const periodValid = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const scopeKey = (customerId, period) => `${customerId}:${period}`;
const signature = (records, allRecords = records) => createHash('sha256').update(JSON.stringify(records.map(({ id, version, confirmed, assessment }) => ({
  id, version, confirmed, assessment,
  dependencies: (assessment?.evidenceIds ?? []).map(dependencyId => {
    const dependency = allRecords.find(record => record.id === dependencyId);
    return dependency ? { id: dependency.id, version: dependency.version, confirmed: dependency.confirmed } : null;
  }),
})))).digest('hex');

async function loadConfig() {
  for (const name of ['demo-ids.local.json', 'demo-ids.template.json']) {
    try { return JSON.parse(await readFile(path.join(root, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Workbench domain configuration is required.');
}

function validateDomain(domain) {
  if (!domain || typeof domain.title !== 'string' || !periodValid(domain.period) || !Array.isArray(domain.kpis) || !domain.kpis.length) throw new Error('Invalid domain configuration.');
  const ids = new Set();
  for (const kpi of domain.kpis) {
    if (!kpi.id || ids.has(kpi.id) || !kpi.name || !['higher', 'lower', 'annual_cumulative'].includes(kpi.direction)) throw new Error('Invalid or duplicate KPI rule.');
    if (kpi.direction === 'annual_cumulative' || kpi.ruleType === 'annual_cumulative') {
      if (!Number.isFinite(kpi.annualLimit) || !['reported_ytd', 'monthly_sum'].includes(kpi.accumulation)) throw new Error('Annual rules require an explicit limit and accumulation basis.');
    } else {
      if (![kpi.target, kpi.watch, kpi.warning].every(Number.isFinite)) throw new Error('Configured KPI thresholds are required.');
      if (kpi.direction === 'higher' ? !(kpi.target >= kpi.watch && kpi.watch >= kpi.warning) : !(kpi.target <= kpi.watch && kpi.watch <= kpi.warning)) throw new Error('KPI thresholds must be ordered.');
    }
    ids.add(kpi.id);
  }
}

function authorizedState(state) {
  const blockedDocuments = new Set(state.documents.filter(document => document.restricted).map(document => document.id));
  for (const record of state.records) if (record.restricted) blockedDocuments.add(record.documentId);
  const customers = state.customers.filter(customer => !customer.restricted);
  const customerIds = new Set(customers.map(customer => customer.id));
  const documents = state.documents.filter(document => !blockedDocuments.has(document.id) && customerIds.has(document.customerId));
  const documentIds = new Set(documents.map(document => document.id));
  const records = state.records.filter(record => !record.restricted && documentIds.has(record.documentId) && customerIds.has(record.customerId));
  const recordIds = new Set(records.map(record => record.id));
  const actions = state.actions.filter(action => !action.restricted && recordIds.has(action.recordId));
  const published = state.published.filter(snapshot => !snapshot.restricted && customerIds.has(snapshot.customerId) && snapshot.records.every(record => recordIds.has(record.id)));
  const momentum = state.momentum.filter(item => !item.restricted && customerIds.has(item.customerId));
  const trends = (state.trends ?? []).filter(item => !item.restricted && customerIds.has(item.customerId));
  const escalations = (state.escalations ?? []).filter(item => !item.restricted && customerIds.has(item.customerId));
  return { customers, documents, records, actions, published, momentum, trends, escalations, hiddenItems: Boolean(state.hiddenItems || records.length !== state.records.length || actions.length !== state.actions.length || documents.length !== state.documents.length) };
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new InputError('Content-Type must be application/json.', 415);
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 15 * 1024 * 1024) throw new InputError('Request exceeds size limit.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new InputError('Malformed JSON.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new InputError('JSON object required.');
  return body;
}

function requireRole(user, allowed) {
  if (!allowed.includes(user.role)) throw new InputError('Your role cannot perform this operation.', 403, 'FORBIDDEN');
}
function requireEditable(state, customerId, period) {
  if (state.published.some(snapshot => snapshot.customerId === customerId && snapshot.period === period)) throw new InputError('Published snapshots are immutable. Use a new period.', 409, 'PUBLISHED');
  if (state.published.some(snapshot => snapshot.customerId === customerId && snapshot.period.slice(0, 4) === period.slice(0, 4) && snapshot.period > period && snapshot.records.some(record => record.assessment?.ruleType === 'annual_cumulative' && record.assessment?.accumulation === 'monthly_sum'))) throw new InputError('Published annual evidence depends on this period; historical inputs are immutable.', 409, 'PUBLISHED_DEPENDENCY');
}
function findRecord(state, id) {
  const visible = authorizedState(state).records.find(record => record.id === id);
  if (!visible) throw new InputError('Record not found.', 404);
  return state.records.find(record => record.id === id);
}
function checkVersion(record, value) {
  if (value !== undefined && (!Number.isInteger(value) || value !== record.version)) throw new InputError('Record changed; refresh and retry.', 409, 'VERSION_CONFLICT');
}
function invalidate(state, record) {
  delete state.approvals[scopeKey(record.customerId, record.period)];
  for (const candidate of state.records) {
    if (candidate.customerId === record.customerId && candidate.kpiId === record.kpiId && candidate.period.slice(0, 4) === record.period.slice(0, 4) && candidate.period >= record.period && candidate.assessment?.accumulation === 'monthly_sum') delete state.approvals[scopeKey(candidate.customerId, candidate.period)];
  }
}
function audit(state, user, event, entityId) {
  state.auditLog.push({ id: randomUUID(), at: new Date().toISOString(), actorId: user.id, role: user.role, event, entityId });
  if (state.auditLog.length > 1000) state.auditLog.shift();
}

export async function createApp(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? await loadConfig();
  const domain = config.domain ?? config;
  validateDomain(domain);
  const auth = await createAuth(env, { fetchImpl: options.authFetchImpl });
  const extraction = env.EXTRACTION_PROVIDER || 'local';
  const answer = env.ANSWER_PROVIDER || 'local';
  if (![extraction, answer].every(provider => ['local', 'azure'].includes(provider))) throw new Error('Unknown provider.');
  const azureEnvironment = resolveAzureEnvironment(env, config);
  if (extraction === 'azure') validateContentUnderstanding(azureEnvironment);
  let credential = options.credential;
  if (env.STATE_PROVIDER && !['local', 'cosmos'].includes(env.STATE_PROVIDER)) throw new Error('Unknown STATE_PROVIDER.');
  if (env.STATE_PROVIDER === 'local' && isAzure(env)) throw new Error('Local JSON state is disabled in Azure.');
  const cosmosEndpoint = env.STATE_PROVIDER === 'local' ? '' : env.COSMOS_ENDPOINT || config.cosmosEndpoint;
  if (env.STATE_PROVIDER === 'cosmos' && !cosmosEndpoint) throw new Error('Cosmos endpoint is required.');
  if (isAzure(env) && !cosmosEndpoint && !options.store) throw new Error('Azure requires configured Cosmos state.');
  if ((extraction === 'azure' || answer === 'azure' || cosmosEndpoint) && !credential) credential = await createCredential(env);
  let store = options.store;
  if (!store && cosmosEndpoint) {
    const { CosmosClient } = await import('@azure/cosmos');
    const client = new CosmosClient({ endpoint: cosmosEndpoint, aadCredentials: credential });
    store = new CosmosStateStore(client.database(env.COSMOS_DATABASE || 'workbench').container(env.COSMOS_CONTAINER || 'state'));
  }
  store ??= new JsonStateStore(path.resolve(root, env.STATE_FILE || path.join('data', 'state.json')));
  const azure = createAzureAdapters({
    env: azureEnvironment,
    credential, fetchImpl: options.fetchImpl,
  });
  const provider = { extraction: extraction === 'azure' ? 'azure-content-understanding' : 'local-real-extraction', answer: answer === 'azure' ? 'azure-responses' : 'local-deterministic' };
  const sampleDirectory = options.sampleDirectory ?? path.join(root, 'samples');
  const publicConfig = { title: domain.title, entityLabel: domain.entityLabel, period: domain.period, kpis: domain.kpis, acceptedFileTypes: (domain.acceptedFileTypes ?? localFileTypes).filter(type => extraction === 'azure' || localFileTypes.includes(type)), rulesVersion: domain.rulesVersion || 'unversioned', statusLabels };
  const session = user => ({
    user, authMode: auth.mode, provider, roles: auth.mode === 'local' ? roles : [],
    config: publicConfig,
    capabilities: { canReview: user.role !== 'auditor', canApprove: user.role === 'manager', canPublish: user.role === 'manager', canReset: user.role === 'manager' && auth.mode === 'local', liveExtraction: extraction === 'azure', liveAnswers: answer === 'azure' },
  });
  function stateView(state, user) {
    const visible = authorizedState(state);
    const ids = new Set([...visible.records, ...visible.documents, ...visible.actions, ...visible.published].map(item => item.id));
    return {
      ...visible, documents: visible.documents.map(safeDocument), kpis: domain.kpis,
      auditLog: user.auditView ? state.auditLog.filter(event => !event.restricted && (ids.has(event.entityId) || event.event === 'samples.loaded' || (event.event === 'period.approved' && visible.customers.some(customer => event.entityId?.startsWith(`${customer.id}:`))))).map(({ id, at, actorId, role, event, entityId }) => ({ id, at, actorId, role, event, entityId })) : [],
      summary: summarize(visible.records), provider,
      approvals: Object.fromEntries(Object.entries(state.approvals || {}).filter(([key]) => visible.customers.some(customer => key.startsWith(`${customer.id}:`)))),
    };
  }
  async function save(state, etag) {
    assessRecords(authorizedState(state).records, domain);
    if (cosmosEndpoint && Buffer.byteLength(JSON.stringify(state)) > 1800000) throw new InputError('Bounded workbench state capacity reached; use smaller sources.', 413);
    await store.write(state, etag);
  }
  async function addDocument(state, bytes, name, metadata, local = false) {
    requireEditable(state, metadata.customerId, metadata.period);
    const result = await ingest(bytes, name, metadata, domain, !local && extraction === 'azure' ? { azureExtract: azure.extract } : {});
    state.documents.push(result.document);
    state.records.push(...result.records);
    for (const record of result.records) invalidate(state, record);
    delete state.approvals[scopeKey(metadata.customerId, metadata.period)];
    return result;
  }
  const server = http.createServer(async (req, res) => {
    function json(status, data) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${auth.mode === 'entra' ? ' https://login.microsoftonline.com' : ''}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`);
      const url = new URL(req.url, 'http://localhost');
      const route = decodeURIComponent(url.pathname);
      if (route === '/health' && req.method === 'GET') return json(200, { status: 'ok' });
      if (auth.mode === 'local') {
        const host = new URL(`http://${req.headers.host || 'localhost'}`).hostname.replace(/^\[|\]$/g, '');
        if (!isLoopback(host)) throw new InputError('Local authentication requires a loopback host.', 403);
      }
      if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new InputError('Cross-origin writes denied.', 403);
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('Cross-site writes denied.', 403);
      }
      if (route === '/api/auth/config' && req.method === 'GET') return json(200, {
        authMode: auth.mode, tenantId: auth.mode === 'entra' ? env.AZURE_TENANT_ID : '',
        clientId: auth.mode === 'entra' ? env.ENTRA_CLIENT_ID || '' : '',
        scope: auth.mode === 'entra' ? env.ENTRA_API_SCOPE || '' : '',
        redirectPath: '/auth/callback',
      });
      if (!route.startsWith('/api/')) {
        if (req.method !== 'GET' || route.includes('\0')) throw new InputError('Not found.', 404);
        const filename = path.resolve(publicRoot, `.${route === '/' || route === '/auth/callback' ? '/index.html' : route}`);
        if (!filename.startsWith(publicRoot + path.sep)) throw new InputError('Not found.', 404);
        const extension = path.extname(filename);
        if (!types[extension] || !['.html', '.js', '.mjs', '.css', '.svg', '.png', '.json'].includes(extension)) throw new InputError('Not found.', 404);
        let content;
        try { content = await readFile(filename); } catch { throw new InputError('Not found.', 404); }
        res.writeHead(200, { 'Content-Type': types[extension] }); res.end(content); return;
      }
      const user = await auth.user(req, res);
      if (route === '/api/session' && req.method === 'GET') return json(200, session(user));
      const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      if (route === '/api/session' && req.method === 'POST') return json(200, session(auth.change(req, res, body.role)));
      const { state, etag } = await store.read();
      state.approvals ??= {};
      assessRecords(authorizedState(state).records, domain);
      if (route === '/api/state' && req.method === 'GET') return json(200, stateView(state, user));
      if (route === '/api/evaluation' && req.method === 'GET') return json(200, await evaluateSamples(sampleDirectory, domain));
      if (route === '/api/reset' && req.method === 'POST') {
        requireRole(user, ['manager']);
        if (auth.mode !== 'local' || isAzure(env)) throw new InputError('Reset is local synthetic only.', 403);
        const blank = emptyState(); await save(blank, etag); return json(200, stateView(blank, user));
      }
      if (route === '/api/samples/load' && req.method === 'POST') {
        requireRole(user, ['reviewer', 'manager']);
        if (body.scenario && body.scenario !== 'monthly-scorecards') throw new InputError('Unknown sample scenario.');
        if (!state.samplesLoaded) {
          const manifest = await generateSamples({ directory: sampleDirectory, config });
          for (const customer of manifest.customers) if (!state.customers.some(item => item.id === customer.id)) state.customers.push(customer);
          for (const fixture of manifest.files) await addDocument(state, await readFile(path.join(sampleDirectory, fixture.name)), fixture.name, { customerId: fixture.customerId, period: domain.period, synthetic: true }, true);
          state.momentum = manifest.customers.map((customer, index) => ({ customerId: customer.id, period: domain.period, value: 65 + index * 8, label: 'Synthetic internal aggregate', synthetic: true, provenance: 'Generated demonstration aggregate; not a customer score or extracted source value' }));
          const currentMonth = new Date(`${domain.period}-01T00:00:00Z`);
          state.trends = manifest.customers.flatMap((customer, customerIndex) => domain.kpis.flatMap(kpi => Array.from({ length: 6 }, (_, index) => {
            const date = new Date(currentMonth); date.setUTCMonth(date.getUTCMonth() - (5 - index));
            const base = kpi.target ?? kpi.annualLimit;
            return { customerId: customer.id, kpiId: kpi.id, period: date.toISOString().slice(0, 7), value: Number((base + (customerIndex - 1) * (5 - index) * 0.1).toFixed(2)), unit: kpi.unit, synthetic: true, provenance: 'Generated synthetic historical trend; not extracted customer data' };
          })));
          state.escalations = [{ id: randomUUID(), customerId: manifest.customers[2].id, period: domain.period, status: 'needs_review', text: 'Synthetic escalation: review evidenced variances before any external commitment.', synthetic: true, provenance: 'Generated demonstration scenario; no real escalation or assignment' }];
          state.samplesLoaded = true;
          audit(state, user, 'samples.loaded', 'synthetic');
          await save(state, etag);
        }
        return json(200, stateView(state, user));
      }
      if (route === '/api/documents' && req.method === 'POST') {
        requireRole(user, ['reviewer', 'manager']);
        if (typeof body.name !== 'string' || body.name.length > 180 || /[\\/\x00-\x1f]/.test(body.name)) throw new InputError('Safe filename required.');
        if (typeof body.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) throw new InputError('Valid base64 content required.');
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length > 10 * 1024 * 1024) throw new InputError('Source exceeds 10 MiB.', 413);
        const customerId = body.customerId || 'unassigned';
        if (typeof customerId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(customerId)) throw new InputError('Invalid customer ID.');
        const period = body.period || domain.period;
        if (!periodValid(period)) throw new InputError('Period must be YYYY-MM.');
        if (body.restricted) throw new InputError('Restricted source rejected before persistence.', 403);
        const result = await addDocument(state, bytes, body.name, { customerId, period });
        if (!state.customers.some(item => item.id === customerId)) state.customers.push({ id: customerId, name: customerId === 'unassigned' ? 'Unassigned synthetic workspace' : customerId });
        audit(state, user, 'document.ingested', result.document.id);
        await save(state, etag);
        return json(201, { ...result, document: safeDocument(result.document) });
      }
      let match = /^\/api\/documents\/([^/]+)\/source$/.exec(route);
      if (match && req.method === 'GET') {
        const document = authorizedState(state).documents.find(item => item.id === match[1]);
        if (!document) throw new InputError('Source not found.', 404);
        const bytes = Buffer.from(document.contentBase64, 'base64');
        const safeName = document.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        res.writeHead(200, { 'Content-Type': types[path.extname(document.name).toLowerCase()] || sourceMimeType(document.name), 'Content-Disposition': `attachment; filename="${safeName}"`, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        res.end(bytes); return;
      }
      match = /^\/api\/records\/([^/]+)(\/confirm)?$/.exec(route);
      if (match && ((req.method === 'PATCH' && !match[2]) || (req.method === 'POST' && match[2]))) {
        requireRole(user, ['reviewer', 'manager']);
        const record = findRecord(state, match[1]);
        requireEditable(state, record.customerId, record.period);
        checkVersion(record, body.expectedVersion);
        const kpi = domain.kpis.find(item => item.id === record.kpiId);
        if (match[2]) {
          if (!kpi || record.value === null || record.unit !== kpi.unit) throw new InputError('Resolve missing/unknown metric and unit before confirmation.', 422);
          record.confirmed = true;
        } else {
          if (typeof body.value !== 'number' || !Number.isFinite(body.value)) throw new InputError('Correction value must be a finite JSON number.');
          if (body.unit !== undefined && (typeof body.unit !== 'string' || body.unit.length > 40)) throw new InputError('Invalid unit.');
          if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 1000 || /\b(restricted|confidential)\b/i.test(body.comment))) throw new InputError('Provide a short nonrestricted review comment.');
          record.value = body.value;
          record.unit = body.unit ?? record.unit;
          if (body.comment !== undefined) record.comment = body.comment;
          record.confidence = 1;
          record.confidenceSignal = 'human correction; not calibrated probability';
          record.status = classify(record.value, kpi, record.confidence, domain.confidenceThreshold);
          record.confirmed = false;
        }
        record.version++;
        invalidate(state, record);
        audit(state, user, match[2] ? 'record.confirmed' : 'record.corrected', record.id);
        await save(state, etag); return json(200, { record });
      }
      match = /^\/api\/periods\/([^/]+)\/(approve|publish)$/.exec(route);
      if (match && req.method === 'POST') {
        requireRole(user, ['manager']);
        const period = match[1], customerId = body.customerId;
        if (!periodValid(period) || typeof customerId !== 'string') throw new InputError('Customer and valid period required.');
        requireEditable(state, customerId, period);
        const records = authorizedState(state).records.filter(record => record.customerId === customerId && record.period === period);
        const allRecords = authorizedState(state).records;
        if (!records.length || records.some(record => !record.confirmed || record.value === null || record.kpiId === 'unknown' || record.assessment?.complete === false || record.assessment?.evidenceIds.some(id => !allRecords.find(item => item.id === id)?.confirmed))) throw new InputError('Every extracted record and annual dependency must be resolved and confirmed; empty/incomplete periods cannot be approved.', 422, 'REVIEW_REQUIRED');
        const key = scopeKey(customerId, period);
        if (match[2] === 'approve') {
          state.approvals[key] = { signature: signature(records, allRecords), approvedBy: user.id, approvedAt: new Date().toISOString() };
          audit(state, user, 'period.approved', key);
        } else {
          const approval = state.approvals[key];
          if (!approval || approval.signature !== signature(records, allRecords)) throw new InputError('Current manager approval required before publication.', 409, 'APPROVAL_REQUIRED');
          const dependencyIds = new Set(records.flatMap(record => record.assessment?.evidenceIds ?? []));
          const snapshot = { id: randomUUID(), customerId, period, publishedAt: new Date().toISOString(), publishedBy: user.id, approval: structuredClone(approval), records: structuredClone(records), evidence: structuredClone(allRecords.filter(record => dependencyIds.has(record.id))), rules: structuredClone(domain.kpis), rulesVersion: domain.rulesVersion || 'unversioned', immutable: true };
          state.published.push(snapshot);
          audit(state, user, 'period.published', snapshot.id);
        }
        await save(state, etag); return json(200, stateView(state, user));
      }
      if (route === '/api/actions' && req.method === 'POST') {
        requireRole(user, ['reviewer', 'manager']);
        const record = findRecord(state, body.recordId);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) throw new InputError('A short action draft is required.');
        if (body.restricted || /\b(restricted|confidential)\b/i.test(body.text)) throw new InputError('Restricted actions cannot enter this workbench.', 403);
        const action = { id: randomUUID(), recordId: record.id, customerId: record.customerId, period: record.period, text: body.text.trim(), status: 'draft', restricted: false, synthetic: record.synthetic === true, provenance: record.synthetic ? 'Human draft against a public synthetic source' : 'Human-authored draft against uploaded evidence', createdBy: user.id, createdAt: new Date().toISOString(), assignment: null };
        state.actions.push(action); audit(state, user, 'action.drafted', action.id);
        await save(state, etag); return json(201, { action });
      }
      match = /^\/api\/actions\/([^/]+)\/approve$/.exec(route);
      if (match && req.method === 'POST') {
        requireRole(user, ['manager']);
        const visible = authorizedState(state).actions.find(action => action.id === match[1]);
        if (!visible) throw new InputError('Action not found.', 404);
        const action = state.actions.find(item => item.id === visible.id);
        if (action.status !== 'draft') throw new InputError('Action already approved.', 409);
        action.status = 'approved'; action.approvedBy = user.id; action.approvedAt = new Date().toISOString();
        audit(state, user, 'action.approved', action.id);
        await save(state, etag); return json(200, { action });
      }
      if (route === '/api/questions' && req.method === 'POST') {
        if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1500) throw new InputError('Question must contain 1–1500 characters.');
        const visible = authorizedState(state);
        let records = visible.records.filter(record => !body.customerId || record.customerId === body.customerId);
        const question = normalize(body.question);
        const mentioned = domain.kpis.filter(kpi => [kpi.id, kpi.name, ...(kpi.aliases ?? [])].some(alias => question.includes(normalize(alias))));
        if (mentioned.length) records = records.filter(record => mentioned.some(kpi => kpi.id === record.kpiId));
        records = records.slice(0, 30);
        const citations = visible.records.map(record => ({ id: record.id, documentId: record.documentId, source: record.source.file, ...record.source }));
        const evidence = records.map(record => ({
          id: record.id, kpiName: record.kpiName, value: record.value, unit: record.unit, period: record.period, status: record.status, confirmed: record.confirmed, source: record.source,
          rule: domain.kpis.find(kpi => kpi.id === record.kpiId), assessment: record.assessment,
          supportedText: `${record.kpiName}: ${record.value === null ? 'not reported' : `${record.value} ${record.unit}`} — ${record.statusLabel}; ${record.confirmed ? 'human confirmed' : 'not yet human confirmed'} (${record.period}). ${record.assessment?.explanation || ''} ${record.baselineComparison?.explanation || ''}${record.customerRating ? ` Source/customer rating: ${record.customerRating} (independent of internal status).` : ''}`,
        }));
        let claims = [];
        let answerText;
        if (answer === 'azure') {
          if (evidence.length) {
            const result = await azure.answer(body.question, evidence);
            claims = result.claims;
          }
          answerText = claims.length ? claims.map(claim => claim.text).join('\n') : 'Azure Responses mode: I cannot provide a supported answer from the authorized evidence. No local answer was substituted.';
        } else {
          const relevant = mentioned.length || /\b(metric|performance|status|target|review|score|evidence|risk|data|missing|summary|period|record|which|show)\b/i.test(body.question);
          if (relevant) claims = evidence.map(record => ({
            text: record.supportedText,
            evidenceIds: [...new Set([record.id, ...(record.assessment?.evidenceIds ?? [])])],
          }));
          answerText = claims.length ? `Local deterministic grounded answer (not an LLM).\n${claims.map(claim => claim.text).join('\n')}` : 'Local deterministic mode (not an LLM): no supported answer in the authorized evidence. No values were inferred.';
        }
        const usedIds = new Set(claims.flatMap(claim => claim.evidenceIds));
        return json(200, { answer: answerText, claims, citations: citations.filter(citation => usedIds.has(citation.id)), hiddenItems: visible.hiddenItems, mode: provider.answer });
      }
      throw new InputError('Not found.', 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = Number.isInteger(error.status) ? error.status : 500;
      json(status, { error: status < 500 || error instanceof InputError ? error.message : 'Internal operation failed.', ...(error.code && typeof error.code === 'string' ? { code: error.code } : {}) });
    }
  });
  server.workbench = { store, config: publicConfig, authMode: auth.mode };
  server.requestTimeout = 90000;
  server.headersTimeout = 15000;
  return server;
}

export async function start(options = {}) {
  const env = options.env ?? process.env;
  const host = env.HOST || '127.0.0.1';
  const server = await createApp(options);
  if (server.workbench.authMode === 'local' && !isLoopback(host)) throw new Error('Local synthetic mode can only bind loopback.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await start();
    console.log(`Workbench listening on ${process.env.HOST || '127.0.0.1'}:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
