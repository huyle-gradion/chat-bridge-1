import type { DeliveryOutcome, Message } from '@chat-bridge/types';
import type { ArchivedIds } from './archived-ids.js';

/** Placeholder: throws until the batch writer is built. */
export function writeBatch(
  _folder: string,
  _archived: ArchivedIds,
  _batch: Message[],
): Promise<DeliveryOutcome[]> {
  throw new Error('not implemented');
}
