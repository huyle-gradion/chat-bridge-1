import type { Message, NetworkKind } from './message.js';
import type { ThreadSummary } from './thread.js';

export type SourceState = 'connected' | 'needs-login' | 'taken-over' | 'error';

export interface SourceStatus {
  state: SourceState;
  /** Plain-language reason describing current status */
  reason: string;
  /** ISO 8601 timestamp of last state transition */
  updatedAt: string;
  /** Account identifier if currently authenticated */
  account?: string | undefined;
}

export type LoginEventType = 'qr' | 'pairing-code' | 'authenticated' | 'error';

export interface LoginEvent {
  type: LoginEventType;
  /** QR code representation (data URL or raw payload for rendering) */
  qrData?: string | undefined;
  /** Alphanumeric pairing code for phone-number linking */
  pairingCode?: string | undefined;
  /** Plain-language instruction or error */
  message?: string | undefined;
}

export type OnMessageCallback = (message: Message) => Promise<void> | void;
export type OnLoginEventCallback = (event: LoginEvent) => void;

export interface SendResult {
  ok: boolean;
  messageId?: string | undefined;
  error?: string | undefined;
}

export interface HistoryProgress {
  fetchedCount: number;
  totalEstimated?: number | undefined;
  oldestTime?: string | undefined;
}

/**
 * Standard Source Provider Contract.
 * Concrete sources (Fake, Zalo, WhatsApp) implement this interface.
 * Spec Section 6.
 */
export interface SourceContract {
  readonly network: NetworkKind;
  readonly account: string;

  /**
   * Shows a QR code or pairing code in the wizard, web UI, and CLI.
   * Encrypts and persists session credentials securely.
   */
  login(onEvent?: OnLoginEventCallback): Promise<SourceStatus>;

  /**
   * Starts reading inbound/outbound messages and passes them to the engine callback.
   * Must be idempotent.
   */
  start(onMessage: OnMessageCallback): Promise<void>;

  /**
   * Stops reading messages and cleanly closes network connections.
   * Must be idempotent.
   */
  stop(): Promise<void>;

  /**
   * Reports current connection health in plain language:
   * 'connected', 'needs-login', 'taken-over', or 'error'.
   */
  status(): Promise<SourceStatus>;

  /**
   * Lists the rep's chats (name, DM or group, last message time) for the Chat Picker.
   */
  chats(): Promise<ThreadSummary[]>;

  /**
   * Ingests older messages with progress reporting back to `since` (ISO 8601).
   */
  history(since: string, onProgress?: (progress: HistoryProgress) => void): AsyncIterable<Message> | Promise<Message[]>;

  /**
   * Sends a reply to a chat thread.
   * MUST ONLY be called after a human explicitly clicked Send in the UI.
   */
  send(thread: string, text: string): Promise<SendResult>;
}
