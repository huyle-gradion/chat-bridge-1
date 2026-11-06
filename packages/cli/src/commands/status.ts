import type { SourceStatus, SinkHealthStatus, OutboxStats } from '@chat-bridge/types';
import type { CliContext } from '../config.js';

export interface CliStatusOutput {
  sources: Record<string, SourceStatus>;
  sinks: Record<string, SinkHealthStatus>;
  outbox: Record<string, OutboxStats>;
  telemetry: {
    memoryUsageMb: number;
    uptimeSeconds: number;
  };
  isPaused: boolean;
}

export async function handleStatus(
  ctx: CliContext,
  isJson: boolean
): Promise<{ stdout: string; exitCode: number }> {
  const settings = ctx.getSettings();
  const outbox = ctx.getOutbox();

  const sources: Record<string, SourceStatus> = {
    whatsapp: {
      state: 'needs-login',
      reason: 'WhatsApp account not linked',
      updatedAt: new Date().toISOString(),
    },
    zalo: {
      state: 'needs-login',
      reason: 'Zalo account not linked',
      updatedAt: new Date().toISOString(),
    },
  };

  const sinks: Record<string, SinkHealthStatus> = {};
  const outboxStats: Record<string, OutboxStats> = {};

  const configuredSinkEntries = Object.entries(settings.sinks);
  if (configuredSinkEntries.length === 0) {
    sinks['none'] = {
      health: 'ok',
      reason: 'No destinations configured yet',
    };
  } else {
    for (const [name, sinkEntry] of configuredSinkEntries) {
      sinks[name] = {
        health: sinkEntry.enabled ? 'ok' : 'degraded',
        reason: sinkEntry.enabled
          ? 'Destination configured and active'
          : 'Destination disabled',
      };
      const pendingCount = await outbox.getQueueCount(name);
      outboxStats[name] = {
        pendingCount,
        inFlightCount: 0,
        deadLetterCount: 0,
      };
    }
  }

  const mem = process.memoryUsage();
  const statusOutput: CliStatusOutput = {
    sources,
    sinks,
    outbox: outboxStats,
    telemetry: {
      memoryUsageMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
      uptimeSeconds: Math.floor(process.uptime()),
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
  lines.push('Health:');
  lines.push(`  - Memory: ${statusOutput.telemetry.memoryUsageMb} MB`);
  lines.push(`  - Uptime: ${statusOutput.telemetry.uptimeSeconds} seconds`);

  return {
    stdout: lines.join('\n'),
    exitCode: 0,
  };
}
