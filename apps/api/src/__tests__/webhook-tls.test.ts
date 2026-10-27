import { EventEmitter } from 'node:events';
import https from 'node:https';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PRIVATE_SERVER_KEY = 'unit-test-server-key';
  process.env.PUBLIC_IS_SELFHOSTED = 'true';
  process.env.WEBHOOK_ALLOWED_HOSTS = '203.0.113.10';
});

import { attemptWebhookDelivery } from '@cio/core/services/webhook/deliver';
import type { TWebhookEndpoint, TWebhookEvent } from '@cio/db/types';

const endpoint: TWebhookEndpoint = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  name: 'Test',
  payloadUrl: 'https://203.0.113.10/hook',
  secretCiphertext: null,
  secretLast4: null,
  verifySsl: false,
  eventMode: 'all',
  isActive: true,
  consecutiveFailures: 0,
  autoDisabledAt: null,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  createdByProfileId: null,
  updatedByProfileId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const event: TWebhookEvent = {
  id: 'evt_tls',
  organizationId: endpoint.organizationId,
  eventType: 'course.completed',
  payload: { id: 'evt_tls', type: 'course.completed', data: {} },
  createdAt: new Date().toISOString()
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook TLS verification', () => {
  it('verifies certificates even when the endpoint has verifySsl turned off', async () => {
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((() => {
      const request = Object.assign(new EventEmitter(), {
        end: () => request.emit('error', new Error('connection stubbed')),
        destroy: () => undefined
      });

      return request;
    }) as unknown as typeof https.request);

    const result = await attemptWebhookDelivery(endpoint, { id: 'whd_tls', attempt: 0 }, event);
    const options = requestSpy.mock.calls[0]![0] as https.RequestOptions;

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(options.rejectUnauthorized).toBe(true);
    expect(result.errorMessage).toBe('connection stubbed');
  });
});
