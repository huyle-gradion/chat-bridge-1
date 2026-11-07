// Measures the built app: start time, and CPU, memory and time for a 500-message import.
// Usage: pnpm build && pnpm bench [label]   (writes bench/results/<label>.json)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Import the builder file directly: the package index also loads the vitest contract suites.
import { ScenarioBuilder } from '../packages/testing/dist/scenarios/scenario-builder.js';

const RUNS = 5;
const IMPORT_SIZE = 500;
const MESSAGES_PER_CONTACT = 2;

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchDir, '..');
const cliPath = path.join(repoRoot, 'packages/cli/dist/cli.js');
const probePath = path.join(benchDir, 'probe.mjs');

interface Sample {
  wallMs: number;
  cpuMs: number;
  maxRssMb: number;
}

function runMeasured(args: string[], dataDir: string): Sample & { stdout: string } {
  const probeOut = path.join(dataDir, `probe-${Date.now()}.json`);
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, ['--import', probePath, cliPath, ...args], {
    env: { ...process.env, CHAT_BRIDGE_DATA_DIR: dataDir, BENCH_PROBE_OUT: probeOut },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) {
    throw new Error(`chat-bridge ${args.join(' ')} exited ${result.status}:\n${result.stderr}`);
  }
  const probe = JSON.parse(fs.readFileSync(probeOut, 'utf-8')) as { maxRssKb: number; cpuMs: number };
  return { wallMs, cpuMs: probe.cpuMs, maxRssMb: probe.maxRssKb / 1024, stdout: result.stdout };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function writeFixture(dir: string): string {
  const messages = new ScenarioBuilder({ seed: 7 })
    .withContacts(IMPORT_SIZE / MESSAGES_PER_CONTACT)
    .build();
  if (messages.length !== IMPORT_SIZE) {
    throw new Error(`Fixture has ${messages.length} messages, expected ${IMPORT_SIZE}`);
  }
  const file = path.join(dir, 'import-500.json');
  fs.writeFileSync(file, JSON.stringify(messages));
  return file;
}

function commit(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' });
  return result.stdout.trim() || 'unknown';
}

const label = process.argv[2] ?? 'local';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-bench-'));
const fixture = writeFixture(work);

const start: Sample[] = [];
const importRuns: Sample[] = [];
for (let i = 0; i < RUNS; i++) {
  start.push(runMeasured(['--version'], fs.mkdtempSync(path.join(work, 'start-'))));

  const run = runMeasured(['run', '--fake', fixture, '--json'], fs.mkdtempSync(path.join(work, 'import-')));
  const processed = (JSON.parse(run.stdout) as { processedCount: number }).processedCount;
  if (processed !== IMPORT_SIZE) {
    throw new Error(`Import processed ${processed} of ${IMPORT_SIZE} messages`);
  }
  importRuns.push(run);
}

const report = {
  label,
  commit: commit(),
  node: process.version,
  platform: `${os.platform()}-${os.arch()}`,
  runs: RUNS,
  medians: {
    startMs: round(median(start.map((s) => s.wallMs))),
    startMaxRssMb: round(median(start.map((s) => s.maxRssMb))),
    import500Ms: round(median(importRuns.map((s) => s.wallMs))),
    import500CpuMs: round(median(importRuns.map((s) => s.cpuMs))),
    import500MaxRssMb: round(median(importRuns.map((s) => s.maxRssMb))),
  },
};

const resultsDir = path.join(benchDir, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, `${label}.json`), JSON.stringify(report, null, 2) + '\n');
fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
