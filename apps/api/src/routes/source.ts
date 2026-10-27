import { SOURCE_CODE_LICENSE, getSourceCodeLocation } from '@cio/utils/functions';
import { Hono } from '@api/utils/hono';

export const sourceRouter = new Hono()
  /**
   * GET /source
   * Public. Where to get the source code of this running server (AGPL-3.0 section 13).
   */
  .get('/', (c) => {
    const location = getSourceCodeLocation({
      url: process.env.PUBLIC_SOURCE_CODE_URL,
      revision: process.env.PUBLIC_SOURCE_CODE_REVISION
    });

    return c.json({ license: SOURCE_CODE_LICENSE, ...location }, 200);
  });
