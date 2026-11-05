import { describe, it, expect } from 'vitest';
import type {
  Message,
  Person,
  SourceContract,
  SinkContract,
  SourceStatus,
  SinkHealthStatus,
  DeliveryOutcome,
  FilterDecision,
  OutboxItem,
} from './index.js';

describe('@chat-bridge/types', () => {
  it('validates canonical Message contract conforming to spec Section 5', () => {
    const sender: Person = {
      accountId: 'rep-001',
      displayName: 'Alice Rep',
      phone: '+84901234567',
    };

    const recipient: Person = {
      accountId: 'cust-999',
      displayName: 'Bob Customer',
      phone: '+84987654321',
      lid: 'bob-lid-456',
    };

    const message: Message = {
      id: 'zalo:rep-001:msg-1001',
      network: 'zalo',
      account: 'rep-001',
      thread: 'thread-dm-cust-999',
      threadKind: 'dm',
      direction: 'inbound',
      time: '2026-11-05T07:30:00.000Z',
      from: recipient,
      to: [sender],
      text: 'Hello, I would like to inquire about pricing.',
      placeholder: undefined,
      rawNativeId: 'msg-1001',
    };

    expect(message.id).toBe('zalo:rep-001:msg-1001');
    expect(message.network).toBe('zalo');
    expect(message.threadKind).toBe('dm');
    expect(message.direction).toBe('inbound');
    expect(message.from.displayName).toBe('Bob Customer');
    expect(message.from.phone).toBe('+84987654321');
  });

  it('validates SourceContract lifecycle and status shapes', async () => {
    const mockStatus: SourceStatus = {
      state: 'connected',
      reason: 'Connected to WhatsApp network',
      updatedAt: '2026-11-05T07:30:00.000Z',
      account: 'alice-wa',
    };

    const mockSource: SourceContract = {
      network: 'whatsapp',
      account: 'alice-wa',
      login: async () => mockStatus,
      start: async () => {},
      stop: async () => {},
      status: async () => mockStatus,
      chats: async () => [
        {
          id: 'wa-chat-1',
          network: 'whatsapp',
          account: 'alice-wa',
          name: 'Sales Inquiries',
          kind: 'group',
          participantCount: 5,
        },
      ],
      history: async () => [],
      send: async () => ({ ok: true, messageId: 'wa-reply-01' }),
    };

    expect(mockSource.network).toBe('whatsapp');
    const status = await mockSource.status();
    expect(status.state).toBe('connected');
    const chats = await mockSource.chats();
    expect(chats).toHaveLength(1);
    expect(chats[0]?.kind).toBe('group');
  });

  it('validates SinkContract delivery outcomes and limits shapes', async () => {
    const mockHealth: SinkHealthStatus = {
      health: 'ok',
      reason: 'Margince endpoint responding normally',
      consecutiveFailures: 0,
    };

    const mockSink: SinkContract = {
      sinkId: 'margince-primary',
      name: 'Margince CRM',
      limits: {
        batchSize: 50,
        requestsPerMinute: 120,
      },
      configure: async () => ({ valid: true }),
      test: async () => ({ ok: true, message: 'Margince connection verified successfully' }),
      deliver: async (batch: Message[]): Promise<DeliveryOutcome[]> => {
        return batch.map((m) => ({
          messageId: m.id,
          outcome: 'accepted' as const,
        }));
      },
      health: async () => mockHealth,
    };

    expect(mockSink.limits.batchSize).toBe(50);
    const testRes = await mockSink.test();
    expect(testRes.ok).toBe(true);

    const outcomes = await mockSink.deliver([
      {
        id: 'fake:rep-1:1',
        network: 'fake',
        account: 'rep-1',
        thread: 't1',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-05T07:30:00.000Z',
        from: { accountId: '1', displayName: 'Test' },
        to: [],
        text: 'Test',
      },
    ]);

    expect(outcomes[0]?.outcome).toBe('accepted');
  });

  it('validates FilterDecision and OutboxItem contracts', () => {
    const decision: FilterDecision = {
      drop: true,
      reason: 'otp_regex',
      ruleTriggered: 'Matched 6-digit numeric verification code',
    };

    expect(decision.drop).toBe(true);
    expect(decision.reason).toBe('otp_regex');

    const outboxItem: OutboxItem = {
      id: 'queue-001',
      messageId: 'fake:rep-1:1',
      sinkId: 'margince',
      payloadJson: '{"id":"fake:rep-1:1"}',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-11-05T07:30:00.000Z',
      createdAt: '2026-11-05T07:30:00.000Z',
      updatedAt: '2026-11-05T07:30:00.000Z',
    };

    expect(outboxItem.status).toBe('pending');
    expect(outboxItem.attempts).toBe(0);
  });
});

