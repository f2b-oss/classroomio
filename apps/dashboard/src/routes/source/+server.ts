import { env } from '$env/dynamic/public';
import { getSourceCodeLocation } from '@cio/utils/functions';
import type { RequestHandler } from './$types';

/**
 * Public. Redirects to the source code of the running build (AGPL-3.0 section 13).
 */
export const GET: RequestHandler = () => {
  const location = getSourceCodeLocation({
    url: env.PUBLIC_SOURCE_CODE_URL,
    revision: env.PUBLIC_SOURCE_CODE_REVISION
  });

  return new Response(null, {
    status: 302,
    headers: { location: location.url, 'cache-control': 'no-store' }
  });
};
