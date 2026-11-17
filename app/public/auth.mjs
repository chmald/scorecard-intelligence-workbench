const transactionKey = 'scorecard.pkce.transaction.v1';
const transactionLifetime = 10 * 60 * 1000;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let accessToken = null;
let expiresAt = 0;
let configuration = null;

const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const authority = tenant => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

async function config() {
  if (configuration) return configuration;
  const response = await fetch('/api/auth/config', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Microsoft sign-in is not configured. Ask the operator to check the public SPA and API configuration.');
  const value = await response.json();
  if (value.authMode !== 'entra' || !guid.test(value.tenantId) || !guid.test(value.clientId) || !/^api:\/\/[^\s?#]+\/[A-Za-z0-9_.-]+$/.test(value.scope) || value.redirectPath !== '/auth/callback') {
    throw new Error('Microsoft sign-in configuration is incomplete. An explicit tenant, public SPA client, and delegated API scope are required.');
  }
  configuration = Object.freeze({ authMode: value.authMode, tenantId: value.tenantId, clientId: value.clientId, scope: value.scope, redirectPath: value.redirectPath });
  return configuration;
}

export function bearer() {
  if (expiresAt - Date.now() <= 30000) { accessToken = null; expiresAt = 0; }
  return accessToken;
}

export function clearAuthentication() {
  accessToken = null;
  expiresAt = 0;
  sessionStorage.removeItem(transactionKey);
}

export async function beginSignIn() {
  if (!window.isSecureContext || !crypto.subtle) throw new Error('Microsoft sign-in requires HTTPS, or a supported loopback development origin.');
  const settings = await config();
  const state = random();
  const verifier = random();
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const redirectUri = new URL(settings.redirectPath, location.origin).href;
  sessionStorage.setItem(transactionKey, JSON.stringify({ state, verifier, createdAt: Date.now(), redirectUri, tenantId: settings.tenantId, clientId: settings.clientId, scope: settings.scope }));
  const parameters = new URLSearchParams({
    client_id: settings.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: settings.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  location.assign(`${authority(settings.tenantId)}/authorize?${parameters}`);
}

export async function completeSignIn() {
  if (location.pathname !== '/auth/callback') return false;
  const parameters = new URLSearchParams(location.search);
  const stored = sessionStorage.getItem(transactionKey);
  sessionStorage.removeItem(transactionKey);
  history.replaceState(null, '', '/');
  if (parameters.has('error')) throw new Error('Microsoft sign-in was cancelled or declined. Start a new sign-in attempt.');
  let pending;
  try { pending = JSON.parse(stored || 'null'); } catch { /* Invalid transactions are rejected below. */ }
  const age = Date.now() - pending?.createdAt;
  const code = parameters.get('code');
  if (!pending || !code || code.length > 4096 || !/^[A-Za-z0-9_-]{43}$/.test(pending.state || '') || parameters.get('state') !== pending.state || !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier || '') || typeof pending.createdAt !== 'number' || !Number.isFinite(age) || age < 0 || age > transactionLifetime) {
    throw new Error('Sign-in transaction is missing, expired, or does not match this browser. Start a new sign-in attempt.');
  }
  const settings = await config();
  const redirectUri = new URL(settings.redirectPath, location.origin).href;
  if (pending.redirectUri !== redirectUri || pending.tenantId !== settings.tenantId || pending.clientId !== settings.clientId || pending.scope !== settings.scope) {
    throw new Error('Sign-in configuration changed during authentication. Start a new sign-in attempt.');
  }
  const response = await fetch(`${authority(settings.tenantId)}/token`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: settings.scope, code_verifier: pending.verifier }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('The authorization code could not be redeemed. Check the SPA redirect URI, delegated API scope, and consent, then sign in again.');
  const token = await response.json();
  const lifetime = Number(token.expires_in);
  if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 24000 || String(token.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(lifetime) || lifetime <= 30) {
    throw new Error('The identity provider did not return a usable API access token.');
  }
  // API JWT validation is authoritative; no ID token or browser claims establish a role.
  accessToken = token.access_token;
  expiresAt = Date.now() + lifetime * 1000;
  return true;
}

export async function signOut() {
  const settings = await config();
  clearAuthentication();
  const parameters = new URLSearchParams({ post_logout_redirect_uri: new URL('/', location.origin).href, client_id: settings.clientId });
  location.assign(`${authority(settings.tenantId)}/logout?${parameters}`);
}
