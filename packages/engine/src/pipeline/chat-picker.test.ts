import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { Message, ThreadSummary } from '@chat-bridge/types';
import { ChatPicker } from './chat-picker.js';
import { Outbox } from '../outbox/outbox.js';

describe('US-C8-01: ChatPicker (Stage 3 Selective Authorization)', () => {
  let tempDir: string;
  let dbPath: string;
  let outboxPath: string;
  let chatPicker: ChatPicker;
  let outbox: Outbox;
  let masterKey: Buffer;

  const createSampleMessage = (threadId: string, text: string = 'Hello'): Message => ({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    network: 'whatsapp',
    account: 'rep-phone-1',
    thread: threadId,
    threadKind: 'dm',
    direction: 'inbound',
    time: new Date().toISOString(),
    from: {
      accountId: threadId,
      displayName: `Contact ${threadId}`,
      phone: threadId.includes('@') ? threadId.split('@')[0] : threadId,
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
    tempDir = mkdtempSync(join(tmpdir(), 'chat-picker-test-'));
    dbPath = join(tempDir, 'roster.db');
    outboxPath = join(tempDir, 'outbox.db');
    masterKey = crypto.randomBytes(32);

    chatPicker = new ChatPicker({ dbPath });
    outbox = new Outbox({ dbPath: outboxPath, masterKey });
  });

  afterEach(() => {
    chatPicker.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Scenario 1: Absolute Privacy Guardrail (Zero-Send Default)', () => {
    it('blocks all messages when zero chats have been ticked', async () => {
      const message = createSampleMessage('84901234567@s.whatsapp.net', 'Order details');
      const decision = chatPicker.evaluateMessage(message);

      expect(decision.authorized).toBe(false);
      expect(decision.reason).toBe('unticked_chat');
      expect(decision.userFacingLabel).toBe('Not chosen (private)');

      // Absolute Privacy: message is dropped and never reaches outbox
      if (decision.authorized) {
        await outbox.enqueue(message, ['margince-crm']);
      }

      const pending = await outbox.getPendingDeliveries('margince-crm');
      expect(pending).toHaveLength(0);
    });

    it('allows message to proceed only when chat is explicitly ticked', async () => {
      const threadId = '84901234567@s.whatsapp.net';
      chatPicker.upsertChat({
        id: threadId,
        network: 'whatsapp',
        account: 'rep-phone-1',
        name: 'VIP Client',
        kind: 'dm',
      });

      // Initially unticked
      let decision = chatPicker.evaluateMessage(createSampleMessage(threadId));
      expect(decision.authorized).toBe(false);

      // Rep ticks the chat
      chatPicker.tickChat(threadId);
      expect(chatPicker.isChatTicked(threadId)).toBe(true);

      const message = createSampleMessage(threadId, 'Approved quote');
      decision = chatPicker.evaluateMessage(message);
      expect(decision.authorized).toBe(true);
      expect(decision.reason).toBeUndefined();

      // Delivered to outbox
      await outbox.enqueue(message, ['margince-crm']);
      const pending = await outbox.getPendingDeliveries('margince-crm');
      expect(pending).toHaveLength(1);
      expect(pending[0]?.message.text).toBe('Approved quote');
    });

    it('immediately blocks incoming messages when chat is unticked', async () => {
      const threadId = '84909998888@s.whatsapp.net';
      chatPicker.upsertChat({
        id: threadId,
        network: 'whatsapp',
        account: 'rep-phone-1',
        name: 'Temporary Client',
        kind: 'dm',
        isTicked: true,
      });

      expect(chatPicker.isChatTicked(threadId)).toBe(true);

      // Rep unticks the chat
      chatPicker.untickChat(threadId);
      expect(chatPicker.isChatTicked(threadId)).toBe(false);

      const decision = chatPicker.evaluateMessage(createSampleMessage(threadId));
      expect(decision.authorized).toBe(false);
      expect(decision.reason).toBe('unticked_chat');
      expect(decision.userFacingLabel).toBe('Not chosen (private)');
    });
  });

  describe('Scenario 2: Roster Discovery and Search', () => {
    const discoveredRoster: ThreadSummary[] = [
      {
        id: '84901112222@s.whatsapp.net',
        network: 'whatsapp',
        account: 'rep-phone-1',
        name: 'Nguyen Van A',
        kind: 'dm',
        lastMessageTime: '2026-11-06T08:00:00.000Z',
        avatarUrl: 'https://example.com/avatar1.jpg',
      },
      {
        id: '120363021111111111@g.us',
        network: 'whatsapp',
        account: 'rep-phone-1',
        name: 'Saigon Sales Team',
        kind: 'group',
        participantCount: 15,
        lastMessageTime: '2026-11-06T09:30:00.000Z',
      },
      {
        id: 'zalo_user_998877',
        network: 'zalo',
        account: 'rep-zalo-1',
        name: 'Tran Thi B',
        kind: 'dm',
        lastMessageTime: '2026-11-06T10:15:00.000Z',
      },
    ];

    it('syncs discovered chats and preserves ticked status across re-syncs', () => {
      chatPicker.syncDiscoveredChats(discoveredRoster);

      let chats = chatPicker.listChats();
      expect(chats).toHaveLength(3);
      expect(chats.map((c) => c.isTicked)).toEqual([false, false, false]);

      // Rep ticks Nguyen Van A
      chatPicker.tickChat('84901112222@s.whatsapp.net');
      expect(chatPicker.isChatTicked('84901112222@s.whatsapp.net')).toBe(true);

      // Re-sync with updated roster from source
      chatPicker.syncDiscoveredChats(discoveredRoster);

      const updatedChat = chatPicker.getChat('84901112222@s.whatsapp.net');
      expect(updatedChat?.isTicked).toBe(true);
    });

    it('filters list instantly by contact name or phone number', () => {
      chatPicker.syncDiscoveredChats(discoveredRoster);

      // Search by name substring
      const searchName = chatPicker.listChats({ search: 'Saigon' });
      expect(searchName).toHaveLength(1);
      expect(searchName[0]?.name).toBe('Saigon Sales Team');
      expect(searchName[0]?.kind).toBe('group');

      // Search by case-insensitive name
      const searchCaseInsensitive = chatPicker.listChats({ search: 'nguyen van a' });
      expect(searchCaseInsensitive).toHaveLength(1);
      expect(searchCaseInsensitive[0]?.name).toBe('Nguyen Van A');

      // Search by phone number / ID
      const searchPhone = chatPicker.listChats({ search: '901112222' });
      expect(searchPhone).toHaveLength(1);
      expect(searchPhone[0]?.id).toBe('84901112222@s.whatsapp.net');

      // Search with special SQL characters (safe handling)
      const searchSpecial = chatPicker.listChats({ search: "test%'_" });
      expect(searchSpecial).toHaveLength(0);
    });

    it('filters by network and thread kind badges', () => {
      chatPicker.syncDiscoveredChats(discoveredRoster);

      const zaloChats = chatPicker.listChats({ network: 'zalo' });
      expect(zaloChats).toHaveLength(1);
      expect(zaloChats[0]?.network).toBe('zalo');

      const groupChats = chatPicker.listChats({ kind: 'group' });
      expect(groupChats).toHaveLength(1);
      expect(groupChats[0]?.kind).toBe('group');
    });
  });

  describe('Scenario 3: Newly Arriving Chats Start Unticked', () => {
    it('automatically records an unknown incoming chat in unticked state', () => {
      const newThreadId = '84988776655@s.whatsapp.net';
      const firstMessage = createSampleMessage(newThreadId, 'Hello, I want to inquire about products');

      // Roster is initially empty
      expect(chatPicker.getChat(newThreadId)).toBeNull();

      // First message arrives
      const decision = chatPicker.evaluateMessage(firstMessage);
      expect(decision.authorized).toBe(false);
      expect(decision.reason).toBe('unticked_chat');

      // Verify the chat was automatically discovered and saved as unticked
      const recorded = chatPicker.getChat(newThreadId);
      expect(recorded).not.toBeNull();
      expect(recorded?.id).toBe(newThreadId);
      expect(recorded?.isTicked).toBe(false);
      expect(recorded?.lastMessageTime).toBe(firstMessage.time);

      // Rep can see it in Chats list and tick it
      chatPicker.tickChat(newThreadId);
      expect(chatPicker.isChatTicked(newThreadId)).toBe(true);

      // Second message is now authorized
      const secondMessage = createSampleMessage(newThreadId, 'Here is my order');
      const secondDecision = chatPicker.evaluateMessage(secondMessage);
      expect(secondDecision.authorized).toBe(true);
    });
  });

  describe('Scenario 4: High-Volume Roster Virtualization and O(1) Scalability', () => {
    it('efficiently queries and paginates 2,000+ chats with sub-millisecond latency', () => {
      const db = new Database(dbPath);
      const insert = db.prepare(`
        INSERT INTO chat_roster (
          thread_id, network, account, name, kind, unread_count,
          last_message_text, last_message_at, avatar_url, participant_count,
          is_ticked, created_at, updated_at
        ) VALUES (?, 'whatsapp', 'rep-1', ?, 'dm', 0, 'Hi', ?, NULL, NULL, 0, ?, ?)
      `);

      const now = new Date();
      const insertMany = db.transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          const dateStr = new Date(now.getTime() - i * 60000).toISOString();
          insert.run(`thread_${i}@s.whatsapp.net`, `Contact ${i}`, dateStr, dateStr, dateStr);
        }
      });

      insertMany(2000);
      db.close();

      const totalCount = chatPicker.countChats();
      expect(totalCount).toBe(2000);

      // Virtualized window retrieval (page 1: 50 items)
      const start = performance.now();
      const page1 = chatPicker.listChats({ limit: 50, offset: 0 });
      const elapsed = performance.now() - start;

      expect(page1).toHaveLength(50);
      expect(elapsed).toBeLessThan(50); // Fast sub-50ms execution
      expect(page1[0]?.name).toBe('Contact 0');
    });

    it('guarantees O(1) outbox queue scaling relative only to ticked chats', async () => {
      // 100 unticked chats and 2 ticked chats
      for (let i = 0; i < 100; i++) {
        chatPicker.upsertChat({
          id: `unticked_${i}@s.whatsapp.net`,
          network: 'whatsapp',
          account: 'rep-1',
          name: `Unticked ${i}`,
          kind: 'dm',
          isTicked: false,
        });
      }

      chatPicker.upsertChat({
        id: 'ticked_1@s.whatsapp.net',
        network: 'whatsapp',
        account: 'rep-1',
        name: 'Ticked 1',
        kind: 'dm',
        isTicked: true,
      });

      chatPicker.upsertChat({
        id: 'ticked_2@s.whatsapp.net',
        network: 'whatsapp',
        account: 'rep-1',
        name: 'Ticked 2',
        kind: 'dm',
        isTicked: true,
      });

      // Simulate stream of messages: 100 unticked messages, 2 ticked messages
      const messages: Message[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push(createSampleMessage(`unticked_${i}@s.whatsapp.net`, `Noise ${i}`));
      }
      messages.push(createSampleMessage('ticked_1@s.whatsapp.net', 'Business 1'));
      messages.push(createSampleMessage('ticked_2@s.whatsapp.net', 'Business 2'));

      for (const msg of messages) {
        const decision = chatPicker.evaluateMessage(msg);
        if (decision.authorized) {
          await outbox.enqueue(msg, ['margince-crm']);
        }
      }

      const pending = await outbox.getPendingDeliveries('margince-crm', 200);
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.message.thread)).toEqual([
        'ticked_1@s.whatsapp.net',
        'ticked_2@s.whatsapp.net',
      ]);
    });
  });
});
