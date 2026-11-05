import type { Person } from './person.js';

export type NetworkKind = 'zalo' | 'whatsapp' | 'whatsapp-biz' | 'fake';

export type ThreadKind = 'dm' | 'group';

export type MessageDirection = 'inbound' | 'outbound';

export interface AttachmentPlaceholder {
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';
  filename?: string | undefined;
  filesize?: number | undefined; // Size in bytes if available
  formatted: string; // e.g. "[image: invoice.jpg, 1.2 MB]"
}

/**
 * Normalized canonical message representation.
 * Every source normalizes events into this shape.
 * Every sink receives this shape.
 * Spec Section 5.
 */
export interface Message {
  /** Unique composite ID: <network>:<account>:<native id>. Used to remove duplicates. */
  id: string;

  /** Network source of the message */
  network: NetworkKind;

  /** The sales rep's own account identifier on that network */
  account: string;

  /** The chat identifier (group id or 1:1 contact id) */
  thread: string;

  /** Thread classification */
  threadKind: ThreadKind;

  /** Message direction ('outbound' indicates sent by the rep) */
  direction: MessageDirection;

  /** ISO 8601 formatted timestamp with timezone */
  time: string;

  /** Sender metadata */
  from: Person;

  /** Direct recipient(s) for a 1:1 chat */
  to: Person[];

  /** Group participants list, maximum 50. Omitted if group exceeds 50 participants */
  participants?: Person[] | undefined;

  /** Message body text. Maximum 32,768 characters. If truncated, truncated is true. */
  text: string;

  /** Indicates whether the text was cut at the 32,768-char code-point boundary */
  truncated?: boolean | undefined;

  /** Human-readable placeholder for media, e.g. "[image: invoice.jpg, 1.2 MB]" */
  placeholder?: string | undefined;

  /** Underlying native message ID provided by the network */
  rawNativeId?: string | undefined;
}
