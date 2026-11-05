export interface NetworkFaultOptions {
  latencyMs?: number;
  rateLimitStatus?: number; // 429
  retryAfterSec?: number;
  serverErrorStatus?: number; // 500 or 503
  failureRate?: number; // 0.0 to 1.0 probability of drop
}

export class SimulatedNetwork {
  private latencyMs: number = 0;
  private rateLimitRemaining: number = 0;
  private rateLimitRetryAfterSec: number = 1;
  private serverErrorRemaining: number = 0;
  private serverErrorCode: number = 503;
  private failureRate: number = 0;

  constructor(options: NetworkFaultOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    if (options.rateLimitStatus === 429) {
      this.rateLimitRemaining = 1;
      this.rateLimitRetryAfterSec = options.retryAfterSec ?? 1;
    }
    if (options.serverErrorStatus) {
      this.serverErrorRemaining = 1;
      this.serverErrorCode = options.serverErrorStatus;
    }
    this.failureRate = options.failureRate ?? 0;
  }

  public setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  public simulateRateLimit(count: number = 1, retryAfterSec: number = 1): void {
    this.rateLimitRemaining = count;
    this.rateLimitRetryAfterSec = retryAfterSec;
  }

  public simulateServerError(count: number = 1, statusCode: number = 503): void {
    this.serverErrorRemaining = count;
    this.serverErrorCode = statusCode;
  }

  public setFailureRate(rate: number): void {
    this.failureRate = Math.max(0, Math.min(1, rate));
  }

  public reset(): void {
    this.latencyMs = 0;
    this.rateLimitRemaining = 0;
    this.serverErrorRemaining = 0;
    this.failureRate = 0;
  }

  /**
   * Executes a simulated network request, applying injected faults.
   */
  public async execute<T>(action: () => Promise<T>): Promise<T> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining--;
      const error: any = new Error('HTTP 429: Too Many Requests');
      error.status = 429;
      error.retryAfter = this.rateLimitRetryAfterSec;
      throw error;
    }

    if (this.serverErrorRemaining > 0) {
      this.serverErrorRemaining--;
      const error: any = new Error(`HTTP ${this.serverErrorCode}: Service Unavailable`);
      error.status = this.serverErrorCode;
      throw error;
    }

    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      const error: any = new Error('ECONNRESET: Connection dropped unexpectedly');
      error.code = 'ECONNRESET';
      throw error;
    }

    return action();
  }
}

