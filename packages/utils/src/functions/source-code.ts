export const DEFAULT_SOURCE_CODE_URL = 'https://github.com/classroomio/classroomio';

export const SOURCE_CODE_LICENSE = 'AGPL-3.0-only';

const SAFE_REVISION = /^[A-Za-z0-9._/-]+$/;

export interface SourceCodeLocation {
  repository: string;
  revision: string | null;
  url: string;
}

function normalizeRepositoryUrl(rawUrl?: string | null): string {
  const trimmed = rawUrl?.trim() ?? '';
  if (!trimmed) {
    return DEFAULT_SOURCE_CODE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return DEFAULT_SOURCE_CODE_URL;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return DEFAULT_SOURCE_CODE_URL;
  }

  return parsed.href.replace(/\/+$/, '');
}

function normalizeRevision(rawRevision?: string | null): string | null {
  const trimmed = rawRevision?.trim() ?? '';
  if (!trimmed || !SAFE_REVISION.test(trimmed) || trimmed.includes('..')) {
    return null;
  }

  return trimmed;
}

/**
 * Resolves where users can get the source code of the running build (AGPL-3.0 section 13).
 * Falls back to the upstream repository when the URL is missing or not http(s), and drops an unsafe revision.
 */
export function getSourceCodeLocation(
  options: { url?: string | null; revision?: string | null } = {}
): SourceCodeLocation {
  const repository = normalizeRepositoryUrl(options.url);
  const revision = normalizeRevision(options.revision);
  const url = revision ? `${repository}/tree/${revision}` : repository;

  return { repository, revision, url };
}
