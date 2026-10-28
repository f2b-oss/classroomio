import { env } from '../../config/env';
import type { TWebhookUrlPolicy } from './url-guard';

/**
 * Parses a comma-separated host list into trimmed, lowercased entries. Unset or blank yields an empty list.
 */
export function parseWebhookAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Private-network destinations are allowed only on self-hosted installs that opt in explicitly.
 * Destinations must be listed in `WEBHOOK_ALLOWED_HOSTS`; with none listed, no webhook is sent.
 */
export function getWebhookUrlPolicy(): TWebhookUrlPolicy {
  const isSelfHosted = env.PUBLIC_IS_SELFHOSTED === 'true';

  return {
    allowPrivateNetworks: isSelfHosted && env.WEBHOOK_ALLOW_PRIVATE_NETWORKS === 'true',
    allowedHosts: parseWebhookAllowedHosts(env.WEBHOOK_ALLOWED_HOSTS)
  };
}
