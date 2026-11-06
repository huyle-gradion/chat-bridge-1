import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
