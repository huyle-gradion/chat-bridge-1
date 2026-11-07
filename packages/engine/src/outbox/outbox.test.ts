import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Message } from '@chat-bridge/types';
import { Outbox } from './outbox.js';
import { encryptPayload, decryptPayload } from './encryption.js';

describe('US-C3-01: Encrypted Local Outbox & Crash Resilience', () => {
  let tempDir: string;
  let dbPath: string;
  let masterKey: Buffer;
  let outbox: Outbox;

  const sampleMessage: Message = {
    id: 'fake:rep-01:msg-101',
    network: 'fake',
    account: 'rep-01',
    thread: 'chat-cust-01',
    threadKind: 'dm',
    direction: 'inbound',
    time: '2026-11-06T10:00:00.000Z',
    from: { accountId: 'cust-01', displayName: 'Secret Client', phone: '+84901234567' },
    to: [{ accountId: 'rep-01', displayName: 'Dylan Rep' }],
    text: 'Confidential commercial contract terms for 2027.',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-outbox-'));
    dbPath = path.join(tempDir, 'outbox.db');
    masterKey = crypto.randomBytes(32);
    outbox = new Outbox({ dbPath, masterKey });
  });

  afterEach(() => {
    outbox.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Envelope Encryption & Privacy at Rest', () => {
    it('encrypts message payloads using AES-256-GCM', () => {
      const payload = { text: 'Secret message content', phone: '+84909998888' };
      const { ciphertext, iv, tag } = encryptPayload(payload, masterKey);

      expect(ciphertext).toBeInstanceOf(Buffer);
      expect(iv.length).toBe(12); // 96-bit IV
      expect(tag.length).toBe(16); // 128-bit tag

      const decrypted = decryptPayload<typeof payload>(ciphertext, iv, tag, masterKey);
      expect(decrypted).toEqual(payload);
    });

    it('stores message on disk in encrypted format without plaintext leaks', async () => {
      await outbox.enqueue(sampleMessage, ['sink-margince']);

      // Read raw SQLite file contents
      const rawDbBytes = fs.readFileSync(dbPath);
      const rawDbString = rawDbBytes.toString('utf-8');

      // Assert that plaintext secret content and phone number NEVER appear on disk
      expect(rawDbString.includes('Confidential commercial contract terms')).toBe(false);
      expect(rawDbString.includes('+84901234567')).toBe(false);
      expect(rawDbString.includes('Secret Client')).toBe(false);

      // Decrypted delivery contains the full original message
      const pending = await outbox.getPendingDeliveries('sink-margince');
      expect(pending.length).toBe(1);
      expect(pending[0]?.message.text).toBe(sampleMessage.text);
      expect(pending[0]?.message.from.phone).toBe('+84901234567');
    });

    it('fails decryption and detects tampering if ciphertext or tag is modified', () => {
      const { ciphertext, iv, tag } = encryptPayload({ text: 'Valid' }, masterKey);
      const tamperedCiphertext = Buffer.from(ciphertext);
      tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;

      expect(() => {
        decryptPayload(tamperedCiphertext, iv, tag, masterKey);
      }).toThrow();
    });
  });

  describe('Multi-Queue Independence & State Tracking', () => {
    it('creates independent pending deliveries for multiple active sinks', async () => {
      await outbox.enqueue(sampleMessage, ['sink-margince', 'sink-sheets']);

      const margincePending = await outbox.getPendingDeliveries('sink-margince');
      const sheetsPending = await outbox.getPendingDeliveries('sink-sheets');

      expect(margincePending.length).toBe(1);
      expect(sheetsPending.length).toBe(1);
      expect(await outbox.getQueueCount('sink-margince')).toBe(1);
      expect(await outbox.getQueueCount('sink-sheets')).toBe(1);

      // Acknowledging margince does not affect sheets
      await outbox.markDelivered(margincePending[0]!.deliveryId);

      expect(await outbox.getQueueCount('sink-margince')).toBe(0);
      expect(await outbox.getQueueCount('sink-sheets')).toBe(1);
    });

    it('updates retry attempts and backoff schedule on transient delivery failure', async () => {
      await outbox.enqueue(sampleMessage, ['sink-margince']);
      const pending = await outbox.getPendingDeliveries('sink-margince');
      const deliveryId = pending[0]!.deliveryId;

      const nextRetry = Date.now() + 5000;
      await outbox.markFailed(deliveryId, 'HTTP 503 Server Unavailable', nextRetry);

      // Should not be eligible for immediate delivery if nextRetry is in the future
      const immediatePending = await outbox.getPendingDeliveries('sink-margince', 50, Date.now());
      expect(immediatePending.length).toBe(0);

      // Eligible when current time surpasses nextRetry
      const futurePending = await outbox.getPendingDeliveries('sink-margince', 50, nextRetry + 100);
      expect(futurePending.length).toBe(1);
      expect(futurePending[0]?.attempts).toBe(1);
    });

    it('marks permanently refused deliveries without endless retries', async () => {
      await outbox.enqueue(sampleMessage, ['sink-margince']);
      const pending = await outbox.getPendingDeliveries('sink-margince');
      const deliveryId = pending[0]!.deliveryId;

      await outbox.markRefused(deliveryId, 'Invalid contact permissions');

      expect(await outbox.getQueueCount('sink-margince')).toBe(0);
      const allPending = await outbox.getPendingDeliveries('sink-margince', 50, Date.now() + 100000);
      expect(allPending.length).toBe(0);
    });
  });

  describe('Crash Resilience & WAL Recovery', () => {
    it('recovers all pending messages intact after sudden shutdown/restart', async () => {
      const msg1 = { ...sampleMessage, id: 'msg-crash-1' };
      const msg2 = { ...sampleMessage, id: 'msg-crash-2' };

      await outbox.enqueue(msg1, ['sink-margince']);
      await outbox.enqueue(msg2, ['sink-margince']);

      // Simulate crash: abrupt close
      outbox.close();

      // Reopen new Outbox instance on identical dbPath with masterKey
      const recoveredOutbox = new Outbox({ dbPath, masterKey });

      const pending = await recoveredOutbox.getPendingDeliveries('sink-margince');
      expect(pending.length).toBe(2);
      expect(pending[0]?.message.id).toBe('msg-crash-1');
      expect(pending[1]?.message.id).toBe('msg-crash-2');

      recoveredOutbox.close();
    });
  });

  describe('Health & Telemetry Read Queries (Feature C-9)', () => {
    it('reads per-sink queue stats, oldest pending age, retry counts, and recent failure age', async () => {
      const baseNow = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now');

      try {
        // Enqueue a refused message 6 minutes ago
        nowSpy.mockReturnValue(baseNow - 6 * 60 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-refused-1' }, ['sink-margince']);
        const refusedBatch = await outbox.getPendingDeliveries('sink-margince', 10, baseNow);
        await outbox.markRefused(refusedBatch[0]!.deliveryId, 'Invalid destination key');

        // Enqueue a pending message 45 seconds ago that failed transiently
        nowSpy.mockReturnValue(baseNow - 45 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-pending-1' }, ['sink-margince']);
        const pendingBatch = await outbox.getPendingDeliveries('sink-margince', 10, baseNow);
        await outbox.markFailed(
          pendingBatch[0]!.deliveryId,
          'Rate limit exceeded (HTTP 429)',
          baseNow + 15_000
        );

        const stats = await outbox.getSinkStats('sink-margince', baseNow, 15 * 60 * 1000);
        expect(stats.pendingCount).toBe(1);
        expect(stats.inFlightCount).toBe(0);
        expect(stats.deadLetterCount).toBe(1);
        expect(stats.oldestPendingAgeSeconds).toBe(45);
        expect(stats.retryingCount).toBe(1);
        expect(stats.unrecoveredFailureCount).toBe(1);
        expect(stats.oldestUnrecoveredFailureAgeMs).toBe(6 * 60 * 1000);
        expect(stats.lastError).toBeDefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('ignores failures older than the 15-minute window and resets unrecovered failures after a delivery', async () => {
      const baseNow = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now');

      try {
        // Refusal 20 minutes ago (outside 15-minute window)
        nowSpy.mockReturnValue(baseNow - 20 * 60 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-old-refused' }, ['sink-margince']);
        const oldBatch = await outbox.getPendingDeliveries('sink-margince', 10, baseNow);
        await outbox.markRefused(oldBatch[0]!.deliveryId, 'Stale error');

        const afterOldStats = await outbox.getSinkStats('sink-margince', baseNow, 15 * 60 * 1000);
        expect(afterOldStats.deadLetterCount).toBe(0);
        expect(afterOldStats.unrecoveredFailureCount).toBe(0);
        expect(afterOldStats.oldestUnrecoveredFailureAgeMs).toBe(0);
        expect(await outbox.getRecentErrorCount(15 * 60 * 1000, baseNow)).toBe(0);

        // Refusal 6 minutes ago followed by a successful delivery 2 minutes ago
        nowSpy.mockReturnValue(baseNow - 6 * 60 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-refused-recent' }, ['sink-margince']);
        const recentBatch = await outbox.getPendingDeliveries('sink-margince', 10, baseNow);
        await outbox.markRefused(recentBatch[0]!.deliveryId, 'Temporary auth issue');

        nowSpy.mockReturnValue(baseNow - 2 * 60 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-delivered-after' }, ['sink-margince']);
        const okBatch = await outbox.getPendingDeliveries('sink-margince', 10, baseNow);
        await outbox.markDelivered(okBatch[0]!.deliveryId);

        const recoveredStats = await outbox.getSinkStats('sink-margince', baseNow, 15 * 60 * 1000);
        expect(recoveredStats.deadLetterCount).toBe(1);
        expect(recoveredStats.unrecoveredFailureCount).toBe(0);
        expect(recoveredStats.oldestUnrecoveredFailureAgeMs).toBe(0);
        expect(await outbox.getRecentErrorCount(15 * 60 * 1000, baseNow)).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('counts messages enqueued within the last minute for messagesPerMinute', async () => {
      const baseNow = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now');

      try {
        // Message from 3 minutes ago (outside 1-minute window)
        nowSpy.mockReturnValue(baseNow - 3 * 60 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-3m-ago' }, ['sink-margince']);

        // Two messages within the last 60 seconds
        nowSpy.mockReturnValue(baseNow - 30 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-30s-ago' }, ['sink-margince']);
        nowSpy.mockReturnValue(baseNow - 5 * 1000);
        await outbox.enqueue({ ...sampleMessage, id: 'msg-5s-ago' }, ['sink-margince']);

        const recentMessages = await outbox.getRecentMessageCount(60 * 1000, baseNow);
        expect(recentMessages).toBe(2);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
