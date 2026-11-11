# ADR 0022: Multi-Database Schema Versioning, Integrity Verification & Disaster Recovery Architecture

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 2, 4, 7 [Features C-1, C-3, C-6, K-5], 11, 13), `docs/decisions/0002-outbox-storage-envelope-encryption.md`, `docs/decisions/0006-connector-session-persistence-identity.md`, `docs/decisions/0009-local-storage-sinks-database-archive.md`

---

## 1. Context and Problem Statement

Chat Bridge operates three distinct SQLite databases on the user's local filesystem:
1. **`outbox.db`:** The primary encrypted outbox database with multi-queue sink tracking, envelope-encrypted payloads, idempotency tables, and retry state ([ADR 0002](0002-outbox-storage-envelope-encryption.md), [ADR 0005](0005-outbox-multi-queue-worker-pacing.md)).
2. **`analytics.db`:** The dedicated unencrypted analytical database for local querying and external business intelligence tools ([ADR 0009](0009-local-storage-sinks-database-archive.md)).
3. **`sessions.db`:** The encrypted credential store for Baileys Signal keys, Zalo authentication tokens, and WhatsApp LID-to-phone mapping tables ([ADR 0006](0006-connector-session-persistence-identity.md)).

### Architectural Challenges & Constraints
- **Zero Data Loss Guarantee ([Section 11](../spec.md#L296)):** *"A crash, a reboot or a closed laptop loses no message that reached the outbox."*
- **Application Startup Budget ([Section 11](../spec.md#L303)):** App startup from cold launch to wizard/home screen must complete in **under 5 seconds**. Heavy ORM migration engines (Prisma, TypeORM) add multiple seconds of binary initialization latency and heavy memory overhead.
- **Atomic Schema Evolution:** As the product evolves across versions (e.g. Month 2 sprints to final release), table schemas, indexes, and constraints will change. If an update or migration fails mid-flight due to an OS power cut, the database must not be left in an inconsistent, half-migrated state.
- **Disaster Scenarios & Storage Edge Cases:**
  - `SQLITE_CORRUPT`: Rare page corruptions caused by hardware failure or sudden kernel panic.
  - `SQLITE_FULL`: The user's laptop disk runs out of space during high-throughput message ingestion.
- **Non-Technical User Guard ([Section 2, 11](../spec.md#L55)):** Non-technical sales representatives must never see raw SQLite error codes (`SQLITE_CORRUPT`, `SQLITE_FULL`, `SQLITE_BUSY`). The application must auto-heal when possible and provide clear, plain-language error dialogs with one-click actions.

We evaluated three architectural approaches:
1. **Option 1: Heavyweight Node ORM Migration Frameworks (Prisma / TypeORM / Knex).**
2. **Option 2 (Accepted): Zero-Dependency Transactional `PRAGMA user_version` Runner, Pre-Migration Safety Snapshots & Auto-Quarantine Recovery.**
3. **Option 3: Ad-hoc Manual `CREATE TABLE IF NOT EXISTS` at Boot.**

---

## 2. Decision

We choose **Option 2: Zero-Dependency Transactional `PRAGMA user_version` Runner, Pre-Migration Safety Snapshots & Auto-Quarantine Recovery**:

```
                         [ Database Initialization ]
                                     |
                                     v
                       [ PRAGMA quick_check(10) ]
                                     |
                     +---------------+---------------+
                     | (Corrupted)                   | (Healthy)
                     v                               v
          [ Quarantine & Salvage ]        [ Check PRAGMA user_version ]
          - Move to *.corrupt.<ts>.bak               |
          - Salvage rows via .recover     +----------+----------+
          - Init clean DB                 | (Up-to-date)        | (Outdated)
          - Replay un-acked messages      v                     v
            from ephemeral feed     [ Ready ]      [ Pre-Migration Backup ]
                                                   - Copy db -> db.pre-v<N>.bak
                                                                |
                                                                v
                                                   [ Atomic Transaction ]
                                                   - BEGIN IMMEDIATE;
                                                   - Run migration DDL
                                                   - PRAGMA user_version = N;
                                                   - COMMIT;
```

### Technical Specification

#### 1. Zero-Dependency Transactional Migration Engine
Located in `packages/core/src/storage/migrations/`:
- **Version Tracking:** Each database tracks its schema version via SQLite's built-in `PRAGMA user_version`.
- **Sequential Migration Pipeline:** Migrations are defined as an ordered array of immutable migration definitions:
  ```typescript
  export interface DatabaseMigration {
    version: number;
    description: string;
    up: (db: Database.Database) => void;
  }
  ```
- **Atomic DDL Transactions:**
  Migrations execute sequentially inside an explicit write transaction:
  ```typescript
  const runMigration = db.transaction((migration: DatabaseMigration) => {
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
  });
  runMigration(migration);
  ```
  If any DDL statement or data transformation throws an error, SQLite automatically and atomically rolls back the entire transaction. The database remains completely intact at the previous version.

#### 2. Pre-Migration Safety Snapshot
- Before applying any pending migration, the migration manager creates a physical file snapshot:
  `<database-path>.pre-migration-v<current_version>.bak`
- If an unrecoverable failure occurs during migration, the application can safely restore the pre-migration snapshot and flag a plain-language diagnostic warning without corrupting existing records.

#### 3. Integrity Verification & Auto-Quarantine (`quick_check`)
- **Fast Integrity Probe:** On every database connection open, the engine executes `PRAGMA quick_check(10)`. This sub-50ms check inspects SQLite page linkages and B-tree headers without scanning entire gigabyte databases, fitting comfortably within the 5-second startup budget ([Section 11](../spec.md#L303)).
- **Corrupted Database Recovery Routine:**
  If `quick_check` returns anything other than `ok` or a `SQLITE_CORRUPT` error is caught:
  1. Closes the corrupted database connection immediately.
  2. Moves the corrupted file to `<database-path>.corrupted.<timestamp>.bak`.
  3. Executes SQLite salvage recovery (`better-sqlite3` backup / `.recover` API) into a newly initialized database.
  4. For `outbox.db`, missing messages that were not yet acknowledged by active sinks are automatically re-queued from the 7-day ephemeral feed store ([ADR 0010](0010-message-normalization-filtering-pipeline-feed.md)).

#### 4. Disk Full (`SQLITE_FULL`) Graceful Guard
- When the host filesystem runs out of free space, `better-sqlite3` throws `SqliteError: database or disk is full` (`SQLITE_FULL`).
- The storage layer intercepts this specific error code:
  - Immediately pauses inbound message queueing to prevent thread crashes.
  - Retains in-memory message buffers up to safety limits.
  - Emits a high-priority UI warning banner: *"Your computer's disk is full. Please free up some disk space so Chat Bridge can continue saving your messages."*
  - Automatically resumes queueing once disk space becomes available.

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1: ORM Migrations (Prisma / TypeORM) | Option 2: `PRAGMA user_version` (Accepted) | Option 3: Ad-hoc `IF NOT EXISTS` |
| :--- | :--- | :--- | :--- |
| **Startup Latency (< 5 s Budget)** | **Poor.** Adds 2–4 seconds of binary startup and query engine initialization. | **Sub-50ms.** Native C++ SQLite execution; zero process spawn overhead. | Instant, but incapable of complex migrations. |
| **Atomic Durability & Rollback** | Medium. Relies on external CLI tooling and shadow databases. | **Guaranteed.** Full SQLite transactional DDL with automatic rollback on error. | **None.** Partial DDL failures leave tables in broken intermediate states. |
| **Dependency Footprint** | Massive (engine binaries, schema engines, heavy npm trees). | **Zero Dependencies.** Native to `better-sqlite3` and SQLite core engine. | Zero dependencies. |
| **Disaster Recovery & Quarantine** | Manual CLI intervention required. | **Automated.** Fast boot integrity probe (`quick_check`), auto-quarantine, and ephemeral feed re-sync. | No disaster recovery mechanisms. |
| **Disk-Full Resilience** | Uncaught exceptions crash the process. | **Intercepted.** Gracefully pauses ingestion, buffers safely, and alerts in plain language. | Process crashes ungracefully. |

---

## 4. Consequences and Mitigations

* **No Automatic Down Migrations:** We deliberately avoid writing inverse `down` migration scripts.  
  * *Mitigation:* In desktop applications, downgrading installed desktop versions across schema boundaries without backup restoration is inherently unsafe. If a migration fails, the system rolls back atomically to the current version or restores the automatic pre-migration backup (`.bak`).
* **Disk Space for Snapshots:** Pre-migration backups temporarily consume disk space equal to the database size.  
  * *Mitigation:* The system keeps only the single most recent pre-migration snapshot per database, purging older snapshots automatically once the migration completes successfully.

