import { randomBytes } from 'node:crypto';
import { InputError } from './ingestion.mjs';

export const roles = [
  { id: 'reviewer', label: 'Reviewer' },
  { id: 'manager', label: 'Manager' },
  { id: 'auditor', label: 'Auditor (read only)' },
];
export const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(address);
export const isAzure = env => Boolean(env.CONTAINER_APP_NAME || env.WEBSITE_SITE_NAME || env.IDENTITY_ENDPOINT || env.MSI_ENDPOINT);

export async function createAuth(env, { fetchImpl } = {}) {
  const cloud = isAzure(env) || env.NODE_ENV === 'production';
  const mode = env.AUTH_MODE || (cloud ? 'entra' : 'local');
  if (!['local', 'entra'].includes(mode)) throw new Error('Unsupported AUTH_MODE.');
  if (mode === 'local' && cloud) throw new Error('Local synthetic authentication is disabled in cloud/production.');
  let verifier;
  if (mode === 'entra') {
    if (!env.ENTRA_ISSUER || !env.ENTRA_AUDIENCE || !env.AZURE_TENANT_ID) throw new Error('Entra issuer, audience and tenant are required.');
    const issuer = new URL(env.ENTRA_ISSUER);
    if (issuer.protocol !== 'https:' || !issuer.pathname.includes(env.AZURE_TENANT_ID)) throw new Error('Entra issuer must be HTTPS and tenant-specific.');
    if (isAzure(env) && (!env.ENTRA_CLIENT_ID || !env.ENTRA_API_SCOPE)) throw new Error('Azure browser authentication requires SPA client ID and delegated API scope.');
    const { jwtVerify, createRemoteJWKSet, customFetch } = await import('jose');
    const jwks = new URL(env.ENTRA_JWKS_URI || `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/discovery/v2.0/keys`);
    if (jwks.protocol !== 'https:') throw new Error('JWKS must use HTTPS.');
    const keys = createRemoteJWKSet(jwks, fetchImpl ? { [customFetch]: fetchImpl } : {});
    verifier = async token => {
      try {
        const { payload } = await jwtVerify(token, keys, { issuer: env.ENTRA_ISSUER, audience: env.ENTRA_AUDIENCE, algorithms: ['RS256'] });
        if (payload.tid !== env.AZURE_TENANT_ID) throw new Error();
        const requiredScope = env.ENTRA_API_SCOPE?.split('/').filter(Boolean).at(-1) || 'user_impersonation';
        if (payload.ver !== '2.0' || !String(payload.scp || '').split(' ').includes(requiredScope)) throw new Error();
        const assigned = (Array.isArray(payload.roles) ? payload.roles : []).filter(role => roles.some(item => item.id === role));
        if (!assigned.length) throw new Error();
        const role = assigned.includes('manager') ? 'manager' : assigned.includes('reviewer') ? 'reviewer' : 'auditor';
        return { id: String(payload.oid || payload.sub), name: String(payload.name || 'Authenticated user'), role, auditView: role === 'auditor' };
      } catch { throw new InputError('Valid Entra identity and application role required.', 401, 'UNAUTHORIZED'); }
    };
  }
  const sessions = new Map();
  function issue(res, role) {
    const token = randomBytes(32).toString('base64url');
    const user = { id: `synthetic-${role}`, name: `Synthetic ${role}`, role, auditView: role === 'auditor' };
    sessions.set(token, { user, expires: Date.now() + 8 * 60 * 60 * 1000 });
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    res.setHeader('Set-Cookie', `workbench_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return user;
  }
  return {
    mode,
    async user(req, res) {
      if (mode === 'entra') {
        const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
        const token = match?.[1] || req.headers['x-ms-token-aad-access-token'];
        if (typeof token !== 'string' || !token) throw new InputError('Validated Entra API access token required. Sign in through the configured platform provider.', 401, 'UNAUTHORIZED');
        return verifier(token);
      }
      if (!isLoopback(req.socket.remoteAddress)) throw new InputError('Synthetic sessions are loopback-only.', 403);
      const token = /(?:^|;\s*)workbench_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(token);
      return session && session.expires > Date.now() ? session.user : issue(res, 'reviewer');
    },
    change(req, res, role) {
      if (mode !== 'local' || !isLoopback(req.socket.remoteAddress)) throw new InputError('Role switching is disabled.', 403);
      if (!roles.some(item => item.id === role)) throw new InputError('Unknown role.');
      return issue(res, role);
    },
  };
}
