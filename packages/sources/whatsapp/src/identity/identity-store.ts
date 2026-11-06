import type { Database } from 'better-sqlite3';

export interface IdentityRecord {
  network: string;
  aliasId: string;
  primaryId: string;
  displayName?: string | undefined;
  updatedAt: number;
}

export class IdentityStore {
  private readonly db: Database;
  private readonly network: string;
  private readonly memoryCache = new Map<string, string>();

  constructor(db: Database, network: string = 'whatsapp') {
    this.db = db;
    this.network = network;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_mappings (
        network TEXT NOT NULL,
        alias_id TEXT NOT NULL,
        primary_id TEXT NOT NULL,
        display_name TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (network, alias_id)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_reverse ON identity_mappings(network, primary_id);
    `);
  }

  public setMapping(aliasId: string, primaryId: string, displayName?: string): void {
    const cleanAlias = aliasId.replace(/@lid|@s\.whatsapp\.net/g, '');
    const cleanPrimary = primaryId.replace(/@lid|@s\.whatsapp\.net/g, '');

    this.memoryCache.set(aliasId, cleanPrimary);
    this.memoryCache.set(cleanAlias, cleanPrimary);

    const stmt = this.db.prepare(`
      INSERT INTO identity_mappings (network, alias_id, primary_id, display_name, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(network, alias_id) DO UPDATE SET
        primary_id = excluded.primary_id,
        display_name = coalesce(excluded.display_name, identity_mappings.display_name),
        updated_at = excluded.updated_at
    `);

    stmt.run(this.network, aliasId, cleanPrimary, displayName ?? null, Date.now());
    if (cleanAlias !== aliasId) {
      stmt.run(this.network, cleanAlias, cleanPrimary, displayName ?? null, Date.now());
    }
  }

  public resolve(aliasId: string): string {
    const cleanAlias = aliasId.replace(/@lid|@s\.whatsapp\.net/g, '');
    const cached = this.memoryCache.get(aliasId) ?? this.memoryCache.get(cleanAlias);
    if (cached) {
      return cached;
    }

    const stmt = this.db.prepare(`
      SELECT primary_id FROM identity_mappings
      WHERE network = ? AND (alias_id = ? OR alias_id = ?)
      LIMIT 1
    `);

    const row = stmt.get(this.network, aliasId, cleanAlias) as { primary_id: string } | undefined;
    if (row) {
      this.memoryCache.set(aliasId, row.primary_id);
      this.memoryCache.set(cleanAlias, row.primary_id);
      return row.primary_id;
    }

    return cleanAlias;
  }

  public getDisplayName(aliasOrPrimaryId: string): string | undefined {
    const stmt = this.db.prepare(`
      SELECT display_name FROM identity_mappings
      WHERE network = ? AND (alias_id = ? OR primary_id = ?)
      LIMIT 1
    `);

    const row = stmt.get(this.network, aliasOrPrimaryId, aliasOrPrimaryId) as { display_name: string | null } | undefined;
    return row?.display_name ?? undefined;
  }
}
