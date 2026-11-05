import type { SourceStatus } from './source.js';
import type { SinkHealthStatus } from './sink.js';
import type { OutboxStats } from './outbox.js';

export interface OverallSystemStatus {
  /** Map of registered source IDs to their current connection status */
  sources: Record<string, SourceStatus>;

  /** Map of registered sink IDs to their current health status */
  sinks: Record<string, SinkHealthStatus>;

  /** Map of active sink IDs to their outbox queue statistics */
  outbox: Record<string, OutboxStats>;

  /** Global pause state (Feature C-5: Pause and Resume) */
  isPaused: boolean;
}

