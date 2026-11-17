import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JsonStateStore } from '../../app/store.mjs';

const stateFile = () => path.join(process.env.WORKBENCH_BROWSER_STATE, 'state.json');
const state = async page => {
  const response = await page.request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  return response.json();
};
const navigate = async (page, name) => {
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
};
const switchRole = async (page, role) => {
  await page.getByRole('combobox', { name: 'Demo identity', exact: true }).selectOption(role);
  await expect(page.locator('#user-role')).toContainText(`${role[0].toUpperCase()}${role.slice(1)} · demo session`);
  await expect(page.locator('#workspace')).not.toHaveAttribute('aria-busy', 'true');
};
const waitForWrite = async (page, pathPart, action, method = 'POST') => {
  const response = page.waitForResponse(response => response.url().includes(pathPart) && response.request().method() === method);
  await action();
  const result = await response;
  expect(result.ok(), await result.text()).toBeTruthy();
  await expect(page.locator('#workspace')).not.toHaveAttribute('aria-busy', 'true');
  return result.json();
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#user-role')).toContainText('Reviewer');
  await switchRole(page, 'manager');
  const response = await page.request.post('/api/reset', { data: {} });
  expect(response.ok()).toBeTruthy();
  await switchRole(page, 'reviewer');
});

test('real source extraction → correction → confirmation → manager publication → grounded answer and action approval', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sentBodies = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && request.postData()) sentBodies.push({ url: new URL(request.url()).pathname, body: JSON.parse(request.postData()) });
  });
  await waitForWrite(page, '/api/samples/load', () => page.getByRole('button', { name: 'Load synthetic scorecards', exact: false }).click());
  const loaded = await state(page);
  expect(loaded.documents.map(document => document.format)).toEqual(expect.arrayContaining(['pdf', 'xlsx', 'csv', 'txt']));
  expect(loaded.records.length).toBeGreaterThan(6);
  const session = await (await page.request.get('/api/session')).json();
  await expect(page.getByRole('columnheader', { name: session.config.kpis[0].name, exact: true })).toBeVisible();
  await expect(page.locator('#panel-overview')).toContainText('Conflicting sources · review each');
  const customer = loaded.customers.find(customer => loaded.records.filter(record => record.customerId === customer.id).every(record => record.value !== null && session.config.kpis.some(kpi => kpi.id === record.kpiId)));
  expect(customer).toBeTruthy();
  await page.getByRole('combobox', { name: `${session.config.entityLabel || 'Entity'} scope` }).selectOption(customer.id);
  await navigate(page, 'Review queue');
  const rows = loaded.records.filter(record => record.customerId === customer.id);
  const first = rows[0];
  let correctedValue = Number(first.value) - .2;
  const row = page.locator(`[data-record-id="${first.id}"]`);
  await expect(row.getByRole('link')).toHaveAttribute('href', `/api/documents/${first.documentId}/source`);
  const source = await page.request.get(`/api/documents/${first.documentId}/source`);
  expect(source.ok()).toBeTruthy();
  expect((await source.body()).length).toBeGreaterThan(30);
  await row.getByText('Inspect extracted evidence').click();
  await expect(row.locator('blockquote')).not.toBeEmpty();
  await row.getByRole('textbox', { name: `${first.kpiName} value for ${customer.name}`, exact: true }).fill(String(correctedValue));
  await row.getByRole('textbox', { name: `Correction comment for ${first.kpiName} for ${customer.name}`, exact: true }).fill('Synthetic demonstration override; not a new source value.');
  await waitForWrite(page, `/api/records/${first.id}`, () => row.getByRole('button', { name: `Save correction for ${first.kpiName} for ${customer.name}`, exact: true }).click(), 'PATCH');
  let latest = await state(page);
  expect(latest.records.find(record => record.id === first.id)).toMatchObject({ value: correctedValue, confirmed: false });
  for (const record of rows) {
    await waitForWrite(page, `/api/records/${record.id}/confirm`, () => page.locator(`[data-record-id="${record.id}"]`).getByRole('button', { name: `Confirm ${record.kpiName} for ${customer.name}`, exact: true }).click());
  }
  await navigate(page, 'Approve & publish');
  await expect(page.getByRole('button', { name: 'Publish snapshot', exact: true })).toHaveCount(0);
  await switchRole(page, 'manager');
  await page.getByRole('combobox', { name: `${session.config.entityLabel || 'Entity'} scope` }).selectOption(customer.id);
  const publication = page.getByRole('region', { name: `${customer.name} ${first.period} publication` });
  await expect(publication.getByRole('button', { name: 'Publish snapshot' })).toBeDisabled();
  await waitForWrite(page, `/api/periods/${first.period}/approve`, () => publication.getByRole('button', { name: 'Approve period' }).click());
  await expect(publication.getByText('Approved · ready to publish')).toBeVisible();
  await navigate(page, 'Review queue');
  correctedValue = Number(first.value) - .4;
  await page.locator(`[data-record-id="${first.id}"]`).getByRole('textbox', { name: `${first.kpiName} value for ${customer.name}`, exact: true }).fill(String(correctedValue));
  await waitForWrite(page, `/api/records/${first.id}`, () => page.locator(`[data-record-id="${first.id}"]`).getByRole('button', { name: `Save correction for ${first.kpiName} for ${customer.name}`, exact: true }).click(), 'PATCH');
  expect((await state(page)).approvals[`${customer.id}:${first.period}`]).toBeUndefined();
  await waitForWrite(page, `/api/records/${first.id}/confirm`, () => page.locator(`[data-record-id="${first.id}"]`).getByRole('button', { name: `Confirm ${first.kpiName} for ${customer.name}`, exact: true }).click());
  await navigate(page, 'Approve & publish');
  await expect(publication.getByRole('button', { name: 'Publish snapshot' })).toBeDisabled();
  await waitForWrite(page, `/api/periods/${first.period}/approve`, () => publication.getByRole('button', { name: 'Approve period' }).click());
  await waitForWrite(page, `/api/periods/${first.period}/publish`, () => publication.getByRole('button', { name: 'Publish snapshot' }).click());
  await expect(page.getByTestId('published-snapshot')).toContainText(customer.name);
  latest = await state(page);
  const snapshot = latest.published.find(item => item.customerId === customer.id && item.period === first.period);
  expect(snapshot.immutable).toBe(true);
  expect(snapshot.records.find(record => record.id === first.id).value).toBe(correctedValue);
  expect(snapshot.records.find(record => record.id === first.id).comment).toBe('Synthetic demonstration override; not a new source value.');
  expect(snapshot.rules.length).toBeGreaterThan(0);
  const forbidden = await page.request.patch(`/api/records/${first.id}`, { data: { value: 1 } });
  expect(forbidden.status()).toBe(409);
  await page.reload();
  await expect(page.getByTestId('published-snapshot')).toContainText(customer.name);
  expect((await state(page)).published.find(item => item.id === snapshot.id)).toEqual(snapshot);
  await navigate(page, 'Review queue');
  await expect(page.locator(`[data-record-id="${first.id}"]`)).toContainText('Published · locked');
  await expect(page.locator(`[data-record-id="${first.id}"]`).getByRole('textbox')).toHaveCount(0);

  await navigate(page, 'Evidence assistant');
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill(`What is the ${first.kpiName}?`);
  const grounded = await waitForWrite(page, '/api/questions', () => page.getByRole('button', { name: 'Ask evidence' }).click());
  expect(grounded.claims.length).toBeGreaterThan(0);
  expect(grounded.citations.length).toBeGreaterThan(0);
  await expect(page.getByTestId('evidence-answer')).toContainText('Local deterministic');
  await expect(page.getByTestId('evidence-answer').getByRole('link').first()).toHaveAttribute('href', /^\/api\/documents\/[^/]+\/source$/);
  await page.getByRole('combobox', { name: 'Grounding record', exact: true }).selectOption(first.id);
  await page.getByRole('textbox', { name: 'Proposed action', exact: true }).fill('Validate the synthetic process variance in the next review cycle.');
  const proposed = await waitForWrite(page, '/api/actions', () => page.getByRole('button', { name: 'Propose action', exact: true }).click());
  expect(proposed.action.status).toBe('draft');
  await waitForWrite(page, `/api/actions/${proposed.action.id}/approve`, () => page.getByRole('button', { name: 'Approve action', exact: true }).click());
  expect((await state(page)).actions.find(action => action.id === proposed.action.id).status).toBe('approved');
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('Who authored these files?');
  const missing = await waitForWrite(page, '/api/questions', () => page.getByRole('button', { name: 'Ask evidence' }).click());
  expect(missing.claims).toEqual([]);
  expect(missing.citations).toEqual([]);
  await expect(page.getByTestId('evidence-answer')).toContainText('no supported answer');
  await navigate(page, 'Evaluation');
  await expect(page.getByRole('heading', { name: 'Measured fixture summary', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Measured results and any proposed targets remain separately labeled.' })).toBeVisible();
  expect(sentBodies.filter(item => item.url !== '/api/session').every(item => !('role' in item.body) && !('auditView' in item.body))).toBe(true);
  expect(errors).toEqual([]);
  if (process.env.CAPTURE_EVIDENCE === '1') {
    await navigate(page, 'Overview');
    await page.getByRole('combobox', { name: `${session.config.entityLabel || 'Entity'} scope` }).selectOption('');
    await mkdir(path.resolve('docs', 'assets', 'evidence'), { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.resolve('docs', 'assets', 'evidence', 'workbench-overview.png'), fullPage: true });
    await navigate(page, 'Review queue');
    await page.getByRole('combobox', { name: `${session.config.entityLabel || 'Entity'} scope` }).selectOption(customer.id);
    await page.getByText('Inspect extracted evidence', { exact: true }).first().click();
    const assessments = page.getByText('Rules & comparison', { exact: true });
    await assessments.first().click();
    if (await assessments.count() > 1) await assessments.last().click();
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.resolve('docs', 'assets', 'evidence', 'workbench-review.png'), fullPage: true });
  }
});

