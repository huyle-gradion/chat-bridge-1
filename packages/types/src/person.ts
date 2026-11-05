/**
 * Represents an individual participant or sender in a chat thread.
 * Per spec.md Section 5:
 * phone is only populated if the network gave it, never guessed.
 */
export interface Person {
  accountId: string;
  displayName: string;
  phone?: string | undefined;
  lid?: string | undefined; // WhatsApp Linked Identity Device ID (ADR 0004)
}
