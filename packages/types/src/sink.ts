import type { Message } from './message.js';
import type { Person } from './person.js';

export type SinkHealth = 'ok' | 'degraded' | 'down';

export type DeliveryStatus = 'accepted' | 'duplicate' | 'refused';

export interface DeliveryOutcome {
  /** The message ID from Message.id */
  messageId: string;

  /** Result outcome for this individual message */
  outcome: DeliveryStatus;

  /** Plain-language reason if refused or duplicate */
  reason?: string | undefined;

  /** HTTP or sink-specific status code if applicable */
  statusCode?: number | undefined;

  /** Suggested retry delay in milliseconds on rate-limits (HTTP 429) */
  retryAfterMs?: number | undefined;
}

export interface ConfigureResult {
  valid: boolean;
  /** Field-level error messages in plain language */
  errors?: Record<string, string> | undefined;
}

export interface TestResult {
  ok: boolean;
  /** Plain-language explanation of test connection result */
  message: string;
  /** Optional metadata about the remote service */
  details?: Record<string, unknown> | undefined;
}

export interface SinkLimits {
  /** Maximum number of messages delivered in a single batch call */
  batchSize: number;

  /** Maximum allowed delivery requests per minute */
  requestsPerMinute: number;

  /** Default backoff delay in ms when encountering transient errors */
  defaultBackoffMs?: number | undefined;
}

export interface SinkHealthStatus {
  health: SinkHealth;

  /** Plain-language reason describing the health state */
  reason: string;

  /** ISO 8601 timestamp of last successful delivery */
  lastSuccessfulDelivery?: string | undefined;

  /** Count of consecutive delivery failures */
  consecutiveFailures?: number | undefined;
}

export interface InboundReply {
  replyId: string;
  thread: string;
  text: string;
  time: string;
  sender: Person;
}

export interface ReplyAck {
  replyId: string;
  status: 'sent' | 'failed';
  error?: string | undefined;
}

/**
 * Standard Sink Provider Contract.
 * Concrete sinks (Archive, Local DB, Sheets, Margince) implement this interface.
 * Spec Section 6.
 */
export interface SinkContract {
  readonly sinkId: string;
  readonly name: string;
  readonly limits: SinkLimits;

  /**
   * Checks sink settings. Gives a clear plain-language error for each invalid field.
   */
  configure(settings: Record<string, unknown>): Promise<ConfigureResult>;

  /**
   * One safe call that proves settings and connectivity work.
   * Wizard shows the result in plain language.
   */
  test(): Promise<TestResult>;

  /**
   * Delivers a batch of normalized messages.
   * Returns one result per message: accepted, duplicate, or refused.
   */
  deliver(batch: Message[]): Promise<DeliveryOutcome[]>;

  /**
   * Reports health status: ok, degraded, or down.
   */
  health(): Promise<SinkHealthStatus>;

  /**
   * Optional: Polls for replies from sink back to chat (e.g. Margince, should scope).
   */
  pullReplies?(max: number): Promise<InboundReply[]>;

  /**
   * Optional: Acknowledges processed replies to the sink.
   */
  ack?(results: ReplyAck[]): Promise<void>;
}
