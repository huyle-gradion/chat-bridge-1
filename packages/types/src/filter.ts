export type MessageDropReason =
  | 'reaction'
  | 'typing'
  | 'story'
  | 'newsletter'
  | 'edit'
  | 'unticked_chat'
  | 'blocked_contact'
  | 'otp_regex'
  | 'group_disabled'
  | 'unsupported_media'
  | 'rate_limited';

export interface FilterDecision {
  /** True if the message must be dropped from ingestion */
  drop: boolean;

  /** Category reason for dropping */
  reason?: MessageDropReason | undefined;

  /** Anonymized audit rule description (no customer PII) */
  ruleTriggered?: string | undefined;
}

export interface FilterSettings {
  /** Whether group chats are permitted to be ingested (false by default) */
  allowGroups: boolean;

  /** List of blocked phone numbers, contact IDs, or JIDs */
  blockedContacts: string[];

  /** List of regex patterns identifying one-time passwords / 2FA verification codes */
  otpRegexPatterns: string[];

  /** Additional user-defined drop regex patterns */
  customBlockedPatterns?: string[] | undefined;
}
