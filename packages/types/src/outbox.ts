export type OutboxItemStatus =
  | 'pending'
  | 'in_flight'
  | 'delivered'
  | 'failed'
  | 'dead_letter';

export interface OutboxItem {
  /** Internal queue item identifier (numeric auto-increment or UUID) */
  id: string;

  /** Normalized Message ID */
  messageId: string;

  /** Target sink identifier (one independent queue per sink) */
  sinkId: string;

  /** Encrypted or serialized message payload */
  payloadJson: string;

  /** Current processing state */
  status: OutboxItemStatus;

  /** Number of delivery attempts performed so far */
  attempts: number;

  /** ISO 8601 timestamp after which the next delivery attempt may be executed */
  nextAttemptAt: string;

  /** Plain-language description of the last delivery failure */
  lastError?: string | undefined;

  /** ISO 8601 timestamp when message was enqueued */
  createdAt: string;

  /** ISO 8601 timestamp of last state update */
  updatedAt: string;
}

export interface OutboxStats {
  /** Messages waiting to be delivered */
  pendingCount: number;

  /** Messages currently in flight to the sink */
  inFlightCount: number;

  /** Messages that exceeded max retry limit without acceptance */
  deadLetterCount: number;

  /** Age in seconds of the oldest pending message */
  oldestPendingAgeSeconds?: number | undefined;
}
