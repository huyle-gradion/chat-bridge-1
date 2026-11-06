import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeCli } from './cli.js';

describe('US-I1-01: Developer and QA Command-Line Interface (CLI) Parity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-cli-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Scenario 1: Standard POSIX flags and exit codes', () => {
    it('prints help message with --help and exits with 0', async () => {
      const result = await executeCli(['--help'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('chat-bridge');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('chats');
      expect(result.stdout).toContain('filters');
      expect(result.stdout).toContain('login');
      expect(result.stdout).toContain('sink');
      expect(result.stdout).toContain('run');
      expect(result.stdout).toContain('history');
      expect(result.stdout).toContain('ui');
    });

    it('prints version with --version and exits with 0', async () => {
      const result = await executeCli(['--version'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/0\.1\.0/);
    });

    it('returns non-zero exit code on unknown command', async () => {
      const result = await executeCli(['unknown-command'], { dataDir: tempDir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown command');
    });
  });

  describe('Scenario 2: Machine-readable status output', () => {
    it('executes status --json and returns structured telemetry and queue counts', async () => {
      const result = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toBeDefined();
      expect(parsed.sources).toBeDefined();
      expect(parsed.sinks).toBeDefined();
      expect(parsed.outbox).toBeDefined();
      expect(parsed.telemetry).toBeDefined();
      expect(typeof parsed.isPaused).toBe('boolean');
    });

    it('executes status with human-readable text output', async () => {
      const result = await executeCli(['status'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sources');
      expect(result.stdout).toContain('Where to send');
      expect(result.stdout).toContain('Waiting messages');
    });
  });

  describe('Scenario 3: Chat Picker Management (chat-bridge chats)', () => {
    it('lists chats, picks a chat, and unpicks a chat', async () => {
      // 1. List chats (initially empty)
      const listEmpty = await executeCli(['chats', 'list', '--json'], { dataDir: tempDir });
      expect(listEmpty.exitCode).toBe(0);
      const emptyParsed = JSON.parse(listEmpty.stdout);
      expect(Array.isArray(emptyParsed)).toBe(true);

      // 2. Pick a chat ID
      const pickRes = await executeCli(['chats', 'pick', 'chat-cust-001', '--json'], { dataDir: tempDir });
      expect(pickRes.exitCode).toBe(0);
      const pickParsed = JSON.parse(pickRes.stdout);
      expect(pickParsed.ok).toBe(true);
      expect(pickParsed.id).toBe('chat-cust-001');
      expect(pickParsed.isTicked).toBe(true);

      // 3. List chats again to verify it is ticked
      const listRes = await executeCli(['chats', 'list', '--json'], { dataDir: tempDir });
      expect(listRes.exitCode).toBe(0);
      const listParsed = JSON.parse(listRes.stdout);
      const found = listParsed.find((c: { id: string }) => c.id === 'chat-cust-001');
      expect(found).toBeDefined();
      expect(found.isTicked).toBe(true);

      // 4. Unpick the chat
      const unpickRes = await executeCli(['chats', 'unpick', 'chat-cust-001', '--json'], { dataDir: tempDir });
      expect(unpickRes.exitCode).toBe(0);
      const unpickParsed = JSON.parse(unpickRes.stdout);
      expect(unpickParsed.ok).toBe(true);
      expect(unpickParsed.isTicked).toBe(false);
    });
  });

  describe('Scenario 4: Filter Configuration (chat-bridge filters)', () => {
    it('shows filters, sets allowGroups, and blocks/unblocks contacts', async () => {
      // 1. Show filters
      const showRes = await executeCli(['filters', 'show', '--json'], { dataDir: tempDir });
      expect(showRes.exitCode).toBe(0);
      const showParsed = JSON.parse(showRes.stdout);
      expect(showParsed.allowGroups).toBe(false); // Groups off by default
      expect(showParsed.otpFilterEnabled).toBe(true); // OTP active by default

      // 2. Enable groups
      const setGroupsRes = await executeCli(['filters', 'set', 'allowGroups', 'true', '--json'], { dataDir: tempDir });
      expect(setGroupsRes.exitCode).toBe(0);
      const setGroupsParsed = JSON.parse(setGroupsRes.stdout);
      expect(setGroupsParsed.allowGroups).toBe(true);

      // 3. Block a contact
      const blockRes = await executeCli(['filters', 'block', '+84901234567', '--json'], { dataDir: tempDir });
      expect(blockRes.exitCode).toBe(0);
      const blockParsed = JSON.parse(blockRes.stdout);
      expect(blockParsed.blockedContacts).toContain('84901234567');

      // 4. Unblock the contact
      const unblockRes = await executeCli(['filters', 'unblock', '+84901234567', '--json'], { dataDir: tempDir });
      expect(unblockRes.exitCode).toBe(0);
      const unblockParsed = JSON.parse(unblockRes.stdout);
      expect(unblockParsed.blockedContacts).not.toContain('84901234567');
    });
  });

  describe('Scenario 5: Login Flow (chat-bridge login)', () => {
    it('initiates login for WhatsApp and yields authentication/qr event', async () => {
      const result = await executeCli(['login', 'whatsapp', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.network).toBe('whatsapp');
      expect(parsed.status).toBeDefined();
    });

    it('initiates login for Zalo and yields authentication event', async () => {
      const result = await executeCli(['login', 'zalo', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.network).toBe('zalo');
      expect(parsed.status).toBeDefined();
    });

    it('rejects unsupported login network', async () => {
      const result = await executeCli(['login', 'telegram', '--json'], { dataDir: tempDir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unsupported network');
    });
  });

  describe('Scenario 6: Destination Management (chat-bridge sink)', () => {
    it('adds a sink, lists sinks, tests sink, and removes sink', async () => {
      const validConfig = JSON.stringify({
        endpointUrl: 'http://localhost:3000/webhooks/ext/openchannel/receive/test-ref',
        sharedSecret: 'test-shared-secret-32-chars-long-key',
        channelRef: 'test-ref',
      });

      // 1. Add Margince sink
      const addRes = await executeCli(['sink', 'add', 'margince', validConfig, '--json'], { dataDir: tempDir });
      expect(addRes.exitCode).toBe(0);
      const addParsed = JSON.parse(addRes.stdout);
      expect(addParsed.ok).toBe(true);

      // 2. List sinks
      const listRes = await executeCli(['sink', 'list', '--json'], { dataDir: tempDir });
      expect(listRes.exitCode).toBe(0);
      const listParsed = JSON.parse(listRes.stdout);
      expect(listParsed.find((s: { type: string }) => s.type === 'margince')).toBeDefined();

      // 3. Test sink
      const testRes = await executeCli(['sink', 'test', 'margince', '--json'], { dataDir: tempDir });
      expect(testRes.exitCode).toBe(0);
      const testParsed = JSON.parse(testRes.stdout);
      expect(testParsed).toBeDefined();

      // 4. Remove sink
      const removeRes = await executeCli(['sink', 'remove', 'margince', '--json'], { dataDir: tempDir });
      expect(removeRes.exitCode).toBe(0);
      const removeParsed = JSON.parse(removeRes.stdout);
      expect(removeParsed.ok).toBe(true);
    });

    it('rejects adding sink with invalid configuration', async () => {
      const invalidConfig = 'invalid-not-json-or-missing-fields';
      const addRes = await executeCli(['sink', 'add', 'margince', invalidConfig, '--json'], { dataDir: tempDir });
      expect(addRes.exitCode).not.toBe(0);
      expect(addRes.stderr).toContain('Invalid configuration');
    });
  });

  describe('Scenario 7: Replay Engine Run (chat-bridge run)', () => {
    it('runs pipeline with --fake and completes replay', async () => {
      const runRes = await executeCli(['run', '--fake', '--headless', '--json', '--timeout', '500'], { dataDir: tempDir });
      expect(runRes.exitCode).toBe(0);
      const parsed = JSON.parse(runRes.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.processedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scenario 8: Historical Import (chat-bridge history)', () => {
    it('imports history from fake source with since date', async () => {
      const res = await executeCli(['history', 'import', 'fake', '--since', '2026-11-01', '--json'], { dataDir: tempDir });
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.importedCount).toBeGreaterThanOrEqual(0);
      expect(parsed.network).toBe('fake');
    });
  });

  describe('Scenario 9: Local UI Command (chat-bridge ui)', () => {
    it('outputs local web interface URL', async () => {
      const res = await executeCli(['ui', '--port', '4173', '--json'], { dataDir: tempDir });
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.url).toContain('http://127.0.0.1:4173');
    });
  });
});
