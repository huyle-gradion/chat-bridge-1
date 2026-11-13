import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeSinkContract } from '@chat-bridge/testing';
import type { Message } from '@chat-bridge/types';
import { ArchiveSink } from './archive-sink.js';

describe('US-K1-01: Daily Partitioned JSONL File Archive (ArchiveSink)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-archive-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('SinkContract Conformance', () => {
    describeSinkContract('ArchiveSink', async () => {
      const contractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-contract-test-'));
      const sink = new ArchiveSink();
      await sink.configure({ folder: contractDir });
      return sink;
    });
  });

  describe('Scenario 1: Daily JSONL Partitioning & Append (Issue #29 Acceptance)', () => {
    it('appends messages to partitioned daily YYYY-MM-DD.jsonl files based on UTC message time', async () => {
      const sink = new ArchiveSink();
      const configRes = await sink.configure({ folder: tempDir });
      expect(configRes.valid).toBe(true);

      const msgDay1: Message = {
        id: 'fake:rep-01:msg-day1-1',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-01',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T14:30:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer One' },
        to: [{ accountId: 'rep-01', displayName: 'Rep Charlotte' }],
        text: 'Message on Nov 12',
      };

      const msgDay2: Message = {
        id: 'fake:rep-01:msg-day2-1',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-02',
        threadKind: 'dm',
        direction: 'outbound',
        time: '2026-11-13T09:15:00.000Z',
        from: { accountId: 'rep-01', displayName: 'Rep Charlotte' },
        to: [{ accountId: 'cust-2', displayName: 'Customer Two' }],
        text: 'Message on Nov 13',
      };

      const outcomes = await sink.deliver([msgDay1, msgDay2]);

      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]?.messageId).toBe(msgDay1.id);
      expect(outcomes[0]?.outcome).toBe('accepted');
      expect(outcomes[1]?.messageId).toBe(msgDay2.id);
      expect(outcomes[1]?.outcome).toBe('accepted');

      const fileDay1 = path.join(tempDir, '2026-11-12.jsonl');
      const fileDay2 = path.join(tempDir, '2026-11-13.jsonl');

      expect(fs.existsSync(fileDay1)).toBe(true);
      expect(fs.existsSync(fileDay2)).toBe(true);

      const contentDay1 = fs.readFileSync(fileDay1, 'utf-8').trim().split('\n');
      expect(contentDay1).toHaveLength(1);
      const parsedDay1 = JSON.parse(contentDay1[0]!);
      expect(parsedDay1.id).toBe(msgDay1.id);
      expect(parsedDay1.text).toBe(msgDay1.text);

      const contentDay2 = fs.readFileSync(fileDay2, 'utf-8').trim().split('\n');
      expect(contentDay2).toHaveLength(1);
      const parsedDay2 = JSON.parse(contentDay2[0]!);
      expect(parsedDay2.id).toBe(msgDay2.id);
      expect(parsedDay2.text).toBe(msgDay2.text);
    });

    it('partitions messages across midnight UTC boundary correctly', async () => {
      const sink = new ArchiveSink();
      await sink.configure({ folder: tempDir });

      const msgJustBeforeMidnight: Message = {
        id: 'fake:rep-01:msg-boundary-before',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-boundary',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T23:59:59.999Z',
        from: { accountId: 'cust-1', displayName: 'Customer One' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Late night query',
      };

      const msgJustAfterMidnight: Message = {
        id: 'fake:rep-01:msg-boundary-after',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-boundary',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-13T00:00:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer One' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Morning query',
      };

      await sink.deliver([msgJustBeforeMidnight, msgJustAfterMidnight]);

      const fileDay1 = path.join(tempDir, '2026-11-12.jsonl');
      const fileDay2 = path.join(tempDir, '2026-11-13.jsonl');

      expect(fs.existsSync(fileDay1)).toBe(true);
      expect(fs.existsSync(fileDay2)).toBe(true);

      const parsed1 = JSON.parse(fs.readFileSync(fileDay1, 'utf-8').trim());
      const parsed2 = JSON.parse(fs.readFileSync(fileDay2, 'utf-8').trim());

      expect(parsed1.id).toBe(msgJustBeforeMidnight.id);
      expect(parsed2.id).toBe(msgJustAfterMidnight.id);
    });

    it('creates nested destination folders automatically if they do not exist', async () => {
      const nestedFolder = path.join(tempDir, 'nested', 'archive', 'subfolder');
      const sink = new ArchiveSink();
      await sink.configure({ folder: nestedFolder });

      const msg: Message = {
        id: 'fake:rep-01:msg-nested',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-nested',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T12:00:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Testing nested folder creation',
      };

      const outcomes = await sink.deliver([msg]);
      expect(outcomes[0]?.outcome).toBe('accepted');
      expect(fs.existsSync(path.join(nestedFolder, '2026-11-12.jsonl'))).toBe(true);
    });
  });

  describe('Scenario 2: Deduplication & Idempotency (Issue #29 Acceptance)', () => {
    it('returns duplicate outcome and leaves file unchanged when same message is delivered again', async () => {
      const sink = new ArchiveSink();
      await sink.configure({ folder: tempDir });

      const msg: Message = {
        id: 'fake:rep-01:msg-dup-1',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-dup',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T15:00:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer One' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Hello, I have an inquiry.',
      };

      const firstOutcomes = await sink.deliver([msg]);
      expect(firstOutcomes[0]?.outcome).toBe('accepted');

      const targetFile = path.join(tempDir, '2026-11-12.jsonl');
      const fileStatBefore = fs.statSync(targetFile);
      const contentBefore = fs.readFileSync(targetFile, 'utf-8');

      // Deliver identical message again
      const secondOutcomes = await sink.deliver([msg]);
      expect(secondOutcomes).toHaveLength(1);
      expect(secondOutcomes[0]?.messageId).toBe(msg.id);
      expect(secondOutcomes[0]?.outcome).toBe('duplicate');
      expect(secondOutcomes[0]?.reason).toBeDefined();

      const fileStatAfter = fs.statSync(targetFile);
      const contentAfter = fs.readFileSync(targetFile, 'utf-8');

      expect(fileStatAfter.size).toBe(fileStatBefore.size);
      expect(contentAfter).toBe(contentBefore);
      const lines = contentAfter.trim().split('\n');
      expect(lines).toHaveLength(1);
    });

    it('deduplicates duplicate messages within the same batch', async () => {
      const sink = new ArchiveSink();
      await sink.configure({ folder: tempDir });

      const msg: Message = {
        id: 'fake:rep-01:msg-batch-dup',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-dup',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T16:00:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer One' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Batch duplicate check',
      };

      const outcomes = await sink.deliver([msg, msg]);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]?.outcome).toBe('accepted');
      expect(outcomes[1]?.outcome).toBe('duplicate');

      const targetFile = path.join(tempDir, '2026-11-12.jsonl');
      const lines = fs.readFileSync(targetFile, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
    });

    it('persists deduplication state across sink re-instantiations by inspecting existing daily file', async () => {
      const sink1 = new ArchiveSink();
      await sink1.configure({ folder: tempDir });

      const msg: Message = {
        id: 'fake:rep-01:msg-restart-dup',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-restart',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T17:00:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Persisted duplicate message',
      };

      const firstOutcomes = await sink1.deliver([msg]);
      expect(firstOutcomes[0]?.outcome).toBe('accepted');

      // Create a brand new sink instance pointing to same directory
      const sink2 = new ArchiveSink();
      await sink2.configure({ folder: tempDir });

      const secondOutcomes = await sink2.deliver([msg]);
      expect(secondOutcomes[0]?.outcome).toBe('duplicate');

      const targetFile = path.join(tempDir, '2026-11-12.jsonl');
      const lines = fs.readFileSync(targetFile, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
    });
  });

  describe('Scenario 3: Configuration & Validation (Issue #29 Acceptance)', () => {
    it('returns valid: false with plain-language error when folder is missing or empty', async () => {
      const sink = new ArchiveSink();

      const emptyRes = await sink.configure({});
      expect(emptyRes.valid).toBe(false);
      expect(emptyRes.errors).toBeDefined();
      expect(emptyRes.errors?.folder).toBeDefined();
      expect(typeof emptyRes.errors?.folder).toBe('string');
      expect(emptyRes.errors?.folder.length).toBeGreaterThan(0);

      const emptyStrRes = await sink.configure({ folder: '' });
      expect(emptyStrRes.valid).toBe(false);
      expect(emptyStrRes.errors?.folder).toBeDefined();

      const whitespaceRes = await sink.configure({ folder: '   ' });
      expect(whitespaceRes.valid).toBe(false);
      expect(whitespaceRes.errors?.folder).toBeDefined();

      const nonStringRes = await sink.configure({ folder: 12345 });
      expect(nonStringRes.valid).toBe(false);
      expect(nonStringRes.errors?.folder).toBeDefined();
    });

    it('ensures error message contains plain language and no technical jargon', async () => {
      const sink = new ArchiveSink();
      const res = await sink.configure({});
      const errorMsg = res.errors?.folder ?? '';

      expect(errorMsg.toLowerCase()).not.toContain('sink');
      expect(errorMsg.toLowerCase()).not.toContain('outbox');
      expect(errorMsg.toLowerCase()).not.toContain('regex');
    });

    it('refuses deliveries when sink is not configured with a folder', async () => {
      const unconfiguredSink = new ArchiveSink();

      const msg: Message = {
        id: 'fake:rep-01:msg-unconfigured',
        network: 'fake',
        account: 'rep-01',
        thread: 'thread-unconfigured',
        threadKind: 'dm',
        direction: 'inbound',
        time: '2026-11-12T12:00:00.000Z',
        from: { accountId: 'cust-1', displayName: 'Customer' },
        to: [{ accountId: 'rep-01', displayName: 'Rep' }],
        text: 'Unconfigured test',
      };

      const outcomes = await unconfiguredSink.deliver([msg]);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.outcome).toBe('refused');
      expect(outcomes[0]?.reason).toBeDefined();
    });

    it('handles empty delivery batch gracefully returning empty outcomes', async () => {
      const sink = new ArchiveSink();
      await sink.configure({ folder: tempDir });

      const outcomes = await sink.deliver([]);
      expect(outcomes).toEqual([]);
    });

    it('proves folder accessibility via test()', async () => {
      const sink = new ArchiveSink();
      const unconfiguredTest = await sink.test();
      expect(unconfiguredTest.ok).toBe(false);

      await sink.configure({ folder: tempDir });
      const configuredTest = await sink.test();
      expect(configuredTest.ok).toBe(true);
      expect(configuredTest.message.length).toBeGreaterThan(0);
    });
  });
});
