import { describe, expect, it } from 'vitest';

import { auth } from '@cio/db/auth';

describe('auth account linking', () => {
  it('disables implicit linking of OAuth accounts to existing users', () => {
    expect(auth.options.account?.accountLinking?.disableImplicitLinking).toBe(true);
  });

  it('keeps the account cookie', () => {
    expect(auth.options.account?.storeAccountCookie).toBe(true);
  });
});
