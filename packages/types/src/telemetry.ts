export type TelemetryEventName =
  | 'engine_started'
  | 'engine_stopped'
  | 'source_connected'
  | 'source_disconnected'
  | 'batch_delivered'
  | 'batch_failed'
  | 'filter_dropped'
  | 'crash_recovered';

export interface TelemetryEvent {
  eventName: TelemetryEventName;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Anonymous salted installation UUID */
  anonymousInstallId: string;
  /** Anonymized properties: message counts, latency ms, error categories (NEVER chat content or PII) */
  properties: Record<string, string | number | boolean>;
}

export interface TelemetrySink {
  record(event: TelemetryEvent): void;
  flush(): Promise<void>;
}

