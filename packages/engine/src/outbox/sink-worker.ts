import type { SinkContract, DeliveryOutcome } from '@chat-bridge/types';
import type { Outbox, PendingDelivery } from './outbox.js';

export interface SinkWorkerOptions {
  capacity?: number | undefined;
  refillRatePerSec?: number | undefined;
  baseBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  maxJitterMs?: number | undefined;
}

export class SinkWorker {
  private readonly sink: SinkContract;
  private readonly outbox: Outbox;

  // Token Bucket Pacing
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private tokens: number;
  private lastRefillTime: number;

  // Backoff and Pacing State
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxJitterMs: number;
  private pausedUntil: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;

  constructor(sink: SinkContract, outbox: Outbox, options: SinkWorkerOptions = {}) {
    this.sink = sink;
    this.outbox = outbox;

    const rpm = sink.limits?.requestsPerMinute ?? 60;
    this.refillRatePerSec = options.refillRatePerSec ?? Math.max(0.1, rpm / 60);
    this.capacity = options.capacity ?? Math.max(1, Math.min(10, sink.limits?.batchSize ?? 10));
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();

    this.baseBackoffMs = options.baseBackoffMs ?? 2000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300000;
    this.maxJitterMs = options.maxJitterMs ?? 500;
  }

  public isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  public pause(durationMs: number): void {
    const jitter = this.maxJitterMs > 0 ? Math.floor(Math.random() * this.maxJitterMs) : 0;
    this.pausedUntil = Date.now() + durationMs + jitter;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillTime) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
      this.lastRefillTime = now;
    }
  }

  public async processBatch(): Promise<number> {
    if (this.isPaused()) {
      return 0;
    }

    this.refillTokens();
    if (this.tokens < 1) {
      return 0;
    }

    const batchSize = this.sink.limits?.batchSize ?? 10;
    const pendingDeliveries = await this.outbox.getPendingDeliveries(
      this.sink.sinkId,
      batchSize,
      Date.now()
    );

    if (pendingDeliveries.length === 0) {
      return 0;
    }

    this.tokens -= 1;
    const messages = pendingDeliveries.map((d) => d.message);

    let outcomes: DeliveryOutcome[];
    try {
      outcomes = await this.sink.deliver(messages);
    } catch (err) {
      // Entire batch failed due to network / unexpected exception
      const errorMsg = err instanceof Error ? err.message : 'Unknown delivery error';
      await this.handleBatchError(pendingDeliveries, errorMsg);
      return 0;
    }

    await this.applyOutcomes(pendingDeliveries, outcomes);
    return pendingDeliveries.length;
  }

  private async applyOutcomes(
    pendingDeliveries: PendingDelivery[],
    outcomes: DeliveryOutcome[]
  ): Promise<void> {
    const outcomeMap = new Map<string, DeliveryOutcome>();
    for (const outcome of outcomes) {
      outcomeMap.set(outcome.messageId, outcome);
    }

    for (const delivery of pendingDeliveries) {
      const outcome = outcomeMap.get(delivery.message.id);

      if (!outcome) {
        // No explicit outcome returned; treat as transient failure
        await this.handleTransientFailure(delivery, 'No delivery outcome returned by sink');
        continue;
      }

      if (outcome.outcome === 'accepted' || outcome.outcome === 'duplicate') {
        await this.outbox.markDelivered(delivery.deliveryId);
      } else if (outcome.outcome === 'refused') {
        if (outcome.statusCode === 429) {
          // HTTP 429: Rate limited
          const retryAfterMs = outcome.retryAfterMs ?? 2000;
          this.pause(retryAfterMs);
          await this.outbox.markFailed(
            delivery.deliveryId,
            outcome.reason ?? 'Rate limit exceeded (HTTP 429)',
            this.pausedUntil
          );
        } else {
          // Permanent rejection (e.g. 400 / 401 / permission denied): DO NOT RETRY
          await this.outbox.markRefused(
            delivery.deliveryId,
            outcome.reason ?? 'Message delivery permanently refused by destination'
          );
        }
      }
    }
  }

  private async handleBatchError(
    deliveries: PendingDelivery[],
    errorMessage: string
  ): Promise<void> {
    for (const delivery of deliveries) {
      await this.handleTransientFailure(delivery, errorMessage);
    }
  }

  private async handleTransientFailure(
    delivery: PendingDelivery,
    errorMessage: string
  ): Promise<void> {
    const jitter = this.maxJitterMs > 0 ? Math.floor(Math.random() * this.maxJitterMs) : 0;
    const exponential = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * Math.pow(2, delivery.attempts)
    );
    const retryDelay = exponential + jitter;
    const nextRetryAt = Date.now() + retryDelay;

    await this.outbox.markFailed(delivery.deliveryId, errorMessage, nextRetryAt);
  }

  public start(pollIntervalMs: number = 1000): void {
    if (this.running) {
      return;
    }
    this.running = true;

    const tick = async () => {
      if (!this.running) {
        return;
      }
      try {
        await this.processBatch();
      } catch {
        // Worker loop safety
      }
      if (this.running) {
        this.timer = setTimeout(tick, pollIntervalMs);
      }
    };

    this.timer = setTimeout(tick, 0);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
