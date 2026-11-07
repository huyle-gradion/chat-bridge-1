import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Message } from '@chat-bridge/types';
import { executeCli } from './cli.js';
import { CliContext } from './config.js';
import {
  CPU_SAMPLE_INTERVAL_MS,
  CPU_SLOW_PERCENT,
  CPU_PROBLEM_PERCENT,
  MEMORY_SLOW_MB,
  MEMORY_PROBLEM_MB,
  QUEUE_SLOW_THRESHOLD,
  QUEUE_WAIT_SLOW_SECONDS,
  SINK_DOWN_HALT_MS,
  ERROR_WINDOW_MS,
  MESSAGE_RATE_WINDOW_MS,
} from './commands/status.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliDistPath = path.join(repoRoot, 'packages/cli/dist/cli.js');
const cliIndexDistPath = path.join(repoRoot, 'packages/cli/dist/index.js');
const tscBinPath = path.join(repoRoot, 'node_modules/typescript/bin/tsc');

function cleanChildEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CHAT_BRIDGE_DATA_DIR: dataDir };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) {
      delete env[key];
    }
  }
  return env;
}

function runBuiltCli(
  args: string[],
  dataDir: string
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliDistPath, ...args], {
    cwd: repoRoot,
    env: cleanChildEnv(dataDir),
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function collectRuntimeImportGraph(entryFile: string): {
  visitedFiles: string[];
  externalSpecifiers: string[];
} {
  const workspacePackages = new Map<
    string,
    { dir: string; main?: string; exports?: Record<string, string | { import?: string }> }
  >();
  const packageJsonRelPaths = [
    'packages/types/package.json',
    'packages/testing/package.json',
    'packages/engine/package.json',
    'packages/cli/package.json',
    'packages/desktop/package.json',
    'packages/sources/fake/package.json',
    'packages/sources/whatsapp/package.json',
    'packages/sources/zalo/package.json',
    'packages/sinks/margince/package.json',
  ];

  for (const rel of packageJsonRelPaths) {
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full)) {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as {
        name: string;
        main?: string;
        exports?: Record<string, string | { import?: string }>;
      };
      workspacePackages.set(parsed.name, {
        dir: path.dirname(full),
        ...(parsed.main ? { main: parsed.main } : {}),
        ...(parsed.exports ? { exports: parsed.exports } : {}),
      });
    }
  }

  const visited = new Set<string>();
  const externalSpecifiers = new Set<string>();
  const queue: string[] = [entryFile];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current) || !fs.existsSync(current)) {
      continue;
    }
    visited.add(current);

    const content = fs.readFileSync(current, 'utf-8');
    const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1];
      if (!spec) {
        continue;
      }

      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(current), spec);
        if (fs.existsSync(resolved)) {
          queue.push(resolved);
        }
        continue;
      }

      if (spec.startsWith('@chat-bridge/')) {
        const parts = spec.split('/');
        const pkgName = `${parts[0]}/${parts[1]}`;
        const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
        const pkgInfo = workspacePackages.get(pkgName);
        if (pkgInfo) {
          const exportEntry = pkgInfo.exports?.[subpath];
          const targetRel =
            typeof exportEntry === 'string'
              ? exportEntry
              : exportEntry?.import ?? (subpath === '.' ? pkgInfo.main : undefined);
          if (targetRel) {
            const resolved = path.resolve(pkgInfo.dir, targetRel);
            if (fs.existsSync(resolved)) {
              queue.push(resolved);
            }
          }
        }
        continue;
      }

      externalSpecifiers.add(spec);
    }
  }

  return {
    visitedFiles: Array.from(visited).map((f) => path.relative(repoRoot, f)),
    externalSpecifiers: Array.from(externalSpecifiers),
  };
}

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

  describe('Scenario 10: Mistyped command suggestions', () => {
    it('suggests "status" for "stauts" with help hint on stderr and exit code 1', async () => {
      const res = await executeCli(['stauts'], { dataDir: tempDir });
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('Unknown command: "stauts". Did you mean "status"?');
      expect(res.stderr).toContain('Run "chat-bridge --help" for available commands.');
    });

    it('suggests a known command when within 1 or 2 edits of the input', async () => {
      const oneEdit = await executeCli(['chat'], { dataDir: tempDir });
      expect(oneEdit.exitCode).toBe(1);
      expect(oneEdit.stderr).toContain('Unknown command: "chat". Did you mean "chats"?');
      expect(oneEdit.stderr).toContain('Run "chat-bridge --help" for available commands.');

      const twoEdits = await executeCli(['stat'], { dataDir: tempDir });
      expect(twoEdits.exitCode).toBe(1);
      expect(twoEdits.stderr).toContain('Unknown command: "stat". Did you mean "status"?');
      expect(twoEdits.stderr).toContain('Run "chat-bridge --help" for available commands.');
    });

    it('keeps the error message unchanged when no command is within 2 edits', async () => {
      const threeEdits = await executeCli(['statusxyz'], { dataDir: tempDir });
      expect(threeEdits.exitCode).toBe(1);
      expect(threeEdits.stderr).toBe(
        'Unknown command: "statusxyz". Run "chat-bridge --help" for available commands.'
      );

      const farInput = await executeCli(['unknown-command'], { dataDir: tempDir });
      expect(farInput.exitCode).toBe(1);
      expect(farInput.stderr).toBe(
        'Unknown command: "unknown-command". Run "chat-bridge --help" for available commands.'
      );
    });

    it('ignores case when matching mistyped commands', async () => {
      const res = await executeCli(['STAUTS'], { dataDir: tempDir });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Did you mean "status"?');
      expect(res.stderr).toContain('Run "chat-bridge --help" for available commands.');
    });

    it('includes suggestion field in --json error output when a suggestion exists and omits it otherwise', async () => {
      const withSuggestion = await executeCli(['stauts', '--json'], { dataDir: tempDir });
      expect(withSuggestion.exitCode).toBe(1);
      expect(withSuggestion.stdout).toBe('');
      const parsedWith = JSON.parse(withSuggestion.stderr);
      expect(parsedWith.suggestion).toBe('status');
      expect(parsedWith.error).toContain('Unknown command: "stauts". Did you mean "status"?');
      expect(parsedWith.error).toContain('Run "chat-bridge --help" for available commands.');

      const withoutSuggestion = await executeCli(['statusxyz', '--json'], { dataDir: tempDir });
      expect(withoutSuggestion.exitCode).toBe(1);
      expect(withoutSuggestion.stdout).toBe('');
      const parsedWithout = JSON.parse(withoutSuggestion.stderr);
      expect(parsedWithout.error).toBe(
        'Unknown command: "statusxyz". Run "chat-bridge --help" for available commands.'
      );
      expect(parsedWithout).not.toHaveProperty('suggestion');
    });
  });

  describe('Scenario 11: Built binary execution and vitest-free runtime imports', () => {
    beforeAll(() => {
      const buildRes = spawnSync(process.execPath, [tscBinPath, '--build'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      expect(buildRes.status).toBe(0);
      expect(fs.existsSync(cliDistPath)).toBe(true);
    });

    it('starts the built binary and prints its version with --version', () => {
      const run = runBuiltCli(['--version'], tempDir);
      expect(run.stderr).not.toContain('Error');
      expect(run.stderr).not.toContain('Vitest');
      expect(run.exitCode).toBe(0);
      expect(run.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    });

    it('executes status --json on a fresh install from the built binary and returns valid JSON', () => {
      const run = runBuiltCli(['status', '--json'], tempDir);
      expect(run.stderr).not.toContain('Error');
      expect(run.exitCode).toBe(0);
      const parsed = JSON.parse(run.stdout);
      expect(parsed.sources).toBeDefined();
      expect(parsed.sinks).toBeDefined();
      expect(parsed.outbox).toBeDefined();
      expect(parsed.telemetry).toBeDefined();
      expect(typeof parsed.isPaused).toBe('boolean');
    });

    it('suggests the closest command when a mistyped command is passed to the built binary', () => {
      const run = runBuiltCli(['stauts'], tempDir);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).not.toContain('Vitest');
      expect(run.stdout + run.stderr).toContain('status');
      expect(run.stderr).toContain('Did you mean "status"?');

      const jsonRun = runBuiltCli(['stauts', '--json'], tempDir);
      expect(jsonRun.exitCode).toBe(1);
      const parsedError = JSON.parse(jsonRun.stderr);
      expect(parsedError.suggestion).toBe('status');
    });

    it('runs fake source commands from the built binary in a standalone Node process', () => {
      const runPipeline = runBuiltCli(
        ['run', '--fake', '--headless', '--json', '--timeout', '100'],
        tempDir
      );
      expect(runPipeline.stderr).not.toContain('Error');
      expect(runPipeline.exitCode).toBe(0);
      const parsedRun = JSON.parse(runPipeline.stdout);
      expect(parsedRun.ok).toBe(true);
      expect(parsedRun.processedCount).toBeGreaterThan(0);

      const historyRun = runBuiltCli(
        ['history', 'import', 'fake', '--since', '2026-11-01', '--json'],
        tempDir
      );
      expect(historyRun.stderr).not.toContain('Error');
      expect(historyRun.exitCode).toBe(0);
      const parsedHistory = JSON.parse(historyRun.stdout);
      expect(parsedHistory.ok).toBe(true);
      expect(parsedHistory.importedCount).toBeGreaterThan(0);
    });

    it('never loads vitest or contract test suites in the CLI runtime import graph', () => {
      const graph = collectRuntimeImportGraph(cliDistPath);
      expect(graph.externalSpecifiers).not.toContain('vitest');
      expect(
        graph.visitedFiles.some((f) => f.includes('describe-source-contract'))
      ).toBe(false);
      expect(
        graph.visitedFiles.some((f) => f.includes('describe-sink-contract'))
      ).toBe(false);

      const cliUrl = pathToFileURL(cliIndexDistPath).href;
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
        `await import(${JSON.stringify(cliUrl)});`,
        'console.log(JSON.stringify(resolved));',
      ].join('\n');

      const probe = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: repoRoot,
          env: cleanChildEnv(tempDir),
          encoding: 'utf-8',
          timeout: 30_000,
        }
      );

      expect(probe.stderr).not.toContain('Vitest');
      expect(probe.status).toBe(0);
      const resolvedSpecifiers = JSON.parse(probe.stdout.trim()) as string[];
      expect(resolvedSpecifiers).not.toContain('vitest');
    });
  });

  describe('Scenario 12: App Health Telemetry and Verdicts (Feature C-9)', () => {
    const buildSyntheticMessage = (id: string): Message => ({
      id,
      network: 'fake',
      account: 'rep-synthetic-01',
      thread: 'chat-synthetic-01',
      threadKind: 'dm',
      direction: 'inbound',
      time: '2026-11-06T10:00:00.000Z',
      from: { accountId: 'cust-synthetic-01', displayName: 'Synthetic Buyer' },
      to: [{ accountId: 'rep-synthetic-01', displayName: 'Synthetic Rep' }],
      text: 'Synthetic order confirmation message.',
    });

    beforeEach(() => {
      vi.spyOn(process, 'cpuUsage').mockImplementation((prev?: NodeJS.CpuUsage) => {
        if (prev) {
          return { user: 500, system: 500 };
        }
        return { user: 10_000, system: 5_000 };
      });
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 120 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 60 * 1024 * 1024,
        external: 2 * 1024 * 1024,
        arrayBuffers: 1 * 1024 * 1024,
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('exports named threshold constants matching ADR 0013 and spec C-9', () => {
      expect(CPU_SAMPLE_INTERVAL_MS).toBe(100);
      expect(CPU_SLOW_PERCENT).toBe(5);
      expect(CPU_PROBLEM_PERCENT).toBe(15);
      expect(MEMORY_SLOW_MB).toBe(250);
      expect(MEMORY_PROBLEM_MB).toBe(400);
      expect(QUEUE_SLOW_THRESHOLD).toBe(100);
      expect(QUEUE_WAIT_SLOW_SECONDS).toBe(30);
      expect(SINK_DOWN_HALT_MS).toBe(5 * 60 * 1000);
      expect(ERROR_WINDOW_MS).toBe(15 * 60 * 1000);
      expect(MESSAGE_RATE_WINDOW_MS).toBe(60 * 1000);
    });

    it('reports cpuPercent, messagesPerMinute, errorCount, RSS memory, and health: good when healthy', async () => {
      const cpuSpy = vi.spyOn(process, 'cpuUsage');
      const jsonRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(jsonRes.exitCode).toBe(0);

      const parsed = JSON.parse(jsonRes.stdout);
      expect(typeof parsed.telemetry.cpuPercent).toBe('number');
      expect(parsed.telemetry.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(parsed.telemetry.cpuPercent).toBeLessThan(CPU_SLOW_PERCENT);
      expect(parsed.telemetry.memoryUsageMb).toBe(120);
      expect(parsed.telemetry.messagesPerMinute).toBe(0);
      expect(parsed.telemetry.errorCount).toBe(0);
      expect(parsed.telemetry.health).toBe('good');

      // Verify process.cpuUsage was sampled twice (initial reading and differential reading)
      expect(cpuSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(cpuSpy.mock.calls[1]?.[0]).toEqual({ user: 10_000, system: 5_000 });

      const textRes = await executeCli(['status'], { dataDir: tempDir });
      expect(textRes.exitCode).toBe(0);
      const healthLines = textRes.stdout.split('\n').filter((l) => l.startsWith('App health:'));
      expect(healthLines).toEqual(['App health: good']);
    });

    it('computes messagesPerMinute from recent outbox messages and ignores messages older than 1 minute', async () => {
      const archiveDir = path.join(tempDir, 'archive');
      await executeCli(['sink', 'add', 'archive', archiveDir, '--json'], { dataDir: tempDir });

      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');
      const ctx = new CliContext(tempDir);
      const outbox = ctx.getOutbox();

      try {
        // Message from 3 minutes ago (outside 1-minute rate window)
        nowSpy.mockReturnValue(realNow - 3 * 60 * 1000);
        await outbox.enqueue(buildSyntheticMessage('msg-old-1'), ['archive']);

        // Three messages within the last 60 seconds
        nowSpy.mockReturnValue(realNow - 20 * 1000);
        await outbox.enqueue(buildSyntheticMessage('msg-recent-1'), ['archive']);
        await outbox.enqueue(buildSyntheticMessage('msg-recent-2'), ['archive']);
        await outbox.enqueue(buildSyntheticMessage('msg-recent-3'), ['archive']);

        const pending = await outbox.getPendingDeliveries('archive', 10, realNow);
        for (const item of pending) {
          await outbox.markDelivered(item.deliveryId);
        }
      } finally {
        outbox.close();
        ctx.close();
        nowSpy.mockRestore();
      }

      const res = await executeCli(['status', '--json'], { dataDir: tempDir });
      const parsed = JSON.parse(res.stdout);
      expect(parsed.telemetry.messagesPerMinute).toBe(3);
      expect(parsed.telemetry.errorCount).toBe(0);
      expect(parsed.telemetry.health).toBe('good');
    });

    it('reports slow (not problem) on a single recent refusal under 5 minutes and counts errorCount', async () => {
      const archiveDir = path.join(tempDir, 'archive');
      await executeCli(['sink', 'add', 'archive', archiveDir, '--json'], { dataDir: tempDir });

      const ctx = new CliContext(tempDir);
      const outbox = ctx.getOutbox();
      try {
        await outbox.enqueue(buildSyntheticMessage('msg-refused-recent'), ['archive']);
        const pending = await outbox.getPendingDeliveries('archive', 10, Date.now());
        await outbox.markRefused(pending[0]!.deliveryId, 'Rejected by destination');
      } finally {
        outbox.close();
        ctx.close();
      }

      const jsonRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.telemetry.errorCount).toBe(1);
      expect(parsed.outbox.archive.deadLetterCount).toBe(1);
      expect(parsed.sinks.archive.health).toBe('degraded');
      expect(parsed.telemetry.health).toBe('slow');

      const textRes = await executeCli(['status'], { dataDir: tempDir });
      expect(textRes.stdout.split('\n')).toContain('App health: slow');
    });

    it('reports problem when a sink has halted delivery due to permanent errors for more than 5 minutes', async () => {
      const archiveDir = path.join(tempDir, 'archive');
      await executeCli(['sink', 'add', 'archive', archiveDir, '--json'], { dataDir: tempDir });

      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');
      const ctx = new CliContext(tempDir);
      const outbox = ctx.getOutbox();

      try {
        nowSpy.mockReturnValue(realNow - 6 * 60 * 1000);
        await outbox.enqueue(buildSyntheticMessage('msg-halt-1'), ['archive']);
        const firstBatch = await outbox.getPendingDeliveries('archive', 10, realNow);
        await outbox.markRefused(firstBatch[0]!.deliveryId, 'Destination credentials revoked');

        nowSpy.mockReturnValue(realNow - 1 * 60 * 1000);
        await outbox.enqueue(buildSyntheticMessage('msg-halt-2'), ['archive']);
        const secondBatch = await outbox.getPendingDeliveries('archive', 10, realNow);
        await outbox.markRefused(secondBatch[0]!.deliveryId, 'Destination credentials revoked');
      } finally {
        outbox.close();
        ctx.close();
        nowSpy.mockRestore();
      }

      const jsonRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.telemetry.errorCount).toBe(2);
      expect(parsed.sinks.archive.health).toBe('down');
      expect(parsed.telemetry.health).toBe('problem');

      const textRes = await executeCli(['status'], { dataDir: tempDir });
      expect(textRes.stdout.split('\n')).toContain('App health: problem');
    });

    it('ignores refused deliveries older than 15 minutes and recovers sink health after a subsequent delivery', async () => {
      const archiveDir = path.join(tempDir, 'archive');
      await executeCli(['sink', 'add', 'archive', archiveDir, '--json'], { dataDir: tempDir });

      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');
      const ctx = new CliContext(tempDir);
      const outbox = ctx.getOutbox();

      try {
        // Refusal 20 minutes ago (outside the 15-minute window)
        nowSpy.mockReturnValue(realNow - 20 * 60 * 1000);
        await outbox.enqueue(buildSyntheticMessage('msg-20m-old'), ['archive']);
        const oldBatch = await outbox.getPendingDeliveries('archive', 10, realNow);
        await outbox.markRefused(oldBatch[0]!.deliveryId, 'Expired token 20m ago');
      } finally {
        outbox.close();
        ctx.close();
        nowSpy.mockRestore();
      }

      const afterOldRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const afterOldParsed = JSON.parse(afterOldRes.stdout);
      expect(afterOldParsed.telemetry.errorCount).toBe(0);
      expect(afterOldParsed.sinks.archive.health).toBe('ok');
      expect(afterOldParsed.telemetry.health).toBe('good');

      // Now add a 6-minute-old refusal followed by a successful delivery 1 minute ago
      const nowSpy2 = vi.spyOn(Date, 'now');
      const ctx2 = new CliContext(tempDir);
      const outbox2 = ctx2.getOutbox();
      try {
        nowSpy2.mockReturnValue(realNow - 6 * 60 * 1000);
        await outbox2.enqueue(buildSyntheticMessage('msg-6m-refused'), ['archive']);
        const refusedBatch = await outbox2.getPendingDeliveries('archive', 10, realNow);
        await outbox2.markRefused(refusedBatch[0]!.deliveryId, 'Temporary rejection');

        nowSpy2.mockReturnValue(realNow - 1 * 60 * 1000);
        await outbox2.enqueue(buildSyntheticMessage('msg-1m-delivered'), ['archive']);
        const deliveredBatch = await outbox2.getPendingDeliveries('archive', 10, realNow);
        await outbox2.markDelivered(deliveredBatch[0]!.deliveryId);
      } finally {
        outbox2.close();
        ctx2.close();
        nowSpy2.mockRestore();
      }

      const recoveredRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const recoveredParsed = JSON.parse(recoveredRes.stdout);
      expect(recoveredParsed.telemetry.errorCount).toBe(1);
      expect(recoveredParsed.sinks.archive.health).toBe('ok');
      expect(recoveredParsed.telemetry.health).toBe('good');
    });

    it('reports slow when a sink is in transient retry backoff (HTTP 429) or disabled', async () => {
      const archiveDir = path.join(tempDir, 'archive');
      await executeCli(['sink', 'add', 'archive', archiveDir, '--json'], { dataDir: tempDir });

      const ctx = new CliContext(tempDir);
      const outbox = ctx.getOutbox();
      try {
        await outbox.enqueue(buildSyntheticMessage('msg-429'), ['archive']);
        const pending = await outbox.getPendingDeliveries('archive', 10, Date.now());
        await outbox.markFailed(
          pending[0]!.deliveryId,
          'Rate limit exceeded (HTTP 429)',
          Date.now() + 30_000
        );
      } finally {
        outbox.close();
        ctx.close();
      }

      const backoffRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const backoffParsed = JSON.parse(backoffRes.stdout);
      expect(backoffParsed.sinks.archive.health).toBe('degraded');
      expect(backoffParsed.telemetry.health).toBe('slow');
    });

    it('reports slow when queue depth exceeds 100 messages or oldest pending message waits over 30 seconds', async () => {
      const archiveDir = path.join(tempDir, 'archive');
      await executeCli(['sink', 'add', 'archive', archiveDir, '--json'], { dataDir: tempDir });

      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');
      const ctx = new CliContext(tempDir);
      const outbox = ctx.getOutbox();

      try {
        // 1 pending message waiting for 45 seconds (> 30s threshold)
        nowSpy.mockReturnValue(realNow - 45 * 1000);
        await outbox.enqueue(buildSyntheticMessage('msg-wait-45s'), ['archive']);
      } finally {
        outbox.close();
        ctx.close();
        nowSpy.mockRestore();
      }

      const ageRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const ageParsed = JSON.parse(ageRes.stdout);
      expect(ageParsed.outbox.archive.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(45);
      expect(ageParsed.sinks.archive.health).toBe('degraded');
      expect(ageParsed.telemetry.health).toBe('slow');

      // Clear the old message and enqueue 101 fresh messages (> 100 queue threshold)
      const ctx2 = new CliContext(tempDir);
      const outbox2 = ctx2.getOutbox();
      try {
        const oldPending = await outbox2.getPendingDeliveries('archive', 10, Date.now());
        for (const item of oldPending) {
          await outbox2.markDelivered(item.deliveryId);
        }
        for (let i = 0; i < 101; i++) {
          await outbox2.enqueue(buildSyntheticMessage(`msg-burst-${i}`), ['archive']);
        }
      } finally {
        outbox2.close();
        ctx2.close();
      }

      const depthRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const depthParsed = JSON.parse(depthRes.stdout);
      expect(depthParsed.outbox.archive.pendingCount).toBe(101);
      expect(depthParsed.sinks.archive.health).toBe('degraded');
      expect(depthParsed.telemetry.health).toBe('slow');
    });

    it('evaluates memory (RSS) thresholds: under 250 MB good, 250 to 400 MB slow, over 400 MB problem', async () => {
      // 300 MB RSS -> slow
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 300 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 80 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      const slowRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const slowParsed = JSON.parse(slowRes.stdout);
      expect(slowParsed.telemetry.memoryUsageMb).toBe(300);
      expect(slowParsed.telemetry.health).toBe('slow');

      // 450 MB RSS -> problem
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 450 * 1024 * 1024,
        heapTotal: 150 * 1024 * 1024,
        heapUsed: 120 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      const problemRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const problemParsed = JSON.parse(problemRes.stdout);
      expect(problemParsed.telemetry.memoryUsageMb).toBe(450);
      expect(problemParsed.telemetry.health).toBe('problem');
    });

    it('evaluates CPU thresholds: 5% to 15% slow, over 15% problem', async () => {
      // ~10% CPU over 100ms (10,000 us out of 100,000 us) -> slow
      vi.spyOn(process, 'cpuUsage').mockImplementation((prev?: NodeJS.CpuUsage) => {
        if (prev) {
          return { user: 8_000, system: 2_000 };
        }
        return { user: 0, system: 0 };
      });

      const slowRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const slowParsed = JSON.parse(slowRes.stdout);
      expect(slowParsed.telemetry.cpuPercent).toBeGreaterThanOrEqual(CPU_SLOW_PERCENT);
      expect(slowParsed.telemetry.cpuPercent).toBeLessThanOrEqual(CPU_PROBLEM_PERCENT);
      expect(slowParsed.telemetry.health).toBe('slow');

      // ~40% CPU over 100ms (40,000 us out of 100,000 us) -> problem
      vi.spyOn(process, 'cpuUsage').mockImplementation((prev?: NodeJS.CpuUsage) => {
        if (prev) {
          return { user: 30_000, system: 10_000 };
        }
        return { user: 0, system: 0 };
      });

      const problemRes = await executeCli(['status', '--json'], { dataDir: tempDir });
      const problemParsed = JSON.parse(problemRes.stdout);
      expect(problemParsed.telemetry.cpuPercent).toBeGreaterThan(CPU_PROBLEM_PERCENT);
      expect(problemParsed.telemetry.health).toBe('problem');
    });
  });
});
