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
import { ZaloSessionStore } from './auth/session-store.js';
import { ZaloUserCache } from './cache/user-cache.js';
import type { ZaloAdapter, ZaloUserSession, ZaloRawMessage } from './socket/zalo-adapter.js';
import { MockZaloAdapter } from './socket/mock-zalo-adapter.js';

export interface ZaloSourceOptions {
  dbPath: string;
  masterKey: Buffer;
  account?: string | undefined;
  adapter?: ZaloAdapter | undefined;
  cacheTtlDays?: number | undefined;
}

export class ZaloSource implements SourceContract {
  public readonly network: NetworkKind = 'zalo';
  public account: string;

  private readonly db: Database;
  private readonly sessionStore: ZaloSessionStore;
  private readonly userCache: ZaloUserCache;
  private readonly adapter: ZaloAdapter;

  private currentStatus: SourceStatus;
  private onMessageCallback: OnMessageCallback | null = null;
  private isStarted: boolean = false;
  private knownThreads = new Map<string, ThreadSummary>();
  private messageBuffer: Message[] = [];

  constructor(options: ZaloSourceOptions) {
    this.account = options.account ?? 'zalo-account';

    const dbDir = path.dirname(options.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new DatabaseConstructor(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.sessionStore = new ZaloSessionStore(this.db, options.masterKey);
    this.userCache = new ZaloUserCache(this.db, options.cacheTtlDays ?? 30);
    this.adapter = options.adapter ?? new MockZaloAdapter();

    // Check for saved session
    const savedUser = this.sessionStore.get<ZaloUserSession>('credentials');
    if (savedUser) {
      this.account = savedUser.uid;
      this.currentStatus = {
        state: 'connected',
        reason: 'Restored saved Zalo session',
        updatedAt: new Date().toISOString(),
        account: savedUser.uid,
      };
      if (this.adapter instanceof MockZaloAdapter) {
        this.adapter.currentUser = savedUser;
      }
      this.adapter.connect().catch(() => {});
    } else {
      this.currentStatus = {
        state: 'needs-login',
        reason: 'Zalo authentication required',
        updatedAt: new Date().toISOString(),
      };
    }

    this.setupAdapterListeners();
  }

  private setupAdapterListeners(): void {
    this.adapter.onConnected((session) => {
      this.account = session.uid;
      this.currentStatus = {
        state: 'connected',
        reason: `Zalo connected as ${session.displayName}`,
        updatedAt: new Date().toISOString(),
        account: session.uid,
      };
      this.sessionStore.set('credentials', session);
    });

    this.adapter.onTakeover(() => {
      this.currentStatus = {
        state: 'taken-over',
        reason: 'Zalo was opened on another web browser. Click here to reconnect Chat Bridge.',
        updatedAt: new Date().toISOString(),
        account: this.account,
      };
    });

    this.adapter.onMessage((raw) => {
      this.handleInboundRawMessage(raw).catch(() => {});
    });
  }

  public async login(onEvent?: OnLoginEventCallback): Promise<SourceStatus> {
    if (onEvent) {
      this.adapter.onQr((qrData, message) => {
        onEvent({
          type: 'qr',
          qrData,
          message,
        });
      });
    }

    await this.adapter.connect();

    return new Promise((resolve) => {
      if (this.currentStatus.state === 'connected') {
        resolve(this.currentStatus);
        return;
      }

      this.adapter.onConnected((session) => {
        const status: SourceStatus = {
          state: 'connected',
          reason: `Zalo connected as ${session.displayName}`,
          updatedAt: new Date().toISOString(),
          account: session.uid,
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
    await this.adapter.disconnect();
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
      const messageId = await this.adapter.sendMessage(thread, text);
      return { ok: true, messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Send failed';
      return { ok: false, error };
    }
  }

  public getSessionRecordCount(): number {
    return this.sessionStore.count();
  }

  public close(): void {
    this.adapter.close();
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  private async handleInboundRawMessage(raw: ZaloRawMessage): Promise<void> {
    const isGroup = Boolean(raw.groupId);
    const threadId = isGroup ? `g_${raw.groupId}` : raw.uidFrom;
    const isOutbound = raw.uidFrom === this.account;

    // Resolve sender profile through UserCache (with getUserInfo on miss)
    let displayName = isOutbound ? 'Me' : raw.uidFrom;
    if (!isOutbound) {
      const cached = this.userCache.get(raw.uidFrom);
      if (cached) {
        displayName = cached.displayName;
      } else {
        try {
          const info = await this.adapter.getUserInfo(raw.uidFrom);
          this.userCache.set(raw.uidFrom, info.displayName, info.phone);
          displayName = info.displayName;
        } catch {
          displayName = raw.uidFrom;
        }
      }
    }

    const messageTime = new Date(raw.timestamp).toISOString();

    const normalizedMessage: Message = {
      id: `${this.network}:${this.account}:${raw.msgId}`,
      network: this.network,
      account: this.account,
      thread: threadId,
      threadKind: isGroup ? 'group' : 'dm',
      direction: isOutbound ? 'outbound' : 'inbound',
      time: messageTime,
      from: {
        accountId: raw.uidFrom,
        displayName,
      },
      to: [
        {
          accountId: isGroup ? threadId : this.account,
          displayName: isGroup ? `Zalo Group ${threadId}` : 'Me',
        },
      ],
      text: raw.content,
    };

    this.knownThreads.set(threadId, {
      id: threadId,
      network: this.network,
      account: this.account,
      name: isGroup ? `Zalo Group ${threadId}` : displayName,
      kind: isGroup ? 'group' : 'dm',
      lastMessageTime: messageTime,
      participantCount: isGroup ? 3 : 2,
    });

    this.messageBuffer.push(normalizedMessage);

    if (this.isStarted && this.onMessageCallback) {
      await this.onMessageCallback(normalizedMessage);
    }
  }
}
