import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LoginEvent, Message } from '@chat-bridge/types';
import { WhatsAppSource, type WhatsAppSourceOptions } from './whatsapp-source.js';
import { MockWhatsAppSocket } from './socket/mock-socket-adapter.js';

describe('US-S3-01: WhatsApp QR Code & Pairing Code Authentication', () => {
  const testDbDir = path.join(process.cwd(), 'tmp-test-whatsapp');
  const testDbPath = path.join(testDbDir, 'whatsapp-session.db');
  const testMasterKey = crypto.randomBytes(32);
  let mockSocket: MockWhatsAppSocket;

  beforeEach(() => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    mockSocket = new MockWhatsAppSocket();
  });

  afterEach(async () => {
    mockSocket.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  function createSource(options: Partial<WhatsAppSourceOptions> = {}): WhatsAppSource {
    return new WhatsAppSource({
      dbPath: testDbPath,
      masterKey: testMasterKey,
      socketAdapter: mockSocket,
      ...options,
    });
  }

  describe('Scenario 1: QR Code Authentication', () => {
    it('emits a QR code event with connection instructions and connects upon scanning', async () => {
      const source = createSource();
      const loginEvents: LoginEvent[] = [];

      const loginPromise = source.login((event) => {
        loginEvents.push(event);
      });

      // Initially emits QR code event with instructions
      expect(loginEvents.length).toBeGreaterThanOrEqual(1);
      const qrEvent = loginEvents[0];
      expect(qrEvent?.type).toBe('qr');
      expect(qrEvent?.qrData).toBeDefined();
      expect(qrEvent?.message).toContain('Open WhatsApp on your phone -> Linked Devices -> Link a Device');

      // Check status during login
      const pendingStatus = await source.status();
      expect(pendingStatus.state).toBe('needs-login');

      // Simulate device scanning the QR code
      mockSocket.simulateScanSuccess({
        id: '84901234567@s.whatsapp.net',
        phone: '84901234567',
        name: 'Charlotte Sales Rep',
        isBusiness: false,
      });

      const finalStatus = await loginPromise;
      expect(finalStatus.state).toBe('connected');
      expect(finalStatus.account).toBe('84901234567');
      expect(source.network).toBe('whatsapp');

      // Check that session keys were written to encrypted SQLite store
      expect(fs.existsSync(testDbPath)).toBe(true);
      const sessionCount = source.getSessionRecordCount();
      expect(sessionCount).toBeGreaterThan(0);
    });
  });

  describe('Scenario 2: Pairing Code Alternative', () => {
    it('normalizes phone number and emits 8-digit alphanumeric pairing code with 60s countdown', async () => {
      const source = createSource();
      const loginEvents: LoginEvent[] = [];

      // User provides phone number with spacing and country code
      const loginPromise = source.loginWithPairingCode('+84 90 123 4567', (event) => {
        loginEvents.push(event);
      });

      expect(loginEvents.length).toBe(1);
      const codeEvent = loginEvents[0];
      expect(codeEvent?.type).toBe('pairing-code');
      // Format must be XXXX-XXXX (8 chars split by hyphen)
      expect(codeEvent?.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(codeEvent?.message).toContain('60 seconds');

      // Simulate user entering the code on mobile app
      mockSocket.simulatePairingSuccess({
        id: '84901234567@s.whatsapp.net',
        phone: '84901234567',
        name: 'Charlotte Sales Rep',
        isBusiness: false,
      });

      const finalStatus = await loginPromise;
      expect(finalStatus.state).toBe('connected');
      expect(finalStatus.account).toBe('84901234567');
    });

    it('rejects invalid or unparseable phone numbers with clear plain-language error', async () => {
      const source = createSource();

      await expect(source.loginWithPairingCode('invalid-phone')).rejects.toThrow(
        /Please enter a valid phone number with country code/
      );
    });
  });

  describe('Scenario 3: QR Code Refresh', () => {
    it('refreshes QR code after timeout and offers refresh overlay message', async () => {
      const source = createSource();
      const loginEvents: LoginEvent[] = [];

      source.login((event) => {
        loginEvents.push(event);
      });

      expect(loginEvents.length).toBe(1);
      const firstQr = loginEvents[0]?.qrData;

      // Simulate 60 second timeout expiration
      mockSocket.simulateQrTimeout();

      expect(loginEvents.length).toBe(2);
      const refreshedEvent = loginEvents[1];
      expect(refreshedEvent?.type).toBe('qr');
      expect(refreshedEvent?.qrData).not.toBe(firstQr);
      expect(refreshedEvent?.message).toContain('Click to refresh QR code');
    });
  });

  describe('Business Account Auto-Detection (ADR 0030)', () => {
    it('sets network to whatsapp-biz when account indicates business tier and flattens interactive messages', async () => {
      const source = createSource();

      const loginPromise = source.login();
      mockSocket.simulateScanSuccess({
        id: '84909876543@s.whatsapp.net',
        phone: '84909876543',
        name: 'Acme Business Store',
        isBusiness: true,
      });

      const status = await loginPromise;
      expect(status.state).toBe('connected');
      expect(source.network).toBe('whatsapp-biz');

      // Inbound message handling with interactive product message
      const receivedMessages: Message[] = [];
      await source.start((msg) => {
        receivedMessages.push(msg);
      });

      mockSocket.simulateInboundRawMessage({
        key: {
          remoteJid: '84988776655@s.whatsapp.net',
          fromMe: false,
          id: 'wa-msg-product-101',
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Alice Buyer',
        message: {
          productMessage: {
            product: {
              productId: 'prod-99',
              title: 'Premium Tea Set',
              priceAmount1000: 500000000,
              currencyCode: 'VND',
            },
            businessOwnerJid: '84909876543@s.whatsapp.net',
          },
        },
      });

      expect(receivedMessages.length).toBe(1);
      const deliveredMsg = receivedMessages[0];
      expect(deliveredMsg?.network).toBe('whatsapp-biz');
      expect(deliveredMsg?.text).toBe('[product: Premium Tea Set, 500000 VND]');
    });
  });

  describe('LID-to-Phone Identity Resolution (ADR 0006)', () => {
    it('maps incoming LID identifier to primary phone number in message normalization', async () => {
      const source = createSource();
      const loginPromise = source.login();
      mockSocket.simulateScanSuccess({
        id: '84901234567@s.whatsapp.net',
        phone: '84901234567',
        name: 'Rep Charlotte',
        isBusiness: false,
      });
      await loginPromise;

      // Register LID to phone mapping
      await source.registerIdentityMapping({
        aliasId: '1122334455@lid',
        primaryPhone: '84911223344',
        displayName: 'Bob Partner',
      });

      const receivedMessages: Message[] = [];
      await source.start((msg) => {
        receivedMessages.push(msg);
      });

      // Incoming message with LID as sender
      mockSocket.simulateInboundRawMessage({
        key: {
          remoteJid: '84911223344@s.whatsapp.net',
          fromMe: false,
          id: 'wa-msg-lid-1',
          participant: '1122334455@lid',
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Bob Partner',
        message: {
          conversation: 'Hello from WhatsApp LID account',
        },
      });

      expect(receivedMessages.length).toBe(1);
      const msg = receivedMessages[0];
      expect(msg?.from.accountId).toBe('84911223344');
      expect(msg?.from.displayName).toBe('Bob Partner');
    });
  });

  describe('Encrypted Session Restoration Across Reboots', () => {
    it('restores connected state from encrypted SQLite session without re-authenticating', async () => {
      // First instance logs in
      const source1 = createSource();
      const loginPromise = source1.login();
      mockSocket.simulateScanSuccess({
        id: '84901234567@s.whatsapp.net',
        phone: '84901234567',
        name: 'Charlotte Sales Rep',
        isBusiness: false,
      });
      await loginPromise;
      await source1.stop();

      // Second instance starts with same database and master key
      const mockSocket2 = new MockWhatsAppSocket();
      const source2 = new WhatsAppSource({
        dbPath: testDbPath,
        masterKey: testMasterKey,
        socketAdapter: mockSocket2,
      });

      // Should automatically restore session
      const status = await source2.status();
      expect(status.state).toBe('connected');
      expect(status.account).toBe('84901234567');
      expect(mockSocket2.connectionAttempts).toBe(1);

      mockSocket2.close();
    });
  });
});
