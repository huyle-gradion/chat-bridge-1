import type { Message } from '@chat-bridge/types';

/** Name of the UTC-day file for an ISO time, or undefined if the time is invalid. */
export function dayFileName(time: string): string | undefined {
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return undefined;
  return `${new Date(ms).toISOString().slice(0, 10)}.jsonl`;
}

/** One JSON line for a message, ending in a single newline. */
export function messageLine(message: Message): string {
  return `${JSON.stringify(message)}\n`;
}
