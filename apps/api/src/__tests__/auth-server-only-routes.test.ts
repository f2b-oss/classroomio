import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cio/db/auth', () => ({
  auth: {
    handler: vi.fn(async () => new Response(null, { status: 200 })),
    api: { getSession: vi.fn(async () => null) }
  }
}));

import { app } from '@api/app';
import { auth } from '@cio/db/auth';
import { isServerOnlyAuthPath } from '@api/utils/auth-route-guard';

const SERVER_ONLY_PATHS = [
  '/api/auth/sso/register',
  '/api/auth/sso/providers',
  '/api/auth/sso/providers/provider-1',
  '/api/auth/sso/request-domain-verification',
  '/api/auth/sso/verify-domain',
  '/api/auth/sign-in/anonymous'
];

const PATH_VARIANTS = [
  '/api/auth/sso/register/',
  '/api/auth/SSO/Register',
  '/api/auth//sso/register',
  '/api/auth/sso/%72egister',
  '/api/auth/sign-in/anonymous?callbackURL=/'
];

const FORWARDED_PATHS = [
  '/api/auth/sign-in/sso',
  '/api/auth/sso/callback/x',
  '/api/auth/sso/saml2/callback/x',
  '/api/auth/sso/saml2/sp/acs/x',
  '/api/auth/sso/saml2/sp/metadata',
  '/api/auth/get-session'
];

describe('auth handler: server-only endpoints', () => {
  beforeEach(() => {
    vi.mocked(auth.handler).mockClear();
  });

  it.each(SERVER_ONLY_PATHS)('returns 404 for POST %s without calling Better Auth', async (path) => {
    const res = await app.request(path, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it.each(SERVER_ONLY_PATHS)('returns 404 for GET %s without calling Better Auth', async (path) => {
    const res = await app.request(path, { method: 'GET' });

    expect(res.status).toBe(404);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it.each(PATH_VARIANTS)('returns 404 for path variant %s', async (path) => {
    const res = await app.request(path, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it('matches the rewritten URL when X-Forwarded-Host is set', async () => {
    const res = await app.request('/api/auth/sso/register', {
      method: 'POST',
      headers: { 'x-forwarded-host': 'tenant.example.com', 'x-forwarded-proto': 'https' }
    });

    expect(res.status).toBe(404);
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it.each(FORWARDED_PATHS)('forwards POST %s to Better Auth', async (path) => {
    const res = await app.request(path, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(auth.handler).toHaveBeenCalledTimes(1);
  });
});

describe('isServerOnlyAuthPath', () => {
  it('does not match endpoints that share a prefix', () => {
    expect(isServerOnlyAuthPath('/api/auth/sso/registered')).toBe(false);
    expect(isServerOnlyAuthPath('/api/auth/sso/providers-list')).toBe(false);
    expect(isServerOnlyAuthPath('/api/auth/sign-in/anonymously')).toBe(false);
  });

  it('tolerates malformed percent-encoding', () => {
    expect(isServerOnlyAuthPath('/api/auth/sso/register%')).toBe(false);
  });
});
