import type { SourceStatus, SinkHealthStatus, OutboxStats } from '@chat-bridge/types';
import type { CliContext } from '../config.js';

export const CPU_SAMPLE_INTERVAL_MS = 100;
export const CPU_SLOW_PERCENT = 5;
export const CPU_PROBLEM_PERCENT = 15;
export const MEMORY_SLOW_MB = 250;
export const MEMORY_PROBLEM_MB = 400;
export const QUEUE_SLOW_THRESHOLD = 100;
export const QUEUE_WAIT_SLOW_SECONDS = 30;
export const SINK_DOWN_HALT_MS = 5 * 60 * 1000;
export const ERROR_WINDOW_MS = 15 * 60 * 1000;
export const MESSAGE_RATE_WINDOW_MS = 60 * 1000;

export interface CliStatusOutput {
  sources: Record<string, SourceStatus>;
  sinks: Record<string, SinkHealthStatus>;
  outbox: Record<string, OutboxStats>;
  telemetry: {
    cpuPercent: number;
    memoryUsageMb: number;
    messagesPerMinute: number;
    errorCount: number;
    uptimeSeconds: number;
    health: 'good' | 'slow' | 'problem';
  };
  isPaused: boolean;
}

export async function handleStatus(
  ctx: CliContext,
  isJson: boolean
): Promise<{ stdout: string; exitCode: number }> {
  const settings = ctx.getSettings();
  const outbox = ctx.getOutbox();

  const startCpu = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_INTERVAL_MS));
  const diffCpu = process.cpuUsage(startCpu);
  const cpuPercent =
    Math.round(((diffCpu.user + diffCpu.system) / (CPU_SAMPLE_INTERVAL_MS * 1000)) * 100 * 10) /
    10;

  const now = Date.now();

  const sources: Record<string, SourceStatus> = {
    whatsapp: {
      state: 'needs-login',
      reason: 'WhatsApp account not linked',
      updatedAt: new Date(now).toISOString(),
    },
    zalo: {
      state: 'needs-login',
      reason: 'Zalo account not linked',
      updatedAt: new Date(now).toISOString(),
    },
  };

  const sinks: Record<string, SinkHealthStatus> = {};
  const outboxStats: Record<string, OutboxStats> = {};

  let messagesPerMinute = 0;
  let errorCount = 0;

  try {
    messagesPerMinute = await outbox.getRecentMessageCount(MESSAGE_RATE_WINDOW_MS, now);
    errorCount = await outbox.getRecentErrorCount(ERROR_WINDOW_MS, now);

    const configuredSinkEntries = Object.entries(settings.sinks);
    if (configuredSinkEntries.length === 0) {
      sinks['none'] = {
        health: 'ok',
        reason: 'No destinations configured yet',
      };
    } else {
      for (const [name, sinkEntry] of configuredSinkEntries) {
        const stats = await outbox.getSinkStats(name, now, ERROR_WINDOW_MS);
        outboxStats[name] = {
          pendingCount: stats.pendingCount,
          inFlightCount: stats.inFlightCount,
          deadLetterCount: stats.deadLetterCount,
          oldestPendingAgeSeconds: stats.oldestPendingAgeSeconds,
        };

        if (!sinkEntry.enabled) {
          sinks[name] = {
            health: 'degraded',
            reason: 'Destination disabled',
          };
        } else if (
          stats.unrecoveredFailureCount > 0 &&
          stats.oldestUnrecoveredFailureAgeMs >= SINK_DOWN_HALT_MS
        ) {
          sinks[name] = {
            health: 'down',
            reason: stats.lastError ?? 'Destination halted due to repeated errors',
          };
        } else if (
          stats.unrecoveredFailureCount > 0 ||
          stats.retryingCount > 0 ||
          stats.pendingCount > QUEUE_SLOW_THRESHOLD ||
          stats.oldestPendingAgeSeconds > QUEUE_WAIT_SLOW_SECONDS
        ) {
          sinks[name] = {
            health: 'degraded',
            reason: stats.lastError ?? 'Destination delivery is slowed or backed up',
          };
        } else {
          sinks[name] = {
            health: 'ok',
            reason: 'Destination configured and active',
          };
        }
      }
    }
  } finally {
    outbox.close();
  }

  const mem = process.memoryUsage();
  const memoryUsageMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;

  const sinkStates = Object.values(sinks);
  const hasDownSink = sinkStates.some((s) => s.health === 'down');
  const hasDegradedSink = sinkStates.some((s) => s.health === 'degraded');

  let health: 'good' | 'slow' | 'problem' = 'good';
  if (
    hasDownSink ||
    memoryUsageMb > MEMORY_PROBLEM_MB ||
    cpuPercent > CPU_PROBLEM_PERCENT
  ) {
    health = 'problem';
  } else if (
    hasDegradedSink ||
    memoryUsageMb >= MEMORY_SLOW_MB ||
    cpuPercent >= CPU_SLOW_PERCENT
  ) {
    health = 'slow';
  }

  const statusOutput: CliStatusOutput = {
    sources,
    sinks,
    outbox: outboxStats,
    telemetry: {
      cpuPercent,
      memoryUsageMb,
      messagesPerMinute,
      errorCount,
      uptimeSeconds: Math.floor(process.uptime()),
      health,
    },
    isPaused: false,
  };

  if (isJson) {
    return {
      stdout: JSON.stringify(statusOutput, null, 2),
      exitCode: 0,
    };
  }

  // Format human-readable output using plain English without banned technical jargon
  const lines: string[] = [];
  lines.push('Chat Bridge Status');
  lines.push('==================');
  lines.push('');
  lines.push('Sources:');
  for (const [srcName, srcStat] of Object.entries(sources)) {
    lines.push(`  - ${srcName}: ${srcStat.state} (${srcStat.reason})`);
  }

  lines.push('');
  lines.push('Where to send:');
  for (const [sinkName, sinkStat] of Object.entries(sinks)) {
    lines.push(`  - ${sinkName}: ${sinkStat.health} (${sinkStat.reason})`);
  }

  lines.push('');
  lines.push('Waiting messages:');
  if (Object.keys(outboxStats).length === 0) {
    lines.push('  No active queues.');
  } else {
    for (const [qName, qStat] of Object.entries(outboxStats)) {
      lines.push(
        `  - ${qName}: ${qStat.pendingCount} waiting, ${qStat.inFlightCount} in flight, ${qStat.deadLetterCount} failed`
      );
    }
  }

  lines.push('');
  lines.push(`App health: ${statusOutput.telemetry.health}`);
  lines.push('Health:');
  lines.push(`  - CPU: ${statusOutput.telemetry.cpuPercent}%`);
  lines.push(`  - Memory: ${statusOutput.telemetry.memoryUsageMb} MB`);
  lines.push(`  - Messages per minute: ${statusOutput.telemetry.messagesPerMinute}`);
  lines.push(`  - Recent errors: ${statusOutput.telemetry.errorCount}`);
  lines.push(`  - Uptime: ${statusOutput.telemetry.uptimeSeconds} seconds`);

  return {
    stdout: lines.join('\n'),
    exitCode: 0,
  };
}
