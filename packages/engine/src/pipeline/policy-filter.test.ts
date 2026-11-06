import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { Message } from '@chat-bridge/types';
import { PolicyFilter } from './policy-filter.js';
import { Outbox } from '../outbox/outbox.js';

describe('US-C2-01: PolicyFilter (Stage 4 Sensitive Data, Contact & Group Filters)', () => {
  let tempDir: string;
  let outboxPath: string;
  let outbox: Outbox;
  let masterKey: Buffer;
  let filter: PolicyFilter;

  const createSampleMessage = (options: {
    thread?: string;
    threadKind?: 'dm' | 'group';
    text: string;
    accountId?: string;
    phone?: string;
  }): Message => ({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    network: 'whatsapp',
    account: 'rep-phone-1',
    thread: options.thread ?? '84901234567@s.whatsapp.net',
    threadKind: options.threadKind ?? 'dm',
    direction: 'inbound',
    time: new Date().toISOString(),
    from: {
      accountId: options.accountId ?? options.thread ?? '84901234567@s.whatsapp.net',
      displayName: 'Customer',
      phone: options.phone ?? '84901234567',
    },
    to: [
      {
        accountId: 'rep-phone-1',
        displayName: 'Sales Rep',
      },
    ],
    text: options.text,
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'policy-filter-test-'));
    outboxPath = join(tempDir, 'outbox.db');
    masterKey = crypto.randomBytes(32);
    outbox = new Outbox({ dbPath: outboxPath, masterKey });
    filter = new PolicyFilter();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Scenario 1: OTP and Verification Code Blocking (Active by Default)', () => {
    it('blocks English verification codes by default and prevents outbox queuing', async () => {
      const message = createSampleMessage({
        text: 'Your verification code is 849201. Please do not share this with anyone.',
      });

      const decision = filter.evaluate(message);
      expect(decision.drop).toBe(true);
      expect(decision.reason).toBe('otp_regex');
      expect(decision.userFacingLabel).toBe('Blocked: Security code detected');

      // Verify zero outbox queueing
      if (!decision.drop) {
        await outbox.enqueue(message, ['margince-crm']);
      }
      const pending = await outbox.getPendingDeliveries('margince-crm');
      expect(pending).toHaveLength(0);
    });

    it('blocks Vietnamese OTP messages with and without diacritics', () => {
      const msg1 = createSampleMessage({ text: 'Ma OTP cua ban la 1234' });
      const dec1 = filter.evaluate(msg1);
      expect(dec1.drop).toBe(true);
      expect(dec1.reason).toBe('otp_regex');
      expect(dec1.userFacingLabel).toBe('Blocked: Security code detected');

      const msg2 = createSampleMessage({ text: 'Mã xác thực của bạn là: 890123' });
      const dec2 = filter.evaluate(msg2);
      expect(dec2.drop).toBe(true);
      expect(dec2.reason).toBe('otp_regex');

      const msg3 = createSampleMessage({ text: 'Ma xac thuc: 567890' });
      const dec3 = filter.evaluate(msg3);
      expect(dec3.drop).toBe(true);
      expect(dec3.reason).toBe('otp_regex');
    });

    it('allows normal business conversation texts without security codes', () => {
      const message = createSampleMessage({
        text: 'Please send me the quote for 25 units. We can sign the agreement tomorrow.',
      });

      const decision = filter.evaluate(message);
      expect(decision.drop).toBe(false);
      expect(decision.reason).toBeUndefined();
    });

    it('allows security codes when OTP filter is explicitly toggled off', () => {
      filter.setOtpFilterEnabled(false);
      const message = createSampleMessage({
        text: 'Your verification code is 849201',
      });

      const decision = filter.evaluate(message);
      expect(decision.drop).toBe(false);
    });
  });

  describe('Scenario 2: Group Chats Disabled by Default', () => {
    it('drops messages from group chats by default', () => {
      const groupMessage = createSampleMessage({
        thread: '120363021111111111@g.us',
        threadKind: 'group',
        text: 'Good morning everyone, let us discuss quarterly targets.',
      });

      const decision = filter.evaluate(groupMessage);
      expect(decision.drop).toBe(true);
      expect(decision.reason).toBe('group_disabled');
      expect(decision.userFacingLabel).toBe('Blocked: Group chats disabled');
    });

    it('allows group messages when global group forwarding is toggled on', () => {
      filter.setAllowGroups(true);
      expect(filter.isAllowGroups()).toBe(true);

      const groupMessage = createSampleMessage({
        thread: '120363021111111111@g.us',
        threadKind: 'group',
        text: 'Project team update: deployment successful.',
      });

      const decision = filter.evaluate(groupMessage);
      expect(decision.drop).toBe(false);
      expect(decision.reason).toBeUndefined();
    });
  });

  describe('Scenario 3: Specific Contact Blocking', () => {
    it('blocks messages from contacts on the blocked list by accountId', () => {
      const blockedId = 'spammer_9988@s.whatsapp.net';
      filter.blockContact(blockedId);
      expect(filter.isContactBlocked(blockedId)).toBe(true);

      const message = createSampleMessage({
        accountId: blockedId,
        text: 'Check out this special promotion today!',
      });

      const decision = filter.evaluate(message);
      expect(decision.drop).toBe(true);
      expect(decision.reason).toBe('blocked_contact');
      expect(decision.userFacingLabel).toBe('Blocked: Contact on blocklist');
    });

    it('blocks messages by phone number matching', () => {
      filter.blockContact('+84909112233');

      // Incoming message has matching normalized phone number
      const message = createSampleMessage({
        accountId: 'some_user_id',
        phone: '84909112233',
        text: 'Hello from blocked phone',
      });

      const decision = filter.evaluate(message);
      expect(decision.drop).toBe(true);
      expect(decision.reason).toBe('blocked_contact');
      expect(decision.userFacingLabel).toBe('Blocked: Contact on blocklist');
    });

    it('allows messages after a contact is unblocked', () => {
      const contact = '84912345678';
      filter.blockContact(contact);
      expect(filter.isContactBlocked(contact)).toBe(true);

      filter.unblockContact(contact);
      expect(filter.isContactBlocked(contact)).toBe(false);

      const message = createSampleMessage({
        phone: contact,
        text: 'I am back in touch',
      });

      const decision = filter.evaluate(message);
      expect(decision.drop).toBe(false);
    });
  });

  describe('Custom Blocked Patterns', () => {
    it('blocks messages matching user-defined custom patterns', () => {
      filter.addCustomBlockedPattern('\\bCONFIDENTIAL\\b');

      const msg = createSampleMessage({
        text: 'This is a CONFIDENTIAL internal document.',
      });

      const decision = filter.evaluate(msg);
      expect(decision.drop).toBe(true);
      expect(decision.reason).toBe('otp_regex'); // or pattern filter
    });
  });
});
