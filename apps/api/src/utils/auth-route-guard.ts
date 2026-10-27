const AUTH_BASE_PATH = '/api/auth';

const SERVER_ONLY_AUTH_PATHS = [
  '/sso/register',
  '/sso/providers',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
  '/sign-in/anonymous'
];

function normalizeAuthPathname(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }

  const collapsed = decoded
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  const relative = collapsed.startsWith(AUTH_BASE_PATH) ? collapsed.slice(AUTH_BASE_PATH.length) : collapsed;

  return relative || '/';
}

/**
 * Whether a Better Auth request path targets an endpoint that is only reachable
 * through the server-side `auth.api` and must not be served over HTTP.
 * Matching ignores case, repeated slashes, trailing slashes and percent-encoding.
 */
export function isServerOnlyAuthPath(pathname: string): boolean {
  const authPath = normalizeAuthPathname(pathname);

  return SERVER_ONLY_AUTH_PATHS.some((blocked) => authPath === blocked || authPath.startsWith(`${blocked}/`));
}
