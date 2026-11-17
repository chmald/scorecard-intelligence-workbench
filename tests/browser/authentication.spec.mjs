import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const publicConfig = {
  authMode: 'entra',
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  scope: 'api://33333333-3333-4333-8333-333333333333/access_as_user',
  redirectPath: '/auth/callback',
};
const transactionKey = 'scorecard.pkce.transaction.v1';
const token = 'synthetic-provider-access-token-not-a-real-credential';

async function mockCloudShell(page, baseURL) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/(?:auth\/callback.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://login.microsoftonline.com; object-src 'none'; base-uri 'none'" },
    });
  });
  await page.route('**/api/auth/config', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(publicConfig) }));
  await page.route('**/api/session', async route => {
    if (route.request().headers().authorization !== `Bearer ${token}`) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'API access token required.' }) });
    }
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({ response, json: { ...session, authMode: 'entra', roles: [] } });
  });
  await page.goto(baseURL);
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
}

test('mocked Entra PKCE round trip uses S256, one-use state and memory-only bearer including authenticated source download', async ({ page, baseURL }) => {
  await page.goto('/');
  await expect(page.locator('#user-role')).toContainText('Reviewer');
  const load = await page.request.post('/api/samples/load', { data: { scenario: 'monthly-scorecards' } });
  expect(load.ok()).toBeTruthy();
  await mockCloudShell(page, baseURL);
  let authorization;
  let tokenRequests = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const bearerRequests = [];
  page.on('request', request => {
    if (request.url().startsWith(`${baseURL}/api/`) && request.headers().authorization) bearerRequests.push({ url: request.url(), authorization: request.headers().authorization });
  });
  await page.route('https://login.microsoftonline.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/authorize')) {
      authorization = url.searchParams;
      expect(authorization.get('client_id')).toBe(publicConfig.clientId);
      expect(authorization.get('scope')).toBe(publicConfig.scope);
      expect(authorization.get('response_type')).toBe('code');
      expect(authorization.get('code_challenge_method')).toBe('S256');
      expect(authorization.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const callback = new URL('/auth/callback', baseURL);
      callback.searchParams.set('code', 'one-use-synthetic-code');
      callback.searchParams.set('state', authorization.get('state'));
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic identity provider</title><script>location.replace(${JSON.stringify(callback.href)})</script>` });
    }
    if (url.pathname.endsWith('/token')) {
      tokenRequests++;
      const body = new URLSearchParams(route.request().postData());
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('one-use-synthetic-code');
      expect(body.get('redirect_uri')).toBe(new URL('/auth/callback', baseURL).href);
      expect(body.get('scope')).toBe(publicConfig.scope);
      expect(body.has('client_secret')).toBe(false);
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(createHash('sha256').update(body.get('code_verifier')).digest('base64url')).toBe(authorization.get('code_challenge'));
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': new URL(baseURL).origin }, contentType: 'application/json', body: JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600, id_token: 'ignored-not-used-for-identity' }) });
    }
    return route.abort();
  });
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  await expect(page.locator('#user-role')).toContainText('Entra session');
  expect(tokenRequests).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await expect(page.getByRole('combobox', { name: 'Demo identity' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Ingest', exact: true }).click();
  await page.clock.install();
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.sourceObjectUrls = new Set();
    URL.createObjectURL = blob => { const url = create(blob); window.sourceObjectUrls.add(url); return url; };
    URL.revokeObjectURL = url => { window.sourceObjectUrls.delete(url); revoke(url); };
  });
  const source = page.getByRole('link', { name: 'Open source ↗' }).first();
  await expect(source).toHaveAttribute('href', /^\/api\/documents\/[^/]+\/source$/);
  const downloaded = page.waitForEvent('download');
  await source.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^synthetic-.*\.(pdf|xlsx|csv|txt|json)$/);
  expect(bearerRequests.some(request => /\/source$/.test(request.url))).toBe(true);
  expect(bearerRequests.every(request => request.authorization === `Bearer ${token}` && !request.url.includes(token))).toBe(true);
  expect(await page.evaluate(() => window.sourceObjectUrls.size)).toBe(1);
  await page.clock.fastForward(61000);
  expect(await page.evaluate(() => window.sourceObjectUrls.size)).toBe(0);
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
});

for (const scenario of ['mismatched state', 'expired transaction', 'provider denial']) {
  test(`PKCE ${scenario} clears callback and transaction without redeeming a token`, async ({ page, baseURL }) => {
    await mockCloudShell(page, baseURL);
    let providerRequests = 0;
    await page.route('https://login.microsoftonline.com/**', route => { providerRequests++; return route.abort(); });
    const state = 'A'.repeat(43);
    await page.evaluate(({ key, state, settings, origin, expired }) => {
      sessionStorage.setItem(key, JSON.stringify({
        state,
        verifier: 'B'.repeat(43),
        createdAt: Date.now() - (expired ? 11 * 60 * 1000 : 0),
        redirectUri: `${origin}/auth/callback`,
        tenantId: settings.tenantId,
        clientId: settings.clientId,
        scope: settings.scope,
      }));
    }, { key: transactionKey, state, settings: publicConfig, origin: new URL(baseURL).origin, expired: scenario === 'expired transaction' });
    const callback = new URL('/auth/callback', baseURL);
    if (scenario === 'provider denial') callback.searchParams.set('error', 'access_denied');
    else { callback.searchParams.set('code', 'must-not-be-redeemed'); callback.searchParams.set('state', scenario === 'mismatched state' ? 'C'.repeat(43) : state); }
    await page.goto(callback.href);
    await expect(page.getByRole('alert')).toContainText(scenario === 'provider denial' ? 'cancelled or declined' : 'missing, expired, or does not match');
    expect(page.url()).toBe(`${baseURL}/`);
    expect(await page.evaluate(key => sessionStorage.getItem(key), transactionKey)).toBeNull();
    expect(providerRequests).toBe(0);
  });
}
