import Database from 'better-sqlite3';
import type { Message } from '@chat-bridge/types';
import { encryptPayload, decryptPayload } from '../outbox/encryption.js';
import type { Outbox } from '../outbox/outbox.js';

export type FeedStatus = 'sent' | 'sending' | 'filtered' | 'unpicked';

export interface FeedEntry {
  message: Message;
  status: FeedStatus;
  userFacingLabel: string;
  ruleTriggered?: string | undefined;
  createdAt: number;
}

export interface FeedStoreOptions {
  dbPath?: string;
  db?: Database.Database;
  masterKey: Buffer;
}

interface FeedRow {
  id: string;
  network: string;
  account: string;
  thread_id: string;
  thread_kind: string;
  direction: string;
  time: string;
  status: string;
  rule_triggered: string | null;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  created_at: number;
}

export class FeedStore {
  private db: Database.Database;
  private readonly ownsDatabase: boolean;
  private readonly masterKey: Buffer;

  constructor(options: FeedStoreOptions) {
    this.masterKey = options.masterKey;

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
  }

  private initDatabase(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feed_messages (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        account TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        thread_kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        time TEXT NOT NULL,
        status TEXT NOT NULL,
        rule_triggered TEXT,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feed_messages_created ON feed_messages (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feed_messages_thread ON feed_messages (thread_id);
      CREATE INDEX IF NOT EXISTS idx_feed_messages_status ON feed_messages (status);
    `);
  }

  public recordMessage(
    message: Message,
    status: FeedStatus,
    ruleTriggered?: string,
    createdAt: number = Date.now()
  ): void {
    const { ciphertext, iv, tag } = encryptPayload(message, this.masterKey);

    const stmt = this.db.prepare(`
      INSERT INTO feed_messages (
        id, network, account, thread_id, thread_kind, direction, time,
        status, rule_triggered, ciphertext, iv, tag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        rule_triggered = excluded.rule_triggered,
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        tag = excluded.tag
    `);

    stmt.run(
      message.id,
      message.network,
      message.account,
      message.thread,
      message.threadKind,
      message.direction,
      message.time,
      status,
      ruleTriggered ?? null,
      ciphertext,
      iv,
      tag,
      createdAt
    );
  }

  public updateMessageStatus(messageId: string, status: FeedStatus): void {
    this.db
      .prepare(`UPDATE feed_messages SET status = ? WHERE id = ?`)
      .run(status, messageId);
  }

  public getMessage(messageId: string): FeedEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM feed_messages WHERE id = ?`)
      .get(messageId) as FeedRow | undefined;

    if (!row) {
      return null;
    }

    return this.mapRowToEntry(row);
  }

  public listFeed(options: {
    limit?: number;
    offset?: number;
    status?: FeedStatus;
    threadId?: string;
  } = {}): FeedEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      conditions.push(`status = ?`);
      params.push(options.status);
    }

    if (options.threadId) {
      conditions.push(`thread_id = ?`);
      params.push(options.threadId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit !== undefined ? Math.max(0, options.limit) : 100;
    const offset = options.offset !== undefined ? Math.max(0, options.offset) : 0;

    const sql = `
      SELECT * FROM feed_messages
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit, offset) as FeedRow[];
    return rows.map((r) => this.mapRowToEntry(r));
  }

  public pruneExpired(
    maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
    maxEntries: number = 5000
  ): number {
    const cutoff = Date.now() - maxAgeMs;

    // 1. Delete rows older than TTL
    const ttlResult = this.db
      .prepare(`DELETE FROM feed_messages WHERE created_at < ?`)
      .run(cutoff);
    let deletedCount = ttlResult.changes;

    // 2. Cap table size to maxEntries
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM feed_messages`)
      .get() as { total: number };

    if (countRow.total > maxEntries) {
      const excess = countRow.total - maxEntries;
      const capResult = this.db
        .prepare(`
          DELETE FROM feed_messages WHERE id IN (
            SELECT id FROM feed_messages ORDER BY created_at ASC LIMIT ?
          )
        `)
        .run(excess);
      deletedCount += capResult.changes;
    }

    return deletedCount;
  }

  public async forwardAdHoc(
    messageIds: string[],
    sinkIds: string[],
    outbox: Outbox
  ): Promise<{ enqueuedCount: number; errors: string[] }> {
    let enqueuedCount = 0;
    const errors: string[] = [];

    for (const id of messageIds) {
      const entry = this.getMessage(id);
      if (!entry) {
        errors.push(`Message ${id} not found in feed`);
        continue;
      }

      try {
        await outbox.enqueue(entry.message, sinkIds);
        this.updateMessageStatus(id, 'sending');
        enqueuedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to enqueue message ${id}: ${msg}`);
      }
    }

    return { enqueuedCount, errors };
  }

  private mapRowToEntry(row: FeedRow): FeedEntry {
    const message = decryptPayload<Message>(
      row.ciphertext,
      row.iv,
      row.tag,
      this.masterKey
    );

    return {
      message,
      status: row.status as FeedStatus,
      userFacingLabel: this.getUserFacingLabel(row.status as FeedStatus),
      ruleTriggered: row.rule_triggered ?? undefined,
      createdAt: row.created_at,
    };
  }

  private getUserFacingLabel(status: FeedStatus): string {
    switch (status) {
      case 'sent':
        return 'Sent';
      case 'sending':
        return 'Sending';
      case 'filtered':
        return 'Blocked by filter';
      case 'unpicked':
        return 'Not chosen';
    }
  }

  public close(): void {
    if (this.ownsDatabase && this.db.open) {
      this.db.close();
    }
  }
}
