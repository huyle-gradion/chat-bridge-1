import Database from 'better-sqlite3';
import type { Message, NetworkKind, ThreadKind, ThreadSummary } from '@chat-bridge/types';

export interface ChatPickerOptions {
  dbPath?: string;
  db?: Database.Database;
}

export interface ChatPickerDecision {
  authorized: boolean;
  reason?: 'unticked_chat' | undefined;
  userFacingLabel?: string | undefined;
}

export interface ChatQueryOptions {
  search?: string;
  network?: NetworkKind;
  kind?: ThreadKind;
  isTicked?: boolean;
  sortBy?: 'last_message' | 'name';
  sortDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface ChatRosterRow {
  thread_id: string;
  network: string;
  account: string;
  name: string;
  kind: string;
  unread_count: number;
  last_message_text: string | null;
  last_message_at: string | null;
  avatar_url: string | null;
  participant_count: number | null;
  is_ticked: number;
  created_at: string;
  updated_at: string;
}

export class ChatPicker {
  private db: Database.Database;
  private readonly ownsDatabase: boolean;
  private tickedChatIds: Set<string> = new Set();

  constructor(options: ChatPickerOptions) {
    if (options.db) {
      this.db = options.db;
      this.ownsDatabase = false;
    } else if (options.dbPath) {
      this.db = new Database(options.dbPath, { timeout: 5000 });
      this.ownsDatabase = true;
    } else {
      this.db = new Database(':memory:');
      this.ownsDatabase = true;
    }

    this.initDatabase();
    this.loadTickedChatIds();
  }

