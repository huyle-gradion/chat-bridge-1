import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeSourceContract, ScenarioBuilder } from '@chat-bridge/testing';
import type { Message } from '@chat-bridge/types';
import { FakeSource } from './fake-source.js';

describe('US-S1-01: FakeSource Implementation & Contract Conformance', () => {
  // Test 1: Conformance to SourceContract runner
  describeSourceContract('FakeSource', () => new FakeSource());

  // Test 2: Scenario Replay Capabilities
  describe('Message replay', () => {
    it('replays 1:1, group, OTP, noise, and 40,000 character messages', async () => {
      const scenario = new ScenarioBuilder({ seed: 101 })
        .withContacts(2)
        .withGroup('Project Alpha', 2)
        .withOtpCode('987654')
        .withNoise(['reaction', 'typing'])
        .withLongText(40000)
        .buildScenario();

      const source = new FakeSource({
        scenario,
        delayMs: 0,
      });

      const received: Message[] = [];
      await source.start((msg) => {
        received.push(msg);
      });

      // Wait briefly for all synchronously queued emissions
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received.length).toBe(scenario.messages.length);

      const hasDm = received.some((m) => m.threadKind === 'dm');
      const hasGroup = received.some((m) => m.threadKind === 'group');
      const hasOtp = received.some((m) => m.text.includes('987654'));
      const hasNoise = received.some((m) => m.text.startsWith('[reaction:') || m.text.startsWith('[typing'));
      const hasLong = received.some((m) => m.text.length === 40000);

      expect(hasDm).toBe(true);
      expect(hasGroup).toBe(true);
      expect(hasOtp).toBe(true);
      expect(hasNoise).toBe(true);
      expect(hasLong).toBe(true);

      await source.stop();
    });

    it('loads and replays messages from a JSON fixture file', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fixture-'));
      const fixtureFile = path.join(tempDir, 'fixture.json');

      const fixtureMessages: Message[] = [
        {
          id: 'fake:rep-01:fix-1',
          network: 'fake',
          account: 'rep-01',
          thread: 'chat-fix-1',
          threadKind: 'dm',
          direction: 'inbound',
          time: new Date().toISOString(),
          from: { accountId: 'fix-user-1', displayName: 'Fixture User' },
          to: [{ accountId: 'rep-01', displayName: 'Rep' }],
          text: 'Message from fixture file',
        },
      ];

      fs.writeFileSync(fixtureFile, JSON.stringify(fixtureMessages, null, 2), 'utf-8');

      const source = new FakeSource({
        fixturePath: fixtureFile,
        delayMs: 0,
      });

      const received: Message[] = [];
      await source.start((msg) => {
        received.push(msg);
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(received.length).toBe(1);
      expect(received[0]?.text).toBe('Message from fixture file');

      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('discovers chat threads accurately from replayed scenario', async () => {
      const scenario = new ScenarioBuilder({ seed: 42 })
        .withContacts(3)
        .buildScenario();

      const source = new FakeSource({ scenario });
      const chats = await source.chats();

      expect(chats.length).toBeGreaterThanOrEqual(3);
      for (const chat of chats) {
        expect(chat.network).toBe('fake');
        expect(typeof chat.name).toBe('string');
      }
    });

    it('filters historical messages by since timestamp', async () => {
      const pastTime = new Date(Date.now() - 3600 * 1000).toISOString();
      const recentTime = new Date().toISOString();

      const messages: Message[] = [
        {
          id: 'fake:rep-01:old-1',
          network: 'fake',
          account: 'rep-01',
          thread: 't1',
          threadKind: 'dm',
          direction: 'inbound',
          time: pastTime,
          from: { accountId: 'c1', displayName: 'Old User' },
          to: [],
          text: 'Old message',
        },
        {
          id: 'fake:rep-01:recent-1',
          network: 'fake',
          account: 'rep-01',
          thread: 't1',
          threadKind: 'dm',
          direction: 'inbound',
          time: recentTime,
          from: { accountId: 'c1', displayName: 'Recent User' },
          to: [],
          text: 'Recent message',
        },
      ];

      const source = new FakeSource({ messages });
      const cutoff = new Date(Date.now() - 1800 * 1000).toISOString();
      const history = await source.history(cutoff);

      expect(history.length).toBe(1);
      expect(history[0]?.id).toBe('fake:rep-01:recent-1');
    });

    it('simulates outbound reply sending with send()', async () => {
      const source = new FakeSource();
      const sendResult = await source.send('thread-sales-9', 'Confirmed order details');

      expect(sendResult.ok).toBe(true);
      expect(sendResult.messageId).toBeDefined();
    });

    it('loads and instantiates FakeSource in a standalone Node process without loading vitest', () => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
      const tscBinPath = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const fakeDistPath = path.join(repoRoot, 'packages/sources/fake/dist/index.js');

      const buildRes = spawnSync(process.execPath, [tscBinPath, '--build'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      expect(buildRes.status).toBe(0);

      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('VITEST')) {
          delete env[key];
        }
      }

      const fakeUrl = pathToFileURL(fakeDistPath).href;
      const script = [
        "import mod from 'node:module';",
        'const resolved = [];',
        'if (typeof mod.registerHooks === "function") {',
        '  mod.registerHooks({',
        '    resolve(specifier, context, nextResolve) {',
        '      resolved.push(specifier);',
        '      return nextResolve(specifier, context);',
        '    }',
        '  });',
        '}',
        `const { FakeSource } = await import(${JSON.stringify(fakeUrl)});`,
        'const source = new FakeSource({ delayMs: 0 });',
        'const chats = await source.chats();',
        'console.log(JSON.stringify({ chatCount: chats.length, resolved }));',
      ].join('\n');

      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: repoRoot,
          env,
          encoding: 'utf-8',
          timeout: 30_000,
        }
      );

      expect(result.stderr).not.toContain('Vitest');
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        chatCount: number;
        resolved: string[];
      };
      expect(parsed.chatCount).toBeGreaterThanOrEqual(3);
      expect(parsed.resolved).not.toContain('vitest');
    });
  });
});
