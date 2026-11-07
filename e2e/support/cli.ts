import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const cliPath = path.join(repoRoot, 'packages/cli/dist/cli.js');

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A throwaway data folder, so each test starts like a fresh install. */
export function freshDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-e2e-'));
}

/** Runs the built `chat-bridge` binary the way a user would, in a separate process. */
export function runCli(args: string[], dataDir: string = freshDataDir()): CliRun {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`${cliPath} is missing. Run pnpm build first.`);
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, CHAT_BRIDGE_DATA_DIR: dataDir },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
