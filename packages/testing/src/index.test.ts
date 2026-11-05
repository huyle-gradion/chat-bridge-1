import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  ScenarioBuilder,
  SimulatedNetwork,
  MockMarginceServer,
  signMargincePayload,
  describeSourceContract,
  describeSinkContract,
} from './index.js';
import type { SourceContract, SinkContract, Message, SourceStatus, SinkHealthStatus } from '@chat-bridge/types';

describe('@chat-bridge/testing', () => {
  describe('ScenarioBuilder', () => {
    it('generates a deterministic message stream given a constant seed', () => {
      const scenario1 = new ScenarioBuilder({ seed: 42 })
        .withContacts(2)
        .withOtpCode('123456')
        .withLongText(40000)
        .withNoise(['reaction', 'typing'])
        .withMedia('image', 'invoice.pdf', 1024 * 1024 * 2)
        .buildScenario();

      const scenario2 = new ScenarioBuilder({ seed: 42 })
        .withContacts(2)
        .withOtpCode('123456')
        .withLongText(40000)
        .withNoise(['reaction', 'typing'])
        .withMedia('image', 'invoice.pdf', 1024 * 1024 * 2)
        .buildScenario();

      expect(scenario1.messages.length).toBe(scenario2.messages.length);
      expect(scenario1.messages[0]?.id).toBe(scenario2.messages[0]?.id);
      expect(scenario1.expectedOtpMessageIds).toEqual(scenario2.expectedOtpMessageIds);
      expect(scenario1.expectedNoiseMessageIds).toEqual(scenario2.expectedNoiseMessageIds);
    });

    it('creates zero real PII: contacts use synthetic accounts and test numbers', () => {
      const scenario = new ScenarioBuilder({ seed: 99 }).withContacts(5).buildScenario();
      for (const contact of scenario.contacts) {
        expect(contact.accountId).toMatch(/^cust-\d{3}$/);
        expect(contact.phone).toMatch(/^\+84900000\d{3}$/);
      }
    });

    it('injects 40,000 character message payload for truncation testing', () => {
      const scenario = new ScenarioBuilder().withLongText(40000).build();
      const longMsg = scenario.find((m) => m.text.length >= 40000);
      expect(longMsg).toBeDefined();
      expect(longMsg?.text.length).toBe(40000);
    });
  });

  describe('SimulatedNetwork', () => {
    it('executes normal actions when no faults are configured', async () => {
      const net = new SimulatedNetwork();
      const result = await net.execute(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('throws HTTP 429 when rate limit fault is injected', async () => {
      const net = new SimulatedNetwork();
      net.simulateRateLimit(1, 5);

      await expect(net.execute(async () => 'ok')).rejects.toThrow('HTTP 429: Too Many Requests');
      // Subsequent call succeeds
      const next = await net.execute(async () => 'second-ok');
      expect(next).toBe('second-ok');
    });

    it('throws HTTP 503 when server error is injected', async () => {
      const net = new SimulatedNetwork();
      net.simulateServerError(1, 503);

      await expect(net.execute(async () => 'ok')).rejects.toThrow('HTTP 503: Service Unavailable');
    });
  });

  describe('MockMarginceServer (ADR 0008 Contract Parity)', () => {
    const sharedSecret = 'test-secret-key-xyz';
    const ref = 'oc_test_42';
    let server: MockMarginceServer;

    beforeAll(() => {
      server = new MockMarginceServer({ sharedSecret, ref });
    });

    it('responds to health / ping requests', async () => {
      const res = await server.dispatch('/health');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ready');
    });

    it('rejects requests missing security headers', async () => {
      const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      });
      expect(res.status).toBe(400);
    });

    it('rejects requests with invalid HMAC signature', async () => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const body = JSON.stringify([]);

      const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts),
          'X-Bridge-Nonce': nonce,
          'X-Bridge-Signature': 'invalid_signature_hex',
        },
        body,
      });

      expect(res.status).toBe(401);
    });

    it('rejects requests with expired timestamp (> 300s)', async () => {
      const ts = Math.floor(Date.now() / 1000) - 400; // 400s old
      const nonce = crypto.randomUUID();
      const body = JSON.stringify([]);
      const sig = signMargincePayload(sharedSecret, ref, ts, nonce, body);

      const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts),
          'X-Bridge-Nonce': nonce,
          'X-Bridge-Signature': sig,
        },
        body,
      });

      expect(res.status).toBe(401);
    });

    it('rejects replayed nonce', async () => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const body = JSON.stringify([]);
      const sig = signMargincePayload(sharedSecret, ref, ts, nonce, body);

      // First call succeeds
      const res1 = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts),
          'X-Bridge-Nonce': nonce,
          'X-Bridge-Signature': sig,
        },
        body,
      });
      expect(res1.status).toBe(200);

      // Second call with same nonce is rejected as replay
      const res2 = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts),
          'X-Bridge-Nonce': nonce,
          'X-Bridge-Signature': sig,
        },
        body,
      });
      expect(res2.status).toBe(409);
    });

    it('accepts valid HMAC signed messages and detects duplicate message IDs', async () => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const msg: Message = {
        id: 'fake:rep-01:msg-unique-1',
        network: 'fake',
        account: 'rep-01',
        thread: 't1',
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date().toISOString(),
        from: { accountId: 'c1', displayName: 'Customer' },
        to: [],
        text: 'Hello Margince!',
      };
      const body = JSON.stringify([msg]);
      const sig = signMargincePayload(sharedSecret, ref, ts, nonce, body);

      // First delivery: accepted
      const res1 = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts),
          'X-Bridge-Nonce': nonce,
          'X-Bridge-Signature': sig,
        },
        body,
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.results[0]?.outcome).toBe('accepted');

      // Second delivery of same message with fresh nonce: duplicate
      const ts2 = Math.floor(Date.now() / 1000);
      const nonce2 = crypto.randomUUID();
      const sig2 = signMargincePayload(sharedSecret, ref, ts2, nonce2, body);
      const res2 = await server.dispatch(`/webhooks/ext/openchannel/receive/${ref}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(ts2),
          'X-Bridge-Nonce': nonce2,
          'X-Bridge-Signature': sig2,
        },
        body,
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.results[0]?.outcome).toBe('duplicate');
    });
  });

  // Test the parameterized contract runners with mock providers
  describe('describeSourceContract Verification', () => {
    const mockSourceFactory = (): SourceContract => {
      const status: SourceStatus = {
        state: 'connected',
        reason: 'Ready',
        updatedAt: new Date().toISOString(),
      };
      return {
        network: 'fake',
        account: 'rep-mock-01',
        login: async () => status,
        start: async () => {},
        stop: async () => {},
        status: async () => status,
        chats: async () => [
          {
            id: 'mock-chat-1',
            network: 'fake',
            account: 'rep-mock-01',
            name: 'Mock Chat',
            kind: 'dm',
          },
        ],
        history: async () => [],
        send: async () => ({ ok: true, messageId: 'm-1' }),
      };
    };

    describeSourceContract('MockInMemorySource', mockSourceFactory);
  });

  describe('describeSinkContract Verification', () => {
    const mockSinkFactory = (): SinkContract => {
      const health: SinkHealthStatus = {
        health: 'ok',
        reason: 'Operating within normal thresholds',
      };
      return {
        sinkId: 'mock-sink-01',
        name: 'Mock In-Memory Sink',
        limits: {
          batchSize: 50,
          requestsPerMinute: 60,
        },
        configure: async () => ({ valid: true }),
        test: async () => ({ ok: true, message: 'Verified' }),
        deliver: async (batch) => batch.map((m) => ({ messageId: m.id, outcome: 'accepted' as const })),
        health: async () => health,
      };
    };

    describeSinkContract('MockInMemorySink', mockSinkFactory);
  });
});
