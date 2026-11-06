import type { FilterDecision, FilterSettings, Message } from '@chat-bridge/types';

export interface PolicyFilterOptions {
  allowGroups?: boolean;
  blockedContacts?: string[];
  otpFilterEnabled?: boolean;
  otpRegexPatterns?: string[];
  customBlockedPatterns?: string[];
}

export interface PolicyFilterResult extends FilterDecision {
  userFacingLabel?: string | undefined;
}

const DEFAULT_OTP_PATTERNS = [
  // Combined pattern matching verification phrases and codes
  /(\b(?:verification\s+code|security\s+code|login\s+code|passcode|ma\s+xac\s+thuc|mã\s+xác\s+thực|ma\s+otp)\b[^\n\r]{0,40}\b\d{4,8}\b)/i,
  /(\b\d{4,8}\b[^\n\r]{0,40}\b(?:is\s+your\s+verification\s+code|la\s+ma\s+xac\s+thuc|la\s+ma\s+otp)\b)/i,
  /(\b(?:OTP|code)[\s:=]+[A-Z0-9]{4,8}\b)/i,
  /(\bma\s+otp\s+cua\s+ban\s+la\s+\d{4,8}\b)/i,
  /(\bmã\s+xác\s+thực\s+(?:của\s+bạn\s+)?là[\s:]*\d{4,8}\b)/i,
  /(\bma\s+xac\s+thuc[\s:]*\d{4,8}\b)/i,
];

export class PolicyFilter {
  private allowGroups: boolean;
  private blockedContacts: Set<string>;
  private otpFilterEnabled: boolean;
  private otpRegexPatterns: RegExp[];
  private customPatterns: RegExp[];

  constructor(options: PolicyFilterOptions = {}) {
    this.allowGroups = options.allowGroups ?? false;
    this.blockedContacts = new Set((options.blockedContacts ?? []).map((c) => this.normalizeContact(c)));
    this.otpFilterEnabled = options.otpFilterEnabled ?? true;

    if (options.otpRegexPatterns && options.otpRegexPatterns.length > 0) {
      this.otpRegexPatterns = options.otpRegexPatterns.map((p) => new RegExp(p, 'i'));
    } else {
      this.otpRegexPatterns = [...DEFAULT_OTP_PATTERNS];
    }

    this.customPatterns = (options.customBlockedPatterns ?? []).map((p) => new RegExp(p, 'i'));
  }

  public evaluate(message: Message): PolicyFilterResult {
    // 1. Group Policy Check (Stage 4)
    if (message.threadKind === 'group' && !this.allowGroups) {
      return {
        drop: true,
        reason: 'group_disabled',
        userFacingLabel: 'Blocked: Group chats disabled',
        ruleTriggered: 'group_policy_disabled',
      };
    }

    // 2. Blocked Contacts Check
    if (this.isSenderBlocked(message)) {
      return {
        drop: true,
        reason: 'blocked_contact',
        userFacingLabel: 'Blocked: Contact on blocklist',
        ruleTriggered: 'contact_in_blocklist',
      };
    }

    // 3. OTP and Verification Code Check
    if (this.otpFilterEnabled && message.text) {
      const textToScan = message.text;
      for (const pattern of this.otpRegexPatterns) {
        if (pattern.test(textToScan)) {
          return {
            drop: true,
            reason: 'otp_regex',
            userFacingLabel: 'Blocked: Security code detected',
            ruleTriggered: `pattern:${pattern.source}`,
          };
        }
      }
    }

    // 4. Custom Blocked Patterns
    if (message.text && this.customPatterns.length > 0) {
      for (const pattern of this.customPatterns) {
        if (pattern.test(message.text)) {
          return {
            drop: true,
            reason: 'otp_regex',
            userFacingLabel: 'Blocked: Security code detected',
            ruleTriggered: `custom_pattern:${pattern.source}`,
          };
        }
      }
    }

    return { drop: false };
  }

  public setAllowGroups(allow: boolean): void {
    this.allowGroups = allow;
  }

  public isAllowGroups(): boolean {
    return this.allowGroups;
  }

  public blockContact(contact: string): void {
    this.blockedContacts.add(this.normalizeContact(contact));
  }

  public unblockContact(contact: string): void {
    this.blockedContacts.delete(this.normalizeContact(contact));
  }

  public isContactBlocked(contact: string): boolean {
    return this.blockedContacts.has(this.normalizeContact(contact));
  }

  public getBlockedContacts(): string[] {
    return Array.from(this.blockedContacts);
  }

  public setOtpFilterEnabled(enabled: boolean): void {
    this.otpFilterEnabled = enabled;
  }

  public isOtpFilterEnabled(): boolean {
    return this.otpFilterEnabled;
  }

  public addCustomBlockedPattern(pattern: string): void {
    this.customPatterns.push(new RegExp(pattern, 'i'));
  }

  public removeCustomBlockedPattern(pattern: string): void {
    this.customPatterns = this.customPatterns.filter((p) => p.source !== pattern);
  }

  public getSettings(): FilterSettings {
    return {
      allowGroups: this.allowGroups,
      blockedContacts: this.getBlockedContacts(),
      otpRegexPatterns: this.otpRegexPatterns.map((p) => p.source),
      customBlockedPatterns: this.customPatterns.map((p) => p.source),
    };
  }

  private isSenderBlocked(message: Message): boolean {
    const candidates = [
      message.from.accountId,
      message.from.phone,
      message.thread,
    ].filter((c): c is string => typeof c === 'string' && c.trim() !== '');

    for (const candidate of candidates) {
      if (this.blockedContacts.has(this.normalizeContact(candidate))) {
        return true;
      }
    }

    return false;
  }

  private normalizeContact(contact: string): string {
    const trimmed = contact.trim().toLowerCase();
    // Strip leading + and non-alphanumeric except @ and .
    return trimmed.replace(/^\+/, '').replace(/[\s\-()]/g, '');
  }
}
