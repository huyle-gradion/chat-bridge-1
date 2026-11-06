import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SinkContract, Message, DeliveryOutcome, SinkLimits, ConfigureResult, TestResult, SinkHealthStatus } from '@chat-bridge/types';
import { Outbox } from './outbox.js';
import { FanOutDispatcher } from './fanout-dispatcher.js';

class MockDestinationSink implements SinkContract {
  public deliveredBatches: Message[][] = [];
  public shouldFail: boolean = false;
  public failureReason: string = 'Connection failed';

  constructor(
    public readonly sinkId: string,
    public readonly name: string,
    public readonly limits: SinkLimits = { batchSize: 10, requestsPerMinute: 60, defaultBackoffMs: 1000 }
  ) {}

  public async configure(): Promise<ConfigureResult> {
    return { valid: true };
  }

  public async test(): Promise<TestResult> {
    return { ok: true, message: 'OK' };
  }

  public async health(): Promise<SinkHealthStatus> {
    return { health: this.shouldFail ? 'down' : 'ok', reason: 'Mock status' };
  }

  public async deliver(batch: Message[]): Promise<DeliveryOutcome[]> {
    if (this.shouldFail) {
      throw new Error(this.failureReason);
    }
    this.deliveredBatches.push(batch);
    return batch.map((m) => ({ messageId: m.id, outcome: 'accepted' }));
  }
}

describe('US-K0-01: Independent Multi-Destination Fan-Out', () => {
  const testDbDir = path.join(process.cwd(), 'tmp-test-fanout');
  const testDbPath = path.join(testDbDir, 'outbox.db');
  const testKey = crypto.randomBytes(32);
  let outbox: Outbox;
  let dispatcher: FanOutDispatcher;

  let marginceSink: MockDestinationSink;
  let sheetsSink: MockDestinationSink;
  let localDbSink: MockDestinationSink;

  const sampleMessage: Message = {
    id: 'whatsapp:rep-01:msg-fanout-1',
    network: 'whatsapp',
    account: 'rep-01',
    thread: 'cust-10',
    threadKind: 'dm',
    direction: 'inbound',
    time: new Date().toISOString(),
    from: { accountId: 'cust-10', displayName: 'Customer Ten' },
    to: [{ accountId: 'rep-01', displayName: 'Rep Dylan' }],
    text: 'Multi-destination broadcast message',
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

    dispatcher = new FanOutDispatcher(outbox);

    marginceSink = new MockDestinationSink('margince', 'Margince CRM');
    sheetsSink = new MockDestinationSink('sheets', 'Google Sheets');
    localDbSink = new MockDestinationSink('local-db', 'Local Database');

    dispatcher.registerSink(marginceSink, { maxJitterMs: 0, baseBackoffMs: 0 });
    dispatcher.registerSink(sheetsSink, { maxJitterMs: 0, baseBackoffMs: 0 });
    dispatcher.registerSink(localDbSink, { maxJitterMs: 0, baseBackoffMs: 0 });
  });

  afterEach(() => {
    dispatcher.stop();
    outbox.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  describe('Scenario 1: One destination down does not block others', () => {
    it('delivers immediately to healthy destinations while failing destination remains queued', async () => {
      // Sheets has an invalid token and fails
      sheetsSink.shouldFail = true;
      sheetsSink.failureReason = 'Invalid OAuth token';

      await dispatcher.dispatch(sampleMessage);

      // Process batches across all registered sinks
      await dispatcher.processAll();

      // Margince and Local Database received the message
      expect(marginceSink.deliveredBatches.length).toBe(1);
      expect(marginceSink.deliveredBatches[0]?.[0]?.id).toBe(sampleMessage.id);

      expect(localDbSink.deliveredBatches.length).toBe(1);
      expect(localDbSink.deliveredBatches[0]?.[0]?.id).toBe(sampleMessage.id);

      // Sheets attempted delivery and failed
      expect(sheetsSink.deliveredBatches.length).toBe(0);

      // Check queues in Outbox: Margince & Local Database queues are clear (0 pending)
      expect(await outbox.getQueueCount('margince')).toBe(0);
      expect(await outbox.getQueueCount('local-db')).toBe(0);

      // Sheets queue still has 1 pending message
      expect(await outbox.getQueueCount('sheets')).toBe(1);

      // Message is not complete because Sheets has not finished
      const isComplete = await dispatcher.isMessageComplete(sampleMessage.id);
      expect(isComplete).toBe(false);

      // When Sheets recovers (e.g. re-authenticated)
      sheetsSink.shouldFail = false;
      await dispatcher.processAll();

      // Now Sheets receives the message
      expect(sheetsSink.deliveredBatches.length).toBe(1);
      expect(await outbox.getQueueCount('sheets')).toBe(0);

      // Now all destinations have completed
      expect(await dispatcher.isMessageComplete(sampleMessage.id)).toBe(true);
    });
  });

  describe('Scenario 2: Message completion lifecycle', () => {
    it('marks message complete only after all sinks deliver and purges completed rows', async () => {
      await dispatcher.dispatch(sampleMessage);

      // Before processing, message is not complete
      expect(await dispatcher.isMessageComplete(sampleMessage.id)).toBe(false);

      // Deliver all
      await dispatcher.processAll();

      // Now all 3 delivered
      expect(await dispatcher.isMessageComplete(sampleMessage.id)).toBe(true);

      // Purge completed messages
      const purgedCount = await dispatcher.purgeCompleted(0);
      expect(purgedCount).toBe(1);

      // Total queue count across all sinks is 0
      expect(await outbox.getQueueCount()).toBe(0);
    });

    it('does not purge messages if at least one destination is pending', async () => {
      sheetsSink.shouldFail = true;

      await dispatcher.dispatch(sampleMessage);
      await dispatcher.processAll();

      expect(await dispatcher.isMessageComplete(sampleMessage.id)).toBe(false);

      // Purge attempt should delete 0 messages
      const purgedCount = await dispatcher.purgeCompleted(0);
      expect(purgedCount).toBe(0);

      // Still queued in sheets
      expect(await outbox.getQueueCount('sheets')).toBe(1);
    });
  });
});
