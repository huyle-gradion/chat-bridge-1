import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import type {
  SourceContract,
  SourceStatus,
  ThreadSummary,
  Message,
  SendResult,
  NetworkKind,
  OnMessageCallback,
  OnLoginEventCallback,
  HistoryProgress,
} from '@chat-bridge/types';
import { SessionStore } from './auth/session-store.js';
import { IdentityStore } from './identity/identity-store.js';
import { validateAndCleanPhoneNumber } from './auth/phone-number.js';
import type {
  WhatsAppSocketAdapter,
  AuthenticatedUser,
  RawInboundMessage,
} from './socket/socket-adapter.js';
import { MockWhatsAppSocket } from './socket/mock-socket-adapter.js';

export interface WhatsAppSourceOptions {
  dbPath: string;
  masterKey: Buffer;
  account?: string | undefined;
  socketAdapter?: WhatsAppSocketAdapter | undefined;
}

export interface IdentityMappingInput {
  aliasId: string;
  primaryPhone: string;
  displayName?: string | undefined;
}

export class WhatsAppSource implements SourceContract {
  public network: NetworkKind = 'whatsapp';
  public account: string;

  private readonly db: Database;
  private readonly sessionStore: SessionStore;
  private readonly identityStore: IdentityStore;
  private readonly socket: WhatsAppSocketAdapter;

  private currentStatus: SourceStatus;
  private onMessageCallback: OnMessageCallback | null = null;
  private isStarted: boolean = false;
  private knownThreads = new Map<string, ThreadSummary>();
  private messageBuffer: Message[] = [];

