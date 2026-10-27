import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SOURCE_CODE_URL } from '@cio/utils/functions';
import { sourceRouter } from '@api/routes/source';

describe('GET /source', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('points at the upstream repository when nothing is configured', async () => {
    vi.stubEnv('PUBLIC_SOURCE_CODE_URL', '');
    vi.stubEnv('PUBLIC_SOURCE_CODE_REVISION', '');

    const response = await sourceRouter.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      license: 'AGPL-3.0-only',
      repository: DEFAULT_SOURCE_CODE_URL,
      revision: null,
      url: DEFAULT_SOURCE_CODE_URL
    });
  });

  it('returns the configured repository at the running revision', async () => {
    vi.stubEnv('PUBLIC_SOURCE_CODE_URL', 'https://github.com/example/classroomio');
    vi.stubEnv('PUBLIC_SOURCE_CODE_REVISION', '0123456789abcdef0123456789abcdef01234567');

    const response = await sourceRouter.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      license: 'AGPL-3.0-only',
      repository: 'https://github.com/example/classroomio',
      revision: '0123456789abcdef0123456789abcdef01234567',
      url: 'https://github.com/example/classroomio/tree/0123456789abcdef0123456789abcdef01234567'
    });
  });
});
