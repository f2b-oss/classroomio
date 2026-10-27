import { describe, expect, it } from 'vitest';

import { DEFAULT_SOURCE_CODE_URL, getSourceCodeLocation } from '../src/functions/source-code';

describe('getSourceCodeLocation', () => {
  it('defaults to the upstream repository without a revision', () => {
    expect(getSourceCodeLocation()).toEqual({
      repository: DEFAULT_SOURCE_CODE_URL,
      revision: null,
      url: DEFAULT_SOURCE_CODE_URL
    });
  });

  it('links to the exact revision of a configured repository', () => {
    const location = getSourceCodeLocation({
      url: 'https://github.com/example/classroomio',
      revision: '0123456789abcdef0123456789abcdef01234567'
    });

    expect(location).toEqual({
      repository: 'https://github.com/example/classroomio',
      revision: '0123456789abcdef0123456789abcdef01234567',
      url: 'https://github.com/example/classroomio/tree/0123456789abcdef0123456789abcdef01234567'
    });
  });

  it('trims whitespace and trailing slashes', () => {
    const location = getSourceCodeLocation({ url: ' https://git.example.org/team/lms/ ', revision: ' v1.2.3 ' });

    expect(location.url).toBe('https://git.example.org/team/lms/tree/v1.2.3');
  });

  it('treats an empty revision as the repository root', () => {
    const location = getSourceCodeLocation({ url: 'https://github.com/example/classroomio', revision: '' });

    expect(location.revision).toBeNull();
    expect(location.url).toBe('https://github.com/example/classroomio');
  });

  it.each([
    ['javascript URL', 'javascript:alert(1)'],
    ['data URL', 'data:text/html,hi'],
    ['relative path', '/source'],
    ['not a URL', 'classroomio']
  ])('falls back to the upstream repository for a %s', (_label, url) => {
    expect(getSourceCodeLocation({ url, revision: 'abc123' }).repository).toBe(DEFAULT_SOURCE_CODE_URL);
  });

  it.each([
    ['query string', 'abc?x=1'],
    ['fragment', 'abc#x'],
    ['path traversal', '../../settings'],
    ['whitespace inside', 'abc def'],
    ['markup', '<script>']
  ])('drops a revision containing a %s', (_label, revision) => {
    const location = getSourceCodeLocation({ url: 'https://github.com/example/classroomio', revision });

    expect(location.revision).toBeNull();
    expect(location.url).toBe('https://github.com/example/classroomio');
  });
});
