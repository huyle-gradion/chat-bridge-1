import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

export class ZaloSessionStore {
  private readonly db: Database;
  private readonly masterKey: Buffer;
  private readonly provider: string = 'zalo';

  constructor(db: Database, masterKey: Buffer) {
    this.db = db;
    this.masterKey = masterKey;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        provider TEXT NOT NULL,
        key_id TEXT NOT NULL,
        encrypted_data BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_provider ON auth_sessions(provider);
    `);
  }

  public set(keyId: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(serialized, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const stmt = this.db.prepare(`
      INSERT INTO auth_sessions (provider, key_id, encrypted_data, iv, tag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, key_id) DO UPDATE SET
        encrypted_data = excluded.encrypted_data,
        iv = excluded.iv,
        tag = excluded.tag,
        updated_at = excluded.updated_at
    `);

    stmt.run(this.provider, keyId, encrypted, iv, tag, Date.now());
  }

  public get<T = unknown>(keyId: string): T | null {
    const stmt = this.db.prepare(`
      SELECT encrypted_data, iv, tag FROM auth_sessions
      WHERE provider = ? AND key_id = ?
    `);

    const row = stmt.get(this.provider, keyId) as {
      encrypted_data: Buffer;
      iv: Buffer;
      tag: Buffer;
    } | undefined;

    if (!row) {
      return null;
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, row.iv);
      decipher.setAuthTag(row.tag);
      const decrypted = Buffer.concat([decipher.update(row.encrypted_data), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8')) as T;
    } catch {
      return null;
    }
  }

  public delete(keyId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM auth_sessions WHERE provider = ? AND key_id = ?
    `);
    stmt.run(this.provider, keyId);
  }

  public count(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM auth_sessions WHERE provider = ?
    `);
    const row = stmt.get(this.provider) as { count: number };
    return row.count;
  }
}
