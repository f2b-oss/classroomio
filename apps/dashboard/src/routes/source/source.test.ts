import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/public', () => ({ env: mocks.env }));

import { DEFAULT_SOURCE_CODE_URL } from '@cio/utils/functions';
import { isPublicRoute } from '$lib/utils/functions/routes/isPublicRoute';
import { GET } from './+server';

const request = () => GET({} as Parameters<typeof GET>[0]);

describe('GET /source', () => {
  beforeEach(() => {
    mocks.env.PUBLIC_SOURCE_CODE_URL = undefined;
    mocks.env.PUBLIC_SOURCE_CODE_REVISION = undefined;
  });

  it('redirects to the upstream repository when nothing is configured', async () => {
    const response = await request();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(DEFAULT_SOURCE_CODE_URL);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('redirects to the configured repository at the running revision', async () => {
    mocks.env.PUBLIC_SOURCE_CODE_URL = 'https://github.com/example/classroomio';
    mocks.env.PUBLIC_SOURCE_CODE_REVISION = '0123456789abcdef0123456789abcdef01234567';

    const response = await request();

    expect(response.headers.get('location')).toBe(
      'https://github.com/example/classroomio/tree/0123456789abcdef0123456789abcdef01234567'
    );
  });

  it('is reachable without signing in', () => {
    expect(isPublicRoute('/source')).toBe(true);
    expect(isPublicRoute('/source/extra')).toBe(false);
  });
});
