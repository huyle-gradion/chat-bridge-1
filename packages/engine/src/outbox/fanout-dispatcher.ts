import type { SinkContract, Message } from '@chat-bridge/types';
import type { Outbox } from './outbox.js';
import { SinkWorker, type SinkWorkerOptions } from './sink-worker.js';

export class FanOutDispatcher {
  private readonly outbox: Outbox;
  private readonly sinks = new Map<string, SinkContract>();
  private readonly workers = new Map<string, SinkWorker>();

  constructor(outbox: Outbox) {
    this.outbox = outbox;
  }

  public registerSink(sink: SinkContract, workerOptions?: SinkWorkerOptions): SinkWorker {
    this.sinks.set(sink.sinkId, sink);
    const worker = new SinkWorker(sink, this.outbox, workerOptions);
    this.workers.set(sink.sinkId, worker);
    return worker;
  }

  public unregisterSink(sinkId: string): void {
    const worker = this.workers.get(sinkId);
    if (worker) {
      worker.stop();
      this.workers.delete(sinkId);
    }
    this.sinks.delete(sinkId);
  }

  public getActiveSinkIds(): string[] {
    return Array.from(this.sinks.keys());
  }

  public getWorker(sinkId: string): SinkWorker | undefined {
    return this.workers.get(sinkId);
  }

  public async dispatch(message: Message): Promise<void> {
    const sinkIds = this.getActiveSinkIds();
    if (sinkIds.length === 0) {
      return;
    }
    await this.outbox.enqueue(message, sinkIds);
  }

  public async processAll(): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    const tasks = Array.from(this.workers.entries()).map(async ([sinkId, worker]) => {
      try {
        const count = await worker.processBatch();
        results.set(sinkId, count);
      } catch {
        results.set(sinkId, 0);
      }
    });

    await Promise.allSettled(tasks);
    return results;
  }

  public async isMessageComplete(messageId: string): Promise<boolean> {
    return this.outbox.isMessageDelivered(messageId);
  }

  public async purgeCompleted(maxAgeMs: number = 0): Promise<number> {
    return this.outbox.purgeCompletedMessages(maxAgeMs);
  }

  public start(): void {
    for (const worker of this.workers.values()) {
      worker.start();
    }
  }

  public stop(): void {
    for (const worker of this.workers.values()) {
      worker.stop();
    }
  }
}
