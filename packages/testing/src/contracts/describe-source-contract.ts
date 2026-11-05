import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SourceContract } from '@chat-bridge/types';

/**
 * Parameterized contract test suite for any SourceContract provider.
 * Guarantees that Fake, Zalo, and WhatsApp satisfy identical lifecycle and behavioral contracts.
 * Spec Section 6 & ADR 0018.
 */
export function describeSourceContract(
  providerName: string,
  factory: () => Promise<SourceContract> | SourceContract
) {
  describe(`SourceContract Conformance: ${providerName}`, () => {
    let source: SourceContract;

    beforeEach(async () => {
      source = await factory();
    });

    afterEach(async () => {
      await source.stop();
    });

    it('declares valid network kind and rep account', () => {
      expect(['zalo', 'whatsapp', 'whatsapp-biz', 'fake']).toContain(source.network);
      expect(typeof source.account).toBe('string');
      expect(source.account.length).toBeGreaterThan(0);
    });

    it('reports valid initial connection status in plain language', async () => {
      const status = await source.status();
      expect(['connected', 'needs-login', 'taken-over', 'error']).toContain(status.state);
      expect(typeof status.reason).toBe('string');
      expect(status.reason.length).toBeGreaterThan(0);
      expect(typeof status.updatedAt).toBe('string');
    });

    it('handles idempotent start() and stop() calls cleanly', async () => {
      const receivedMessages: unknown[] = [];
      const onMsg = (msg: unknown) => {
        receivedMessages.push(msg);
      };

      // Start once
      await source.start(onMsg);
      // Start again (must be idempotent no-op)
      await source.start(onMsg);

      // Stop once
      await source.stop();
      // Stop again (must be idempotent no-op)
      await source.stop();
    });

    it('returns formatted thread summaries for the Chat Picker', async () => {
      const chats = await source.chats();
      expect(Array.isArray(chats)).toBe(true);

      for (const chat of chats) {
        expect(typeof chat.id).toBe('string');
        expect(['dm', 'group']).toContain(chat.kind);
        expect(typeof chat.name).toBe('string');
        expect(chat.network).toBe(source.network);
        expect(chat.account).toBe(source.account);
      }
    });

    it('validates send() parameters and returns structured SendResult', async () => {
      const result = await source.send('test-thread', 'Hello world');
      expect(typeof result.ok).toBe('boolean');
      if (result.ok) {
        expect(typeof result.messageId).toBe('string');
      } else {
        expect(typeof result.error).toBe('string');
      }
    });
  });
}