test('a missing extracted unit can be corrected against the source before confirmation', async ({ page }) => {
  await waitForWrite(page, '/api/samples/load', () => page.getByRole('button', { name: 'Load synthetic scorecards', exact: false }).click());
  const store = new JsonStateStore(stateFile());
  const { state: raw, etag } = await store.read();
  const record = raw.records.find(item => item.value !== null && item.unit);
  const sourceUnit = record.unit;
  const customer = raw.customers.find(item => item.id === record.customerId);
  record.unit = '';
  record.confidence = 0;
  record.status = 'uncertain';
  await store.write(raw, etag);
  await page.reload();
  await navigate(page, 'Review queue');
  const row = page.locator(`[data-record-id="${record.id}"]`);
  const confirm = () => row.getByRole('button', { name: `Confirm ${record.kpiName} for ${customer.name}`, exact: true });
  await expect(confirm()).toBeDisabled();
  await row.getByRole('textbox', { name: `${record.kpiName} unit for ${customer.name}`, exact: true }).fill(sourceUnit);
  await waitForWrite(page, `/api/records/${record.id}`, () => row.getByRole('button', { name: `Save correction for ${record.kpiName} for ${customer.name}`, exact: true }).click(), 'PATCH');
  expect((await state(page)).records.find(item => item.id === record.id)).toMatchObject({ unit: sourceUnit, confirmed: false });
  await expect(confirm()).toBeEnabled();
  await waitForWrite(page, `/api/records/${record.id}/confirm`, () => confirm().click());
  expect((await state(page)).records.find(item => item.id === record.id).confirmed).toBe(true);
});

