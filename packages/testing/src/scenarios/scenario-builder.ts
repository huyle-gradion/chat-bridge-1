import type {
  Message,
  Person,
  NetworkKind,
} from '@chat-bridge/types';

/**
 * 32-bit PRNG (Mulberry32) for deterministic, reproducible test scenarios.
 */
function createPrng(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScenarioBuilderOptions {
  seed?: number | undefined;
  repAccount?: string | undefined;
  repDisplayName?: string | undefined;
  network?: NetworkKind | undefined;
}

export interface SyntheticScenario {
  messages: Message[];
  contacts: Person[];
  expectedNoiseMessageIds: string[];
  expectedOtpMessageIds: string[];
}

export class ScenarioBuilder {
  private readonly rng: () => number;
  private readonly repAccount: string;
  private readonly repDisplayName: string;
  private readonly network: NetworkKind;
  private contactCount: number = 3;
  private otpCodes: string[] = [];
  private longTextLengths: number[] = [];
  private noiseItems: Array<'reaction' | 'typing' | 'story' | 'newsletter' | 'edit'> = [];
  private lidMappings: Array<{ phone: string; lid: string }> = [];
  private mediaItems: Array<{ type: string; filename: string; sizeBytes: number }> = [];

  constructor(options: ScenarioBuilderOptions = {}) {
    this.rng = createPrng(options.seed ?? 42);
    this.repAccount = options.repAccount ?? 'rep-sales-01';
    this.repDisplayName = options.repDisplayName ?? 'Dylan Rep';
    this.network = options.network ?? 'fake';
  }

  public withContacts(count: number): this {
    this.contactCount = count;
    return this;
  }

  public withOtpCode(code: string): this {
    this.otpCodes.push(code);
    return this;
  }

  public withLongText(length: number): this {
    this.longTextLengths.push(length);
    return this;
  }

  public withNoise(kinds: Array<'reaction' | 'typing' | 'story' | 'newsletter' | 'edit'>): this {
    this.noiseItems.push(...kinds);
    return this;
  }

  public withLidMapping(phone: string, lid: string): this {
    this.lidMappings.push({ phone, lid });
    return this;
  }

  public withMedia(type: string, filename: string, sizeBytes: number): this {
    this.mediaItems.push({ type, filename, sizeBytes });
    return this;
  }

  public build(): Message[] {
    return this.buildScenario().messages;
  }

  public buildScenario(): SyntheticScenario {
    const messages: Message[] = [];
    const expectedNoiseMessageIds: string[] = [];
    const expectedOtpMessageIds: string[] = [];

    const rep: Person = {
      accountId: this.repAccount,
      displayName: this.repDisplayName,
      phone: '+84901234567',
    };

    // 1. Generate Contacts (strictly using synthetic numbers)
    const contacts: Person[] = [];
    for (let i = 1; i <= this.contactCount; i++) {
      const paddedId = String(i).padStart(3, '0');
      const lidPair = this.lidMappings[i - 1];
      contacts.push({
        accountId: `cust-${paddedId}`,
        displayName: `Synthetic Customer ${i}`,
        phone: lidPair ? lidPair.phone : `+84900000${paddedId}`,
        lid: lidPair ? lidPair.lid : undefined,
      });
    }

    let msgCounter = 1;
    const baseTime = new Date('2026-11-05T08:00:00.000Z').getTime();

    // 2. Generate standard dialogue between rep and contacts
    for (const contact of contacts) {
      const threadId = `thread-dm-${contact.accountId}`;
      const jitterMs = Math.floor(this.rng() * 1000);
      const timeStr = new Date(baseTime + msgCounter * 60000 + jitterMs).toISOString();

      // Inbound inquiry
      const inboundMsg: Message = {
        id: `${this.network}:${this.repAccount}:msg-${msgCounter++}`,
        network: this.network,
        account: this.repAccount,
        thread: threadId,
        threadKind: 'dm',
        direction: 'inbound',
        time: timeStr,
        from: contact,
        to: [rep],
        text: `Hello, this is an automated synthetic inquiry from ${contact.displayName}.`,
      };
      messages.push(inboundMsg);

      // Outbound reply
      const replyTimeStr = new Date(baseTime + msgCounter * 60000).toISOString();
      const outboundMsg: Message = {
        id: `${this.network}:${this.repAccount}:msg-${msgCounter++}`,
        network: this.network,
        account: this.repAccount,
        thread: threadId,
        threadKind: 'dm',
        direction: 'outbound',
        time: replyTimeStr,
        from: rep,
        to: [contact],
        text: `Thank you for reaching out. Here is our product catalog.`,
      };
      messages.push(outboundMsg);
    }

    // 3. Inject OTP codes
    for (const otp of this.otpCodes) {
      const contact = contacts[0] ?? rep;
      const id = `${this.network}:${this.repAccount}:msg-otp-${msgCounter++}`;
      messages.push({
        id,
        network: this.network,
        account: this.repAccount,
        thread: `thread-dm-${contact.accountId}`,
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date(baseTime + msgCounter * 60000).toISOString(),
        from: contact,
        to: [rep],
        text: `Your security verification code is ${otp}. Please do not disclose it to anyone.`,
      });
      expectedOtpMessageIds.push(id);
    }

    // 4. Inject Long Text (e.g. 40k chars to test 32,768 cutoff)
    for (const len of this.longTextLengths) {
      const contact = contacts[0] ?? rep;
      const id = `${this.network}:${this.repAccount}:msg-long-${msgCounter++}`;
      const charChunk = 'Synthetic lore ipsum repetitive test data for boundary validation. ';
      const repeated = charChunk.repeat(Math.ceil(len / charChunk.length)).slice(0, len);

      messages.push({
        id,
        network: this.network,
        account: this.repAccount,
        thread: `thread-dm-${contact.accountId}`,
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date(baseTime + msgCounter * 60000).toISOString(),
        from: contact,
        to: [rep],
        text: repeated,
      });
    }

    // 5. Inject Noise Events (reactions, stories, typing, edits)
    for (const noiseKind of this.noiseItems) {
      const contact = contacts[0] ?? rep;
      const id = `${this.network}:${this.repAccount}:msg-noise-${noiseKind}-${msgCounter++}`;
      expectedNoiseMessageIds.push(id);

      let noiseText = '';
      let placeholder: string | undefined;

      switch (noiseKind) {
        case 'reaction':
          noiseText = '❤️';
          break;
        case 'typing':
          noiseText = '[typing...]';
          break;
        case 'story':
          noiseText = '[story broadcast update]';
          break;
        case 'newsletter':
          noiseText = '[newsletter broadcast]';
          break;
        case 'edit':
          noiseText = '[message edited]';
          break;
      }

      messages.push({
        id,
        network: this.network,
        account: this.repAccount,
        thread: `thread-dm-${contact.accountId}`,
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date(baseTime + msgCounter * 60000).toISOString(),
        from: contact,
        to: [rep],
        text: noiseText,
        placeholder,
      });
    }

    // 6. Inject Media Placeholders
    for (const media of this.mediaItems) {
      const contact = contacts[0] ?? rep;
      const id = `${this.network}:${this.repAccount}:msg-media-${msgCounter++}`;
      const mbSize = (media.sizeBytes / (1024 * 1024)).toFixed(1);

      messages.push({
        id,
        network: this.network,
        account: this.repAccount,
        thread: `thread-dm-${contact.accountId}`,
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date(baseTime + msgCounter * 60000).toISOString(),
        from: contact,
        to: [rep],
        text: '',
        placeholder: `[${media.type}: ${media.filename}, ${mbSize} MB]`,
      });
    }

    return {
      messages,
      contacts,
      expectedNoiseMessageIds,
      expectedOtpMessageIds,
    };
  }
}
