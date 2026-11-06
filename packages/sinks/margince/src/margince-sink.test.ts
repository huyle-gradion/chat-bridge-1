import { describe, it, expect, beforeEach } from 'vitest';
import { describeSinkContract, MockMarginceServer } from '@chat-bridge/testing';
import type { Message } from '@chat-bridge/types';
import { MarginceSink } from './margince-sink.js';

describe('US-K4-01: Margince CRM Secure Forwarding (Signed Push)', () => {
  let mockServer: MockMarginceServer;
  const testRef = 'oc_test_ref_42';
  const testSecret = 'test_secret_key_super_secure';

  beforeEach(() => {
    mockServer = new MockMarginceServer({
      ref: testRef,
      sharedSecret: testSecret,
    });
  });

  describe('SinkContract Conformance', () => {
    describeSinkContract('MarginceSink', () => {
      const sink = new MarginceSink({
        dispatcher: (url, init) => mockServer.dispatch(url, init),
      });
      sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });
      return sink;
    });
  });

  describe('Scenario 1: One-click configuration and test', () => {
    it('validates connection string and reports plain-language errors on invalid syntax', async () => {
      const sink = new MarginceSink();
      const invalidResult = await sink.configure({
        connectionString: 'invalid-uri-scheme',
      });

      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors).toBeDefined();
      expect(invalidResult.errors?.connectionString).toBeDefined();

      const validResult = await sink.configure({
        connectionString: `margince://crm.example.com/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toBeUndefined();
    });

    it('performs signed lightweight probe returning success message', async () => {
      const sink = new MarginceSink({
        dispatcher: (url, init) => mockServer.dispatch(url, init),
      });
      await sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      const testResult = await sink.test();
      expect(testResult.ok).toBe(true);
      expect(testResult.message).toBe('Connection successful. Ready to send messages to Margince.');
    });

    it('returns error when probe fails or credentials are wrong', async () => {
      const sink = new MarginceSink({
        dispatcher: () => Promise.resolve(new Response('Unauthorized', { status: 401 })),
      });
      await sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      const testResult = await sink.test();
      expect(testResult.ok).toBe(false);
      expect(testResult.message).toContain('Connection failed');
    });
  });

  describe('Scenario 2: Tamper-proof HMAC-SHA256 signature', () => {
    it('dispatches arrivals with valid HMAC-SHA256 signature and nonce', async () => {
      const sink = new MarginceSink({
        dispatcher: (url, init) => mockServer.dispatch(url, init),
      });
      await sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      const message: Message = {
        id: 'whatsapp:rep-01:msg-101',
        network: 'whatsapp',
        account: 'rep-01',
        thread: 'cust-101',
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date().toISOString(),
        from: { accountId: 'cust-101', displayName: 'Customer Alice', phone: '+1234567890' },
        to: [{ accountId: 'rep-01', displayName: 'Rep Dylan' }],
        text: 'Can we schedule a product demo?',
      };

      const outcomes = await sink.deliver([message]);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]?.outcome).toBe('accepted');

      const requests = mockServer.getReceivedRequests();
      expect(requests.length).toBe(1);
      expect(requests[0]?.ref).toBe(testRef);
      expect(requests[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(requests[0]?.nonce).toMatch(/^[0-9a-fA-F]+$/);
    });

    it('handles simulated rate limit (HTTP 429) with retry recommendation', async () => {
      mockServer.simulateRateLimit(1, 3);

      const sink = new MarginceSink({
        dispatcher: (url, init) => mockServer.dispatch(url, init),
      });
      await sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      const message: Message = {
        id: 'whatsapp:rep-01:msg-102',
        network: 'whatsapp',
        account: 'rep-01',
        thread: 'cust-102',
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date().toISOString(),
        from: { accountId: 'cust-102', displayName: 'Customer Bob' },
        to: [{ accountId: 'rep-01', displayName: 'Rep Dylan' }],
        text: 'Checking pricing details',
      };

      const outcomes = await sink.deliver([message]);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]?.outcome).toBe('refused');
      expect(outcomes[0]?.statusCode).toBe(429);
      expect(outcomes[0]?.retryAfterMs).toBe(3000);
    });
  });

  describe('Scenario 3: Media attachment placeholder formatting', () => {
    it('formats attachment placeholders cleanly into message body without binary bytes', async () => {
      const sink = new MarginceSink({
        dispatcher: (url, init) => mockServer.dispatch(url, init),
      });
      await sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      const messageWithAttachment: Message = {
        id: 'whatsapp:rep-01:msg-103',
        network: 'whatsapp',
        account: 'rep-01',
        thread: 'cust-103',
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date().toISOString(),
        from: { accountId: 'cust-103', displayName: 'Customer Charlie' },
        to: [{ accountId: 'rep-01', displayName: 'Rep Dylan' }],
        text: 'Please find attached invoice for review.',
        placeholder: '[image: invoice.jpg, 1.2 MB]',
      };

      const outcomes = await sink.deliver([messageWithAttachment]);
      expect(outcomes[0]?.outcome).toBe('accepted');

      const arrivals = mockServer.getReceivedArrivals();
      expect(arrivals.length).toBe(1);
      expect(arrivals[0]?.body).toBe('[image: invoice.jpg, 1.2 MB]\nPlease find attached invoice for review.');
    });

    it('truncates message text exceeding 32,768 characters', async () => {
      const sink = new MarginceSink({
        dispatcher: (url, init) => mockServer.dispatch(url, init),
      });
      await sink.configure({
        connectionString: `margince://127.0.0.1/openchannel?ref=${testRef}&key=${testSecret}`,
      });

      const oversizedText = 'A'.repeat(40000);
      const message: Message = {
        id: 'whatsapp:rep-01:msg-104',
        network: 'whatsapp',
        account: 'rep-01',
        thread: 'cust-104',
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date().toISOString(),
        from: { accountId: 'cust-104', displayName: 'Customer David' },
        to: [{ accountId: 'rep-01', displayName: 'Rep Dylan' }],
        text: oversizedText,
      };

      const outcomes = await sink.deliver([message]);
      expect(outcomes[0]?.outcome).toBe('accepted');

      const arrivals = mockServer.getReceivedArrivals();
      expect(arrivals.length).toBe(1);
      expect(arrivals[0]?.body?.length).toBe(32768);
    });
  });
});