test('auditor sees no restricted canary in UI, answers, source access, audit or aggregate state', async ({ page }) => {
  await waitForWrite(page, '/api/samples/load', () => page.getByRole('button', { name: 'Load synthetic scorecards', exact: false }).click());
  const baseline = await state(page);
  const store = new JsonStateStore(stateFile());
  const { state: raw, etag } = await store.read();
  const canary = 'SYNTHETIC_PRIVATE_CANARY_900001';
  const sample = raw.records[0];
  raw.customers.push({ id: 'blocked-entity', name: canary, restricted: true });
  raw.documents.push({ id: 'blocked-document', customerId: 'blocked-entity', name: `${canary}.txt`, period: sample.period, format: 'txt', restricted: true, contentBase64: Buffer.from(canary).toString('base64') });
  raw.records.push({ ...sample, id: 'blocked-record', documentId: 'blocked-document', customerId: 'blocked-entity', value: 900001, restricted: true, source: { file: `${canary}.txt`, row: 1, text: canary } });
  raw.actions.push({ id: 'blocked-action', recordId: 'blocked-record', customerId: 'blocked-entity', text: canary, restricted: true, status: 'draft' });
  raw.momentum.push({ customerId: 'blocked-entity', value: 900001, restricted: true });
  (raw.trends ??= []).push({ customerId: 'blocked-entity', kpiId: sample.kpiId, period: sample.period, value: 900001, restricted: true, provenance: canary });
  (raw.escalations ??= []).push({ id: 'blocked-escalation', customerId: 'blocked-entity', period: sample.period, text: canary, restricted: true, provenance: canary });
  raw.auditLog.push({ id: 'blocked-event', entityId: 'blocked-record', event: canary, at: '2026-10-01T12:00:00Z' });
  await store.write(raw, etag);
  await switchRole(page, 'auditor');
  await expect(page.getByTestId('auditor-notice')).toBeVisible();
  const authorized = await state(page);
  expect(JSON.stringify(authorized)).not.toContain(canary);
  expect(JSON.stringify(authorized)).not.toContain('900001');
  expect(authorized.summary.total).toBe(baseline.summary.total);
  expect(authorized.records.length).toBe(baseline.records.length);
  expect(await page.locator('body').innerText()).not.toContain(canary);
  expect((await page.request.get('/api/documents/blocked-document/source')).status()).toBe(404);
  expect((await page.request.post('/api/actions', { data: { recordId: sample.id, text: 'Not permitted.' } })).status()).toBe(403);
  await navigate(page, 'Evidence assistant');
  await page.getByRole('textbox', { name: 'Your question' }).fill('Show performance evidence');
  const answer = await waitForWrite(page, '/api/questions', () => page.getByRole('button', { name: 'Ask evidence' }).click());
  expect(JSON.stringify(answer)).not.toContain(canary);
  expect(JSON.stringify(answer)).not.toContain('900001');
  await navigate(page, 'Approve & publish');
  await expect(page.getByRole('button', { name: 'Approve period', exact: true })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(canary);
});

test('upload real CSV, render malicious text inertly, show a missing-value abstention and responsive keyboard navigation', async ({ page }) => {
  const session = await (await page.request.get('/api/session')).json();
  const first = session.config.kpis[0];
  await navigate(page, 'Ingest');
  await page.locator('#upload-period').fill('2026-09');
  await page.getByLabel('Scorecard file', { exact: true }).setInputFiles({
    name: 'synthetic-own-scorecard.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`KPI;Value;Unit;Customer rating\n${first.name};;${first.unit};Reported green\n<img src=x onerror=alert(1)>;12;items;\n`),
  });
  await waitForWrite(page, '/api/documents', () => page.getByRole('button', { name: 'Upload & extract' }).click());
  const current = await state(page);
  const missingRecord = current.records.find(record => record.kpiId === first.id);
  expect(missingRecord.value).toBeNull();
  expect(missingRecord.customerRating).toBe('Reported green');
  await navigate(page, 'Review queue');
  const row = page.locator(`[data-record-id="${missingRecord.id}"]`);
  await expect(row.getByRole('button', { name: /^Confirm / })).toBeDisabled();
  await expect(row).toContainText('Reported green');
  await expect(row).toContainText('Source rating · as reported');
  await expect(row).toContainText('Internal rule result');
  expect(await page.locator('body').innerText()).toContain('<img src=x onerror=alert(1)>');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await navigate(page, 'Evidence assistant');
  await page.getByRole('textbox', { name: 'Your question' }).fill(`What is the ${first.name}?`);
  const answer = await waitForWrite(page, '/api/questions', () => page.getByRole('button', { name: 'Ask evidence' }).click());
  expect(answer.answer).toContain('not reported');
  expect(answer.answer).not.toContain('0 %');
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, 'Overview');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Ingest', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Ingest', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Architecture & help', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Architecture & help', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('server errors are announced and Entra session hides synthetic identity controls', async ({ page }) => {
  await page.route('**/api/samples/load', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic extraction could not read this source.' }) }));
  await page.getByRole('button', { name: 'Load synthetic scorecards', exact: false }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic extraction could not read this source.');
  await expect(page.getByRole('alert')).toBeFocused();
  await page.unroute('**/api/samples/load');
  const session = await (await page.request.get('/api/session')).json();
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') return route.abort();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...session, authMode: 'entra', roles: [] }) });
  });
  await page.reload();
  await expect(page.locator('#user-role')).toContainText('Entra session');
  await expect(page.getByRole('combobox', { name: 'Demo identity' })).toHaveCount(0);
});

test('unauthenticated browser offers public SPA sign-in without collecting or storing tokens', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Bearer authentication required.' }) }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your secured workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