  constructor(options: WhatsAppSourceOptions) {
    this.account = options.account ?? 'whatsapp-account';

    const dbDir = path.dirname(options.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new DatabaseConstructor(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.sessionStore = new SessionStore(this.db, options.masterKey, 'whatsapp');
    this.identityStore = new IdentityStore(this.db, 'whatsapp');
    this.socket = options.socketAdapter ?? new MockWhatsAppSocket();

    // Check for saved session
    const savedUser = this.sessionStore.get<AuthenticatedUser>('credentials');
    if (savedUser) {
      this.account = savedUser.phone;
      this.network = savedUser.isBusiness ? 'whatsapp-biz' : 'whatsapp';
      this.currentStatus = {
        state: 'connected',
        reason: 'Restored saved WhatsApp session',
        updatedAt: new Date().toISOString(),
        account: savedUser.phone,
      };
      if (this.socket instanceof MockWhatsAppSocket) {
        this.socket.currentUser = savedUser;
      }
      this.socket.connect().catch(() => {});
    } else {
      this.currentStatus = {
        state: 'needs-login',
        reason: 'WhatsApp authentication required',
        updatedAt: new Date().toISOString(),
      };
    }

    this.setupSocketListeners();
  }

  private setupSocketListeners(): void {
    this.socket.onConnected((user) => {
      this.account = user.phone;
      this.network = user.isBusiness ? 'whatsapp-biz' : 'whatsapp';
      this.currentStatus = {
        state: 'connected',
        reason: 'WhatsApp connected successfully',
        updatedAt: new Date().toISOString(),
        account: user.phone,
      };
      this.sessionStore.set('credentials', user);
    });

    this.socket.onDisconnected((reason) => {
      this.currentStatus = {
        state: 'needs-login',
        reason: `Disconnected: ${reason}`,
        updatedAt: new Date().toISOString(),
        account: this.account,
      };
    });

    this.socket.onMessage((raw) => {
      this.handleInboundRawMessage(raw);
    });
  }

  public async login(onEvent?: OnLoginEventCallback): Promise<SourceStatus> {
    if (onEvent) {
      this.socket.onQr((qrData, message) => {
        onEvent({
          type: 'qr',
          qrData,
          message,
        });
      });
    }

    await this.socket.connect();

    return new Promise((resolve) => {
      if (this.currentStatus.state === 'connected') {
        resolve(this.currentStatus);
        return;
      }

      this.socket.onConnected((user) => {
        const status: SourceStatus = {
          state: 'connected',
          reason: 'WhatsApp connected successfully',
          updatedAt: new Date().toISOString(),
          account: user.phone,
        };
        resolve(status);
      });
    });
  }

  public async loginWithPairingCode(
    phoneNumber: string,
    onEvent?: OnLoginEventCallback
  ): Promise<SourceStatus> {
    const cleaned = validateAndCleanPhoneNumber(phoneNumber);

    if (onEvent) {
      this.socket.onPairingCode((pairingCode, ttlSeconds) => {
        onEvent({
          type: 'pairing-code',
          pairingCode,
          message: `Enter code on phone within ${ttlSeconds} seconds`,
        });
      });
    }

    await this.socket.requestPairingCode(cleaned);

    return new Promise((resolve) => {
      if (this.currentStatus.state === 'connected') {
        resolve(this.currentStatus);
        return;
      }

      this.socket.onConnected((user) => {
        const status: SourceStatus = {
          state: 'connected',
          reason: 'WhatsApp connected successfully',
          updatedAt: new Date().toISOString(),
          account: user.phone,
        };
        resolve(status);
      });
    });
  }

  public async start(onMessage: OnMessageCallback): Promise<void> {
    this.onMessageCallback = onMessage;
    this.isStarted = true;
  }

  public async stop(): Promise<void> {
    this.isStarted = false;
    this.onMessageCallback = null;
    await this.socket.disconnect();
  }

  public async status(): Promise<SourceStatus> {
    return { ...this.currentStatus };
  }

  public async chats(): Promise<ThreadSummary[]> {
    return Array.from(this.knownThreads.values());
  }

  public async history(
    since: string,
    onProgress?: (progress: HistoryProgress) => void
  ): Promise<Message[]> {
    const sinceTimestamp = new Date(since).getTime();
    const filtered = this.messageBuffer.filter((m) => new Date(m.time).getTime() >= sinceTimestamp);

    if (onProgress) {
      onProgress({
        fetchedCount: filtered.length,
        totalEstimated: filtered.length,
        oldestTime: filtered[0]?.time,
      });
    }

    return filtered;
  }

  public async send(thread: string, text: string): Promise<SendResult> {
    try {
      const messageId = await this.socket.sendMessage(thread, text);
      return { ok: true, messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Send failed';
      return { ok: false, error };
    }
  }

  public async registerIdentityMapping(mapping: IdentityMappingInput): Promise<void> {
    this.identityStore.setMapping(mapping.aliasId, mapping.primaryPhone, mapping.displayName);
  }

  public getSessionRecordCount(): number {
    return this.sessionStore.count();
  }

  public close(): void {
    this.socket.close();
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  private handleInboundRawMessage(raw: RawInboundMessage): void {
    const remoteJid = raw.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const rawParticipant = raw.key.participant ?? (raw.key.fromMe ? this.account : remoteJid);

    const cleanParticipantJid = stripDeviceSuffix(rawParticipant);
    const bareParticipant = cleanParticipantJid.replace(/@s\.whatsapp\.net|@lid/g, '');

    // Identity mapping resolution: resolve LID to primary phone
    const resolvedAccountId = this.identityStore.resolve(bareParticipant);
    const displayName =
      this.identityStore.getDisplayName(cleanParticipantJid) ??
      this.identityStore.getDisplayName(bareParticipant) ??
      raw.pushName ??
      resolvedAccountId;

    let senderPhone: string | undefined;

    if (raw.key.fromMe) {
      senderPhone = formatE164(stripDeviceSuffix(this.account));
    } else if (rawParticipant.includes('@lid') || cleanParticipantJid.endsWith('@lid')) {
      const mapped =
        this.identityStore.getMapping(cleanParticipantJid) ??
        this.identityStore.getMapping(bareParticipant);
      senderPhone = mapped ? formatE164(mapped) : undefined;
    } else if (rawParticipant.includes('@s.whatsapp.net') || cleanParticipantJid.endsWith('@s.whatsapp.net')) {
      senderPhone = formatE164(bareParticipant);
    } else {
      const mapped =
        this.identityStore.getMapping(cleanParticipantJid) ??
        this.identityStore.getMapping(bareParticipant);
      senderPhone = mapped ? formatE164(mapped) : undefined;
    }

    const bodyText = this.extractMessageText(raw.message);
    const messageTime = new Date(raw.messageTimestamp * 1000).toISOString();
    const threadId = isGroup ? remoteJid.replace('@g.us', '') : resolvedAccountId;

    const normalizedMessage: Message = {
      id: `${this.network}:${this.account}:${raw.key.id}`,
      network: this.network,
      account: this.account,
      thread: threadId,
      threadKind: isGroup ? 'group' : 'dm',
      direction: raw.key.fromMe ? 'outbound' : 'inbound',
      time: messageTime,
      from: {
        accountId: resolvedAccountId,
        displayName,
        ...(senderPhone !== undefined ? { phone: senderPhone } : {}),
      },
      to: [
        {
          accountId: isGroup ? threadId : this.account,
          displayName: isGroup ? `Group ${threadId}` : 'Me',
        },
      ],
      text: bodyText,
    };

    // Update known thread
    this.knownThreads.set(threadId, {
      id: threadId,
      network: this.network,
      account: this.account,
      name: isGroup ? `Group ${threadId}` : displayName,
      kind: isGroup ? 'group' : 'dm',
      lastMessageTime: messageTime,
      participantCount: isGroup ? 3 : 2,
    });

    this.messageBuffer.push(normalizedMessage);

    if (this.isStarted && this.onMessageCallback) {
      this.onMessageCallback(normalizedMessage);
    }
  }

  private extractMessageText(msgPayload: RawInboundMessage['message']): string {
    if (!msgPayload) {
      return '';
    }

    if (msgPayload.conversation) {
      return msgPayload.conversation;
    }

    if (msgPayload.extendedTextMessage?.text) {
      return msgPayload.extendedTextMessage.text;
    }

    if (msgPayload.productMessage?.product) {
      const p = msgPayload.productMessage.product;
      const price = p.priceAmount1000 / 1000;
      return `[product: ${p.title}, ${price} ${p.currencyCode}]`;
    }

    if (msgPayload.buttonsResponseMessage?.selectedDisplayText) {
      return msgPayload.buttonsResponseMessage.selectedDisplayText;
    }

    if (msgPayload.imageMessage) {
      const caption = msgPayload.imageMessage.caption;
      return caption ? `[image: ${caption}]` : '[image]';
    }

    return '';
  }
}

function stripDeviceSuffix(jid: string): string {
  const atIndex = jid.indexOf('@');
  if (atIndex === -1) {
    const colonIndex = jid.indexOf(':');
    return colonIndex === -1 ? jid : jid.substring(0, colonIndex);
  }
  const user = jid.substring(0, atIndex);
  const server = jid.substring(atIndex);
  const colonIndex = user.indexOf(':');
  const cleanUser = colonIndex === -1 ? user : user.substring(0, colonIndex);
  return `${cleanUser}${server}`;
}

function formatE164(phone?: string | undefined): string | undefined {
  if (!phone) {
    return undefined;
  }
  const digits = phone.replace(/\D/g, '');
  if (!digits) {
    return undefined;
  }
  return `+${digits}`;
}