  private initDatabase(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_roster (
        thread_id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        account TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_text TEXT,
        last_message_at TEXT,
        avatar_url TEXT,
        participant_count INTEGER,
        is_ticked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_roster_last_msg ON chat_roster (last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_roster_network ON chat_roster (network);
      CREATE INDEX IF NOT EXISTS idx_chat_roster_ticked ON chat_roster (is_ticked);
    `);
  }

  private loadTickedChatIds(): void {
    const rows = this.db
      .prepare(`SELECT thread_id FROM chat_roster WHERE is_ticked = 1`)
      .all() as Array<{ thread_id: string }>;

    this.tickedChatIds = new Set(rows.map((r) => r.thread_id));
  }

  public upsertChat(
    chat: ThreadSummary & { unreadCount?: number; lastMessageText?: string }
  ): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT is_ticked FROM chat_roster WHERE thread_id = ?`)
      .get(chat.id) as { is_ticked: number } | undefined;

    let isTickedVal = 0;
    if (chat.isTicked !== undefined) {
      isTickedVal = chat.isTicked ? 1 : 0;
    } else if (existing !== undefined) {
      isTickedVal = existing.is_ticked;
    }

    const stmt = this.db.prepare(`
      INSERT INTO chat_roster (
        thread_id, network, account, name, kind, unread_count,
        last_message_text, last_message_at, avatar_url, participant_count,
        is_ticked, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        name = excluded.name,
        unread_count = excluded.unread_count,
        last_message_text = COALESCE(excluded.last_message_text, chat_roster.last_message_text),
        last_message_at = COALESCE(excluded.last_message_at, chat_roster.last_message_at),
        avatar_url = COALESCE(excluded.avatar_url, chat_roster.avatar_url),
        participant_count = COALESCE(excluded.participant_count, chat_roster.participant_count),
        is_ticked = excluded.is_ticked,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      chat.id,
      chat.network,
      chat.account,
      chat.name,
      chat.kind,
      chat.unreadCount ?? 0,
      chat.lastMessageText ?? null,
      chat.lastMessageTime ?? null,
      chat.avatarUrl ?? null,
      chat.participantCount ?? null,
      isTickedVal,
      now,
      now
    );

    if (isTickedVal === 1) {
      this.tickedChatIds.add(chat.id);
    } else {
      this.tickedChatIds.delete(chat.id);
    }
  }

  public syncDiscoveredChats(chats: ThreadSummary[]): void {
    const syncAll = this.db.transaction((items: ThreadSummary[]) => {
      for (const item of items) {
        this.upsertChat(item);
      }
    });

    syncAll(chats);
  }

  public tickChat(threadId: string): void {
    this.setChatTicked(threadId, true);
  }

  public untickChat(threadId: string): void {
    this.setChatTicked(threadId, false);
  }

  public setChatTicked(threadId: string, isTicked: boolean): void {
    const now = new Date().toISOString();
    const isTickedVal = isTicked ? 1 : 0;

    const info = this.db
      .prepare(`UPDATE chat_roster SET is_ticked = ?, updated_at = ? WHERE thread_id = ?`)
      .run(isTickedVal, now, threadId);

    if (info.changes > 0) {
      if (isTicked) {
        this.tickedChatIds.add(threadId);
      } else {
        this.tickedChatIds.delete(threadId);
      }
    }
  }

  public isChatTicked(threadId: string): boolean {
    return this.tickedChatIds.has(threadId);
  }

  public getTickedChatIds(): string[] {
    return Array.from(this.tickedChatIds);
  }

  public getChat(threadId: string): ThreadSummary | null {
    const row = this.db
      .prepare(`SELECT * FROM chat_roster WHERE thread_id = ?`)
      .get(threadId) as ChatRosterRow | undefined;

    if (!row) {
      return null;
    }

    return this.mapRowToSummary(row);
  }

  public listChats(query: ChatQueryOptions = {}): ThreadSummary[] {
    const { whereClause, params } = this.buildWhereClause(query);

    let sortColumn = 'last_message_at';
    if (query.sortBy === 'name') {
      sortColumn = 'name';
    }

    const direction = query.sortDirection === 'asc' ? 'ASC' : 'DESC';
    const limit = query.limit !== undefined ? Math.max(0, query.limit) : 100;
    const offset = query.offset !== undefined ? Math.max(0, query.offset) : 0;

    const sql = `
      SELECT * FROM chat_roster
      ${whereClause}
      ORDER BY ${sortColumn} ${direction} NULLS LAST
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit, offset) as ChatRosterRow[];
    return rows.map((r) => this.mapRowToSummary(r));
  }

  public countChats(
    query: Omit<ChatQueryOptions, 'limit' | 'offset' | 'sortBy' | 'sortDirection'> = {}
  ): number {
    const { whereClause, params } = this.buildWhereClause(query);
    const sql = `SELECT COUNT(*) AS total FROM chat_roster ${whereClause}`;
    const result = this.db.prepare(sql).get(...params) as { total: number };
    return result.total;
  }

  public evaluateMessage(message: Message): ChatPickerDecision {
    const threadId = message.thread;
    const existing = this.getChat(threadId);

    if (!existing) {
      // Auto-discover incoming chat in unticked state
      this.upsertChat({
        id: threadId,
        network: message.network,
        account: message.account,
        name: message.from.displayName || threadId,
        kind: message.threadKind,
        lastMessageTime: message.time,
        lastMessageText: message.text,
        unreadCount: 1,
        isTicked: false,
      });
    } else {
      // Update last message metadata
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE chat_roster 
          SET last_message_at = ?, last_message_text = ?, unread_count = unread_count + 1, updated_at = ?
          WHERE thread_id = ?
        `)
        .run(message.time, message.text, now, threadId);
    }

    const isTicked = this.tickedChatIds.has(threadId);
    if (!isTicked) {
      return {
        authorized: false,
        reason: 'unticked_chat',
        userFacingLabel: 'Not chosen (private)',
      };
    }

    return {
      authorized: true,
    };
  }

  private buildWhereClause(
    query: Omit<ChatQueryOptions, 'limit' | 'offset' | 'sortBy' | 'sortDirection'>
  ): { whereClause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.search && query.search.trim() !== '') {
      const term = query.search.trim().replace(/[%_]/g, '\\$&');
      conditions.push(`(name LIKE ? ESCAPE '\\' OR thread_id LIKE ? ESCAPE '\\')`);
      params.push(`%${term}%`, `%${term}%`);
    }

    if (query.network) {
      conditions.push(`network = ?`);
      params.push(query.network);
    }

    if (query.kind) {
      conditions.push(`kind = ?`);
      params.push(query.kind);
    }

    if (query.isTicked !== undefined) {
      conditions.push(`is_ticked = ?`);
      params.push(query.isTicked ? 1 : 0);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereClause, params };
  }

  private mapRowToSummary(row: ChatRosterRow): ThreadSummary {
    return {
      id: row.thread_id,
      network: row.network as NetworkKind,
      account: row.account,
      name: row.name,
      kind: row.kind as ThreadKind,
      lastMessageTime: row.last_message_at ?? undefined,
      participantCount: row.participant_count ?? undefined,
      avatarUrl: row.avatar_url ?? undefined,
      isTicked: row.is_ticked === 1,
    };
  }

  public close(): void {
    if (this.ownsDatabase && this.db.open) {
      this.db.close();
    }
  }
}
