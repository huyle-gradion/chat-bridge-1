import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { Message } from '@chat-bridge/types';
import { FeedStore } from './feed-store.js';
import { ChatPicker } from './chat-picker.js';
import { Outbox } from '../outbox/outbox.js';

describe('US-C8-02: FeedStore & Ad-Hoc One-Off Message Forwarding', () => {
  let tempDir: string;
  let dbPath: string;
  let outboxPath: string;
  let rosterPath: string;
  let feedStore: FeedStore;
  let chatPicker: ChatPicker;
  let outbox: Outbox;
  let masterKey: Buffer;

  const createSampleMessage = (id: string, thread: string, text: string): Message => ({
    id,
    network: 'whatsapp',
    account: 'rep-phone-1',
    thread,
    threadKind: 'dm',
    direction: 'inbound',
    time: new Date().toISOString(),
    from: {
      accountId: thread,
      displayName: `User ${thread}`,
      phone: '84912345678',
    },
    to: [
      {
        accountId: 'rep-phone-1',
        displayName: 'Sales Rep',
      },
    ],
    text,
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'feed-store-test-'));
    dbPath = join(tempDir, 'feed.db');
    outboxPath = join(tempDir, 'outbox.db');
    rosterPath = join(tempDir, 'roster.db');
    masterKey = crypto.randomBytes(32);

    feedStore = new FeedStore({ dbPath, masterKey });
    chatPicker = new ChatPicker({ dbPath: rosterPath });
    outbox = new Outbox({ dbPath: outboxPath, masterKey });
  });

  afterEach(() => {
    feedStore.close();
    chatPicker.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Scenario 1: Real-time status display in Feed with AES-256-GCM encryption', () => {
    it('records and returns messages with correct plain-language status badges', () => {
      const msg1 = createSampleMessage('msg-1', 'chat-1', 'Sent order');
      const msg2 = createSampleMessage('msg-2', 'chat-2', 'Waiting in outbox');
      const msg3 = createSampleMessage('msg-3', 'chat-3', 'Ma OTP: 1234');
      const msg4 = createSampleMessage('msg-4', 'chat-4', 'Private personal chat');

      feedStore.recordMessage(msg1, 'sent');
      feedStore.recordMessage(msg2, 'sending');
      feedStore.recordMessage(msg3, 'filtered', 'otp_regex');
      feedStore.recordMessage(msg4, 'unpicked');

      const feed = feedStore.listFeed();
      expect(feed).toHaveLength(4);

      const item1 = feed.find((f) => f.message.id === 'msg-1');
      expect(item1?.status).toBe('sent');
      expect(item1?.userFacingLabel).toBe('Sent');

      const item2 = feed.find((f) => f.message.id === 'msg-2');
      expect(item2?.status).toBe('sending');
      expect(item2?.userFacingLabel).toBe('Sending');

      const item3 = feed.find((f) => f.message.id === 'msg-3');
      expect(item3?.status).toBe('filtered');
      expect(item3?.userFacingLabel).toBe('Blocked by filter');
      expect(item3?.ruleTriggered).toBe('otp_regex');

      const item4 = feed.find((f) => f.message.id === 'msg-4');
      expect(item4?.status).toBe('unpicked');
      expect(item4?.userFacingLabel).toBe('Not chosen');
    });

    it('encrypts message payloads with AES-256-GCM on disk and verifies zero cleartext PII', () => {
      const secretText = 'Customer confidential quote 10,000 USD';
      const secretPhone = '84988776655';
      const msg = createSampleMessage('msg-secret', 'chat-sec', secretText);
      msg.from.phone = secretPhone;

      feedStore.recordMessage(msg, 'sent');

      // Direct inspection of SQLite database rows
      const rawDb = new Database(dbPath);
      const rawRow = rawDb.prepare(`SELECT * FROM feed_messages WHERE id = 'msg-secret'`).get() as {
        ciphertext: Buffer;
        iv: Buffer;
        tag: Buffer;
      };
      rawDb.close();

      expect(rawRow).toBeDefined();
      expect(Buffer.isBuffer(rawRow.ciphertext)).toBe(true);

      // Verify cleartext phone and message are NOT stored in SQLite columns
      const rawDump = rawRow.ciphertext.toString('utf-8');
      expect(rawDump.includes(secretText)).toBe(false);
      expect(rawDump.includes(secretPhone)).toBe(false);

      // Retrievable and decryptable only with master key
      const decrypted = feedStore.getMessage('msg-secret');
      expect(decrypted?.message.text).toBe(secretText);
      expect(decrypted?.message.from.phone).toBe(secretPhone);
    });
  });

  describe('Scenario 2: Ad-Hoc "Send these messages" action', () => {
    it('selectively forwards chosen unpicked messages to outbox while keeping chat unticked', async () => {
      const untickedThread = 'unapproved_contact@s.whatsapp.net';

      // Chat is not ticked in ChatPicker
      chatPicker.upsertChat({
        id: untickedThread,
        network: 'whatsapp',
        account: 'rep-phone-1',
        name: 'Potential Client',
        kind: 'dm',
        isTicked: false,
      });
      expect(chatPicker.isChatTicked(untickedThread)).toBe(false);

      // Three messages arrive in the unpicked chat
      const msg1 = createSampleMessage('msg-unpicked-1', untickedThread, 'Can you send product details?');
      const msg2 = createSampleMessage('msg-unpicked-2', untickedThread, 'Here is our budget');
      const msg3 = createSampleMessage('msg-unpicked-3', untickedThread, 'Personal weekend plan');

      // Evaluated as unpicked in Stage 3 and recorded in feed
      feedStore.recordMessage(msg1, 'unpicked');
      feedStore.recordMessage(msg2, 'unpicked');
      feedStore.recordMessage(msg3, 'unpicked');

      // Charlotte checks msg1 and msg2 and clicks "Send selected to Margince"
      const forwardResult = await feedStore.forwardAdHoc(
        ['msg-unpicked-1', 'msg-unpicked-2'],
        ['margince-crm'],
        outbox
      );

      expect(forwardResult.enqueuedCount).toBe(2);
      expect(forwardResult.errors).toHaveLength(0);

      // Verify that outbox received msg1 and msg2
      const pendingDeliveries = await outbox.getPendingDeliveries('margince-crm');
      expect(pendingDeliveries).toHaveLength(2);
      const enqueuedIds = pendingDeliveries.map((p) => p.message.id);
      expect(enqueuedIds).toContain('msg-unpicked-1');
      expect(enqueuedIds).toContain('msg-unpicked-2');
      expect(enqueuedIds).not.toContain('msg-unpicked-3');

      // Verify that forwarded messages are now marked "sending" in the feed
      const item1 = feedStore.getMessage('msg-unpicked-1');
      expect(item1?.status).toBe('sending');
      expect(item1?.userFacingLabel).toBe('Sending');

      const item3 = feedStore.getMessage('msg-unpicked-3');
      expect(item3?.status).toBe('unpicked');
      expect(item3?.userFacingLabel).toBe('Not chosen');

      // Verify that the conversation remains strictly unticked!
      expect(chatPicker.isChatTicked(untickedThread)).toBe(false);

      // Subsequent message from same thread still evaluates as unpicked
      const msg4 = createSampleMessage('msg-unpicked-4', untickedThread, 'Another message');
      const decision = chatPicker.evaluateMessage(msg4);
      expect(decision.authorized).toBe(false);
      expect(decision.reason).toBe('unticked_chat');
    });
  });

  describe('Retention TTL & Storage Cleanup', () => {
    it('prunes messages older than 7 days', () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      const oldMsg = createSampleMessage('old-1', 'chat-old', 'Old conversation');
      const newMsg = createSampleMessage('new-1', 'chat-new', 'Fresh conversation');

      feedStore.recordMessage(oldMsg, 'sent', undefined, eightDaysAgo);
      feedStore.recordMessage(newMsg, 'sent', undefined, now);

      expect(feedStore.listFeed()).toHaveLength(2);

      const pruned = feedStore.pruneExpired(7 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(1);

      const remaining = feedStore.listFeed();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.message.id).toBe('new-1');
    });
  });
});
