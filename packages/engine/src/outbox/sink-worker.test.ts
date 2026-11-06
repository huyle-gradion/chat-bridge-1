import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SinkContract, Message, DeliveryOutcome, SinkLimits, ConfigureResult, TestResult, SinkHealthStatus } from '@chat-bridge/types';
import { Outbox } from './outbox.js';
import { SinkWorker } from './sink-worker.js';

class MockTestSink implements SinkContract {
  public readonly sinkId = 'mock-sink';
  public readonly name = 'Mock Sink';
  public limits: SinkLimits = {
    batchSize: 10,
    requestsPerMinute: 60,
    defaultBackoffMs: 1000,
  };

  public deliveredBatches: Message[][] = [];
  public nextOutcomes: ((batch: Message[]) => DeliveryOutcome[]) | null = null;

  public async configure(): Promise<ConfigureResult> {
    return { valid: true };
  }

  public async test(): Promise<TestResult> {
    return { ok: true, message: 'OK' };
  }

  public async health(): Promise<SinkHealthStatus> {
    return { health: 'ok', reason: 'Mock is healthy' };
  }

  public async deliver(batch: Message[]): Promise<DeliveryOutcome[]> {
    this.deliveredBatches.push(batch);
    if (this.nextOutcomes) {
      return this.nextOutcomes(batch);
    }
    return batch.map((m) => ({ messageId: m.id, outcome: 'accepted' }));
  }
}

describe('US-C5-01: Rate Pacing, Exponential Backoff & Refusal Isolation', () => {
  const testDbDir = path.join(process.cwd(), 'tmp-test-worker-c5');
  const testDbPath = path.join(testDbDir, 'outbox.db');
  const testKey = crypto.randomBytes(32);
  let outbox: Outbox;
  let sink: MockTestSink;
  let worker: SinkWorker;

  const sampleMessage: Message = {
    id: 'whatsapp:rep1:m1',
    network: 'whatsapp',
    account: 'rep1',
    thread: 'cust1',
    threadKind: 'dm',
    direction: 'inbound',
    time: new Date().toISOString(),
    from: { accountId: 'cust1', displayName: 'Customer' },
    to: [{ accountId: 'rep1', displayName: 'Rep' }],
    text: 'Test rate pacing message',
  };

  beforeEach(() => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    outbox = new Outbox({
      dbPath: testDbPath,
      masterKey: testKey,
    });

    sink = new MockTestSink();
    worker = new SinkWorker(sink, outbox, {
      maxJitterMs: 0, // deterministic in tests
    });
  });

  afterEach(() => {
    worker.stop();
    outbox.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('Scenario 1: Handling HTTP 429 (Rate Limit)', () => {
    it('pauses outbound requests for the instructed Retry-After duration plus jitter', async () => {
      await outbox.enqueue(sampleMessage, [sink.sinkId]);

      // Mock 429 rate limit with 2000ms retry-after
      sink.nextOutcomes = (batch) =>
        batch.map((m) => ({
          messageId: m.id,
          outcome: 'refused',
          statusCode: 429,
          retryAfterMs: 2000,
          reason: 'Rate limited. Retry after 2 seconds.',
        }));

      expect(worker.isPaused()).toBe(false);

      const processed = await worker.processBatch();
      expect(processed).toBe(1);
      expect(worker.isPaused()).toBe(true);

      // Attempting immediate second batch should be skipped because worker is paused
      const secondBatchProcessed = await worker.processBatch();
      expect(secondBatchProcessed).toBe(0);

      // Pending deliveries still exists in outbox
      const pendingCount = await outbox.getQueueCount(sink.sinkId);
      expect(pendingCount).toBe(1);

      // Deliveries should remain deferred until retry timer clears
      const deliveriesNow = await outbox.getPendingDeliveries(sink.sinkId, 10, Date.now());
      expect(deliveriesNow.length).toBe(0);

      // When fast-forwarding past the retry time, delivery is available again
      const deliveriesFuture = await outbox.getPendingDeliveries(sink.sinkId, 10, Date.now() + 3000);
      expect(deliveriesFuture.length).toBe(1);
      expect(deliveriesFuture[0]?.attempts).toBe(1);
    });
  });

  describe('Scenario 2: Handling Permanent Rejection (refused)', () => {
    it('does not retry permanently refused messages and marks them refused with reason', async () => {
      await outbox.enqueue(sampleMessage, [sink.sinkId]);

      // Permanent refusal (HTTP 401 / permission denied, not 429)
      sink.nextOutcomes = (batch) =>
        batch.map((m) => ({
          messageId: m.id,
          outcome: 'refused',
          statusCode: 401,
          reason: 'Unauthorized: Destination rejected credentials or payload schema',
        }));

      const processed = await worker.processBatch();
      expect(processed).toBe(1);

      // Worker should NOT be paused for normal non-429 refusal
      expect(worker.isPaused()).toBe(false);

      // Pending queue count must drop to 0 because message is marked refused (not pending)
      const pendingCount = await outbox.getQueueCount(sink.sinkId);
      expect(pendingCount).toBe(0);

      // Future queries must not return this message for delivery
      const deliveriesFuture = await outbox.getPendingDeliveries(sink.sinkId, 10, Date.now() + 100000);
      expect(deliveriesFuture.length).toBe(0);
    });
  });

  describe('Token Bucket rate pacing', () => {
    it('throttles execution when tokens are depleted', async () => {
      // Create a worker with capacity 2 tokens
      const pacedWorker = new SinkWorker(sink, outbox, {
        capacity: 2,
        refillRatePerSec: 1,
        maxJitterMs: 0,
      });

      // Enqueue 3 messages
      for (let i = 1; i <= 3; i++) {
        await outbox.enqueue(
          { ...sampleMessage, id: `whatsapp:rep1:m${i}` },
          [sink.sinkId]
        );
      }

      // Batch size 1 to consume 1 token per processBatch call
      sink.limits.batchSize = 1;

      // 1st token consumed
      const first = await pacedWorker.processBatch();
      expect(first).toBe(1);

      // 2nd token consumed
      const second = await pacedWorker.processBatch();
      expect(second).toBe(1);

      // 3rd token depleted
      const third = await pacedWorker.processBatch();
      expect(third).toBe(0);

      pacedWorker.stop();
    });
  });

  describe('Transient failures and exponential backoff', () => {
    it('applies exponential backoff on transient errors', async () => {
      await outbox.enqueue(sampleMessage, [sink.sinkId]);

      sink.nextOutcomes = () => {
        throw new Error('Network connection timeout');
      };

      const processed = await worker.processBatch();
      expect(processed).toBe(0);

      // Check delivery attempts incremented
      const pendingDeliveries = await outbox.getPendingDeliveries(sink.sinkId, 10, Date.now() + 10000);
      expect(pendingDeliveries.length).toBe(1);
      expect(pendingDeliveries[0]?.attempts).toBe(1);
    });
  });
});
