#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { CliContext } from './config.js';
import { handleStatus } from './commands/status.js';
import { handleChats } from './commands/chats.js';
import { handleFilters } from './commands/filters.js';
import { handleLogin } from './commands/login.js';
import { handleSink } from './commands/sink.js';
import { handleRun } from './commands/run.js';
import { handleHistory } from './commands/history.js';
import { handleUi } from './commands/ui.js';

export interface CliExecutionOptions {
  cwd?: string | undefined;
  dataDir?: string | undefined;
  env?: Record<string, string> | undefined;
}

export interface CliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const VERSION = '0.1.0';

const KNOWN_COMMANDS = [
  'status',
  'chats',
  'filters',
  'login',
  'sink',
  'run',
  'history',
  'ui',
] as const;

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
      }
    }
  }

  return dp[m]![n]!;
}

function findClosestCommand(input: string, maxDistance = 2): string | undefined {
  const normalized = input.toLowerCase();
  let bestMatch: string | undefined;
  let bestDistance = maxDistance + 1;

  for (const cmd of KNOWN_COMMANDS) {
    const dist = editDistance(normalized, cmd);
    if (dist <= maxDistance && dist < bestDistance) {
      bestDistance = dist;
      bestMatch = cmd;
    }
  }

  return bestMatch;
}

const HELP_TEXT = `Chat Bridge CLI - Universal Messaging Connector

Usage:
  chat-bridge <command> [options]

Commands:
  status                                 Show connection health, message counts, and telemetry
  chats [list | pick <id> | unpick <id>] Manage conversations authorized to send messages
  filters [show | set <k> <v> | block]   Manage security code and contact filters
  login <zalo | whatsapp | whatsapp-biz> Authenticate with a chat network
  sink add <type> "<config>"             Add a destination (margince, archive, database, sheet)
  sink [test | list | remove <name>]     Manage configured destinations
  run [--fake <fixture>] [--headless]    Start message ingestion and delivery pipeline
  history import <network> [--since <d>] Import older message history
  ui [--port <port>]                     Launch local web interface

Options:
  --json                                 Output structured JSON
  --data-dir <path>                      Custom configuration directory (default: ~/.chat-bridge)
  -h, --help                             Show this help message
  -v, --version                          Show version number
`;

export async function executeCli(
  args: string[],
  options: CliExecutionOptions = {}
): Promise<CliExecutionResult> {
  let isJson = false;
  let customDataDir: string | undefined = options.dataDir;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      isJson = true;
    } else if (arg === '--data-dir') {
      customDataDir = args[i + 1];
      i++;
    } else if (arg === '-h' || arg === '--help') {
      return {
        exitCode: 0,
        stdout: HELP_TEXT,
        stderr: '',
      };
    } else if (arg === '-v' || arg === '--version') {
      return {
        exitCode: 0,
        stdout: `chat-bridge ${VERSION}\n`,
        stderr: '',
      };
    } else if (arg !== undefined) {
      filteredArgs.push(arg);
    }
  }

  if (filteredArgs.length === 0) {
    return {
      exitCode: 0,
      stdout: HELP_TEXT,
      stderr: '',
    };
  }

  const command = filteredArgs[0]?.toLowerCase();
  const commandArgs = filteredArgs.slice(1);
  const ctx = new CliContext(customDataDir);

  try {
    let result: { stdout: string; stderr?: string; exitCode: number };

    switch (command) {
      case 'status':
        result = await handleStatus(ctx, isJson);
        break;

      case 'chats':
        result = await handleChats(ctx, commandArgs, isJson);
        break;

      case 'filters':
        result = await handleFilters(ctx, commandArgs, isJson);
        break;

      case 'login':
        result = await handleLogin(ctx, commandArgs, isJson);
        break;

      case 'sink':
        result = await handleSink(ctx, commandArgs, isJson);
        break;

      case 'run':
        result = await handleRun(ctx, commandArgs, isJson);
        break;

      case 'history':
        result = await handleHistory(ctx, commandArgs, isJson);
        break;

      case 'ui':
        result = await handleUi(ctx, commandArgs, isJson);
        break;

      default: {
        const suggestion = command ? findClosestCommand(command) : undefined;
        const errorMsg = suggestion
          ? `Unknown command: "${command}". Did you mean "${suggestion}"? Run "chat-bridge --help" for available commands.`
          : `Unknown command: "${command}". Run "chat-bridge --help" for available commands.`;
        if (isJson) {
          const errorObj = suggestion
            ? { error: errorMsg, suggestion }
            : { error: errorMsg };
          return {
            exitCode: 1,
            stdout: '',
            stderr: JSON.stringify(errorObj, null, 2),
          };
        }
        return {
          exitCode: 1,
          stdout: '',
          stderr: errorMsg,
        };
      }
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
    };
  } finally {
    ctx.close();
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executeCli(process.argv.slice(2)).then((res) => {
    if (res.stdout) {
      process.stdout.write(res.stdout + '\n');
    }
    if (res.stderr) {
      process.stderr.write(res.stderr + '\n');
    }
    process.exit(res.exitCode);
  });
}
