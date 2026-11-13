import type {
  ConfigureResult,
  DeliveryOutcome,
  Message,
  SinkContract,
  SinkHealthStatus,
  SinkLimits,
  TestResult,
} from '@chat-bridge/types';

/**
 * Placeholder: every method throws until the Archive destination is built, so a test
 * written against it can be imported and fails on its own.
 */
export class ArchiveSink implements SinkContract {
  public readonly sinkId: string = '';
  public readonly name: string = '';
  public readonly limits: SinkLimits = { batchSize: 0, requestsPerMinute: 0 };

  public configure(_settings: Record<string, unknown>): Promise<ConfigureResult> {
    throw new Error('not implemented');
  }

  public test(): Promise<TestResult> {
    throw new Error('not implemented');
  }

  public deliver(_batch: Message[]): Promise<DeliveryOutcome[]> {
    throw new Error('not implemented');
  }

  public health(): Promise<SinkHealthStatus> {
    throw new Error('not implemented');
  }
}
