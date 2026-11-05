import { describe, it, expect, beforeEach } from 'vitest';
import type { SinkContract, Message } from '@chat-bridge/types';

/**
 * Parameterized contract test suite for any SinkContract provider.
 * Guarantees that Archive, Local DB, Sheets, and Margince satisfy identical delivery semantics.
 * Spec Section 6 & ADR 0018.
 */
export function describeSinkContract(
  providerName: string,
  factory: () => Promise<SinkContract> | SinkContract
) {
  describe(`SinkContract Conformance: ${providerName}`, () => {
    let sink: SinkContract;

    beforeEach(async () => {
      sink = await factory();
    });

    it('declares sink identification and positive rate limits', () => {
      expect(typeof sink.sinkId).toBe('string');
      expect(sink.sinkId.length).toBeGreaterThan(0);
      expect(typeof sink.name).toBe('string');

      expect(sink.limits.batchSize).toBeGreaterThan(0);
      expect(sink.limits.requestsPerMinute).toBeGreaterThan(0);
    });

    it('performs safe connection test returning plain-language response', async () => {
      const result = await sink.test();
      expect(typeof result.ok).toBe('boolean');
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    });

    it('reports health status with plain-language explanation', async () => {
      const health = await sink.health();
      expect(['ok', 'degraded', 'down']).toContain(health.health);
      expect(typeof health.reason).toBe('string');
    });

    it('delivers a batch of messages and returns granular outcomes per message ID', async () => {
      const sampleBatch: Message[] = [
        {
          id: 'fake:rep-test:msg-1',
          network: 'fake',
          account: 'rep-test',
          thread: 'thread-1',
          threadKind: 'dm',
          direction: 'inbound',
          time: new Date().toISOString(),
          from: { accountId: 'c1', displayName: 'Customer 1' },
          to: [{ accountId: 'rep-test', displayName: 'Rep' }],
          text: 'Hello from batch test 1',
        },
        {
          id: 'fake:rep-test:msg-2',
          network: 'fake',
          account: 'rep-test',
          thread: 'thread-1',
          threadKind: 'dm',
          direction: 'outbound',
          time: new Date().toISOString(),
          from: { accountId: 'rep-test', displayName: 'Rep' },
          to: [{ accountId: 'c1', displayName: 'Customer 1' }],
          text: 'Reply from batch test 2',
        },
      ];

      const outcomes = await sink.deliver(sampleBatch);
      expect(Array.isArray(outcomes)).toBe(true);
      expect(outcomes.length).toBe(sampleBatch.length);

      for (let i = 0; i < sampleBatch.length; i++) {
        const item = outcomes[i]!;
        const originalMsg = sampleBatch[i]!;
        expect(item.messageId).toBe(originalMsg.id);
        expect(['accepted', 'duplicate', 'refused']).toContain(item.outcome);
      }
    });

    it('validates settings configuration and returns structured validation result', async () => {
      const result = await sink.configure({});
      expect(typeof result.valid).toBe('boolean');
      if (!result.valid && result.errors) {
        expect(typeof result.errors).toBe('object');
      }
    });
  });
}

