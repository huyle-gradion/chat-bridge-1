import type { Database } from 'better-sqlite3';

export interface ZaloUserProfile {
  uid: string;
  displayName: string;
  phone?: string | undefined;
  updatedAt: number;
}

export class ZaloUserCache {
  private readonly db: Database;
  private readonly ttlMs: number;
  private readonly memoryCache = new Map<string, ZaloUserProfile>();

  constructor(db: Database, ttlDays: number = 30) {
    this.db = db;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zalo_user_cache (
        uid TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        phone TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  public get(uid: string): ZaloUserProfile | null {
    // In-memory cache check
    const inMem = this.memoryCache.get(uid);
    if (inMem) {
      if (Date.now() - inMem.updatedAt < this.ttlMs) {
        return inMem;
      }
      this.memoryCache.delete(uid);
    }

    const stmt = this.db.prepare(`
      SELECT uid, display_name, phone, updated_at
      FROM zalo_user_cache
      WHERE uid = ?
    `);

    const row = stmt.get(uid) as {
      uid: string;
      display_name: string;
      phone: string | null;
      updated_at: number;
    } | undefined;

    if (!row) {
      return null;
    }

    if (Date.now() - row.updated_at >= this.ttlMs) {
      return null;
    }

    const profile: ZaloUserProfile = {
      uid: row.uid,
      displayName: row.display_name,
      phone: row.phone ?? undefined,
      updatedAt: row.updated_at,
    };

    this.memoryCache.set(uid, profile);
    return profile;
  }

  public set(uid: string, displayName: string, phone?: string): void {
    const now = Date.now();
    const profile: ZaloUserProfile = {
      uid,
      displayName,
      phone,
      updatedAt: now,
    };

    this.memoryCache.set(uid, profile);

    const stmt = this.db.prepare(`
      INSERT INTO zalo_user_cache (uid, display_name, phone, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        display_name = excluded.display_name,
        phone = excluded.phone,
        updated_at = excluded.updated_at
    `);

    stmt.run(uid, displayName, phone ?? null, now);
  }
}
