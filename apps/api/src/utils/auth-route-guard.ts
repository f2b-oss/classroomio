const AUTH_BASE_PATH = '/api/auth';

const SERVER_ONLY_AUTH_PATHS = [
  '/sso/register',
  '/sso/providers',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
  '/sign-in/anonymous',
  '/delete-anonymous-user'
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

function hasCanonicalAuthBasePath(pathname: string): boolean {
  return pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`);
}

/**
 * Whether the auth handler must reject a request path instead of passing it to Better Auth:
 * the path either targets a server-only endpoint or does not start with the literal base path.
 */
export function shouldDenyAuthPath(pathname: string): boolean {
  // Better Auth's router strips everything up to the first raw occurrence of the base path,
  // while Hono matches routes on the decoded path, so only the unencoded prefix is unambiguous.
  if (!hasCanonicalAuthBasePath(pathname)) {
    return true;
  }

  return isServerOnlyAuthPath(pathname);
}
