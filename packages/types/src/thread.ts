import type { NetworkKind, ThreadKind } from './message.js';

export interface ThreadSummary {
  /** Thread unique identifier */
  id: string;

  /** Network of the thread */
  network: NetworkKind;

  /** Account identifier of the rep */
  account: string;

  /** Display name of the chat or contact */
  name: string;

  /** Kind of chat */
  kind: ThreadKind;

  /** ISO 8601 timestamp of the most recent message in the chat */
  lastMessageTime?: string | undefined;

  /** Number of participants (for group chats) */
  participantCount?: number | undefined;

  /** Display avatar URL or local placeholder */
  avatarUrl?: string | undefined;

  /** Ticked status in Chat Picker (only ticked chats leave the computer) */
  isTicked?: boolean | undefined;
}
