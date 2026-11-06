import Database from 'better-sqlite3';
import type { Message } from '@chat-bridge/types';
import { encryptPayload, decryptPayload } from './encryption.js';

export interface OutboxOptions {
  dbPath: string;
  masterKey: Buffer;
}

export interface PendingDelivery {
  deliveryId: number;
  message: Message;
  attempts: number;
}

interface RawDeliveryRow {
  delivery_id: number;
  attempts: number;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export class Outbox {
  private db: Database.Database;
  private readonly masterKey: Buffer;

  constructor(options: OutboxOptions) {
    this.masterKey = options.masterKey;
    this.db = new Database(options.dbPath, { timeout: 5000 });

    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        time TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sink_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        sink_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_at INTEGER,
        UNIQUE(message_id, sink_id),
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sink_deliveries_pending 
      ON sink_deliveries(sink_id, status, next_retry_at);
    `);
  }

  public async enqueue(message: Message, sinkIds: string[]): Promise<void> {
    const { ciphertext, iv, tag } = encryptPayload(message, this.masterKey);
    const now = Date.now();

    const insertMsgStmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, network, time, ciphertext, iv, tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDeliveryStmt = this.db.prepare(`
      INSERT OR IGNORE INTO sink_deliveries (message_id, sink_id, status, attempts, next_retry_at)
      VALUES (?, ?, 'pending', 0, 0)
    `);

    const transaction = this.db.transaction(() => {
      insertMsgStmt.run(message.id, message.network, message.time, ciphertext, iv, tag, now);

      for (const sinkId of sinkIds) {
        insertDeliveryStmt.run(message.id, sinkId);
      }
    });

    transaction();
  }

  public async getPendingDeliveries(
    sinkId: string,
    limit: number = 50,
    asOfTime: number = Date.now()
  ): Promise<PendingDelivery[]> {
    const queryStmt = this.db.prepare(`
      SELECT 
        d.id AS delivery_id,
        d.attempts,
        m.ciphertext,
        m.iv,
        m.tag
      FROM sink_deliveries d
      JOIN messages m ON d.message_id = m.id
      WHERE d.sink_id = ?
        AND d.status = 'pending'
        AND d.next_retry_at <= ?
      ORDER BY d.id ASC
      LIMIT ?
    `);

    const rows = queryStmt.all(sinkId, asOfTime, limit) as RawDeliveryRow[];

    return rows.map((row) => {
      const message = decryptPayload<Message>(row.ciphertext, row.iv, row.tag, this.masterKey);
      return {
        deliveryId: row.delivery_id,
        message,
        attempts: row.attempts,
      };
    });
  }

  public async markDelivered(deliveryId: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE sink_deliveries
      SET status = 'delivered', delivered_at = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), deliveryId);
  }

  public async markFailed(
    deliveryId: number,
    error: string,
    nextRetryAt: number = Date.now() + 5000
  ): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE sink_deliveries
      SET attempts = attempts + 1,
          last_error = ?,
          next_retry_at = ?
      WHERE id = ?
    `);
    stmt.run(error, nextRetryAt, deliveryId);
  }

  public async markRefused(deliveryId: number, reason: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE sink_deliveries
      SET status = 'refused',
          last_error = ?
      WHERE id = ?
    `);
    stmt.run(reason, deliveryId);
  }

  public async getQueueCount(sinkId?: string): Promise<number> {
    if (sinkId) {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM sink_deliveries
        WHERE sink_id = ? AND status = 'pending'
      `);
      const result = stmt.get(sinkId) as { count: number };
      return result.count;
    }

    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM sink_deliveries
      WHERE status = 'pending'
    `);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  public async isMessageDelivered(messageId: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered
      FROM sink_deliveries
      WHERE message_id = ?
    `);
    const result = stmt.get(messageId) as { total: number; delivered: number | null };
    return result.total > 0 && result.total === (result.delivered ?? 0);
  }

  public async purgeCompletedMessages(maxAgeMs: number = 0): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const stmt = this.db.prepare(`
      DELETE FROM messages
      WHERE id IN (
        SELECT m.id
        FROM messages m
        JOIN sink_deliveries d ON m.id = d.message_id
        GROUP BY m.id
        HAVING COUNT(*) = SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END)
           AND MAX(d.delivered_at) <= ?
      )
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  public close(): void {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}
