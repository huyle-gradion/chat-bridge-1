import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LoginEvent, Message } from '@chat-bridge/types';
import { ZaloSource, type ZaloSourceOptions } from './zalo-source.js';
import { MockZaloAdapter } from './socket/mock-zalo-adapter.js';

describe('US-S2-01: Zalo QR Code Authentication & Session Guard', () => {
  const testDbDir = path.join(process.cwd(), 'tmp-test-zalo');
  const testDbPath = path.join(testDbDir, 'zalo-session.db');
  const testMasterKey = crypto.randomBytes(32);
  let mockAdapter: MockZaloAdapter;

  beforeEach(() => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    mockAdapter = new MockZaloAdapter();
  });

  afterEach(async () => {
    mockAdapter.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  function createSource(options: Partial<ZaloSourceOptions> = {}): ZaloSource {
    return new ZaloSource({
      dbPath: testDbPath,
      masterKey: testMasterKey,
      adapter: mockAdapter,
      ...options,
    });
  }

  describe('Scenario 1: Successful Zalo QR scan', () => {
    it('emits QR code event, encrypts session upon scan confirmation, and updates status', async () => {
      const source = createSource();
      const loginEvents: LoginEvent[] = [];

      const loginPromise = source.login((event) => {
        loginEvents.push(event);
      });

      // Emits QR event
      expect(loginEvents.length).toBeGreaterThanOrEqual(1);
      const qrEvent = loginEvents[0];
      expect(qrEvent?.type).toBe('qr');
      expect(qrEvent?.qrData).toBeDefined();
      expect(qrEvent?.message).toContain('Open Zalo on your phone -> Scan QR Code');

      // Simulate user scanning on mobile device
      mockAdapter.simulateScanSuccess({
        uid: 'zl-user-charlotte-01',
        displayName: 'Charlotte Nguyen',
        sessionToken: 'zpw_sek_mock_token_12345',
      });

      const finalStatus = await loginPromise;
      expect(finalStatus.state).toBe('connected');
      expect(finalStatus.account).toBe('zl-user-charlotte-01');
      expect(finalStatus.reason).toContain('Zalo connected');

      // Session token is encrypted in SQLite store
      expect(fs.existsSync(testDbPath)).toBe(true);
      const sessionCount = source.getSessionRecordCount();
      expect(sessionCount).toBeGreaterThan(0);
    });
  });

  describe('Scenario 2: Session takeover detection (Zalo Web conflict)', () => {
    it('detects session takeover, transitions to taken-over state, and displays plain-language alert', async () => {
      const source = createSource();
      const loginPromise = source.login();

      mockAdapter.simulateScanSuccess({
        uid: 'zl-user-charlotte-01',
        displayName: 'Charlotte Nguyen',
        sessionToken: 'zpw_sek_mock_token_12345',
      });
      await loginPromise;

      const connectedStatus = await source.status();
      expect(connectedStatus.state).toBe('connected');

      // Charlotte opens Zalo Web on another browser -> session invalidated
      mockAdapter.simulateTakeoverConflict();

      const takeoverStatus = await source.status();
      expect(takeoverStatus.state).toBe('taken-over');
      expect(takeoverStatus.reason).toBe(
        'Zalo was opened on another web browser. Click here to reconnect Chat Bridge.'
      );

      // Reconnecting re-enables connected state
      const reconnectPromise = source.login();
      mockAdapter.simulateScanSuccess({
        uid: 'zl-user-charlotte-01',
        displayName: 'Charlotte Nguyen',
        sessionToken: 'zpw_sek_mock_token_reconnect',
      });
      const reconnectedStatus = await reconnectPromise;
      expect(reconnectedStatus.state).toBe('connected');
    });
  });

  describe('User Profile Caching (getUserInfo 30-day TTL, Feature S-2)', () => {
    it('calls getUserInfo once per new sender and caches profile in SQLite for subsequent messages', async () => {
      const source = createSource();
      const loginPromise = source.login();
      mockAdapter.simulateScanSuccess({
        uid: 'zl-user-charlotte-01',
        displayName: 'Charlotte Nguyen',
        sessionToken: 'zpw_sek_token',
      });
      await loginPromise;

      const receivedMessages: Message[] = [];
      await source.start((msg) => {
        receivedMessages.push(msg);
      });

      // First message from new contact: triggers profile lookup
      mockAdapter.simulateInboundMessage({
        msgId: 'zl-msg-01',
        uidFrom: 'zl-contact-viet-99',
        content: 'Xin chao, toi muon hoi bao gia',
        timestamp: Date.now(),
      });

      // Allow async lookup to settle
      await new Promise((r) => setTimeout(r, 20));

      expect(receivedMessages.length).toBe(1);
      const firstMsg = receivedMessages[0];
      expect(firstMsg?.from.accountId).toBe('zl-contact-viet-99');
      expect(firstMsg?.from.displayName).toBe('Viet Tran (Cached Profile)');
      expect(mockAdapter.getUserInfoCallCount).toBe(1);

      // Second message from same contact: must use cache and NOT call getUserInfo again
      mockAdapter.simulateInboundMessage({
        msgId: 'zl-msg-02',
        uidFrom: 'zl-contact-viet-99',
        content: 'Gia san pham nay bao nhieu?',
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(receivedMessages.length).toBe(2);
      const secondMsg = receivedMessages[1];
      expect(secondMsg?.from.displayName).toBe('Viet Tran (Cached Profile)');
      // Call count remains 1!
      expect(mockAdapter.getUserInfoCallCount).toBe(1);
    });
  });

  describe('Encrypted Session Restoration Across Reboots', () => {
    it('restores connected state from encrypted SQLite session without requiring re-scan', async () => {
      const source1 = createSource();
      const loginPromise = source1.login();
      mockAdapter.simulateScanSuccess({
        uid: 'zl-user-charlotte-01',
        displayName: 'Charlotte Nguyen',
        sessionToken: 'zpw_sek_mock_token_persistent',
      });
      await loginPromise;
      await source1.stop();

      const mockAdapter2 = new MockZaloAdapter();
      const source2 = new ZaloSource({
        dbPath: testDbPath,
        masterKey: testMasterKey,
        adapter: mockAdapter2,
      });

      const status = await source2.status();
      expect(status.state).toBe('connected');
      expect(status.account).toBe('zl-user-charlotte-01');

      mockAdapter2.close();
    });
  });
});
