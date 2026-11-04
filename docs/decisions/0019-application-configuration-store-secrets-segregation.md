# ADR 0019: Application Configuration Store, Secrets Segregation & Schema Migration Architecture

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 2, 4, 7 [Features C-1, C-2, C-3, C-8, K-0, I-1, I-4], 11, 14), `docs/decisions/0002-outbox-storage-envelope-encryption.md`, `docs/decisions/0012-desktop-packaging-native-toolchain-keystore.md`

---

## 1. Context and Problem Statement

Chat Bridge operates on a non-technical sales representative's personal computer ([Section 2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L49-L57)). The application manages two distinct classes of configuration state:
1. **Application Settings & Preferences (Non-Sensitive):**
   - Active UI language (`en` vs `vi`) and theme preferences ([Section 7 [Feature L-1]](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L212)).
   - Set of picked chat IDs authorized to leave the computer ([Features C-8, I-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L173)).
   - Message filtering rules (blocked contacts, group message toggle, custom regex patterns, OTP filters) ([Feature C-2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L170)).
   - Active sink targets and non-sensitive options (e.g. local archive directory, analytical database path, Google Sheets spreadsheet ID, Margince endpoint URL) ([Feature K-0](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L191)).
2. **Sensitive Credentials & Secrets:**
   - Margince HMAC connection strings and shared secrets ([Section 8](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L238-L242)).
   - Google Sheets OAuth 2.0 refresh tokens ([ADR 0003](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0003-google-sheets-oauth-rest.md)).
   - Custom Webhook HMAC signing keys and bearer authentication tokens ([ADR 0016](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0016-webhook-sink-ssrf-defense.md)).

### Architectural Challenges & Constraints
- **Zero Plaintext Secrets on Disk ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L295)):** Sensitive authentication tokens must never reside unencrypted in plain JSON files.
- **Support & Diagnostics Safety ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L345)):** When a user or developer exports app settings for debugging, credentials must never be co-mingled with settings or inadvertently exported.
- **Crash & Power-Cut Durability:** If the computer abruptly loses power or crashes during settings modification in the Wizard or Settings UI, a partial write must never leave a corrupted file that prevents the application from booting.
- **Schema Evolution & Upgrades:** As new fields or migrations are introduced across releases (e.g. v0.5 to v1.0), settings must automatically migrate with safe fallback defaults without resetting user preferences or picked chats.
- **Runtime Concurrency:** Both the Electron Desktop app and standalone CLI commands (`chat-bridge filters set ...`, `chat-bridge chats pick ...`) must safely access and modify the configuration without locking database transactions.

We evaluated three architectural approaches:
1. **Option 1: Monolithic Plain JSON (`config.json`) with In-File Encrypted String Values (`enc:aes-gcm:...`).**
2. **Option 2 (Accepted): Two-Tier Segregated Architecture (`settings.json` + `secrets.vault` + Zod Migrations).**
3. **Option 3: Unified SQLite `app_config` Key-Value Table inside `outbox.db`.**

---

## 2. Decision

We choose **Option 2: Two-Tier Segregated Architecture with Atomic Settings Persistence, OS Keystore Vault, and Type-Safe Zod Migrations**:

```
                                 [ User / CLI / Web UI ]
                                            |
                                            v
                                 [ ConfigurationManager ]
                                            |
                      +---------------------+---------------------+
                      |                                           |
                      v                                           v
           [ settings.json Store ]                     [ secrets.vault Store ]
           - Non-sensitive preferences                 - Margince shared secrets
           - Picked chats & filter rules               - Google OAuth refresh tokens
           - Active sink configurations                - Webhook signing keys
           - Validated by Zod Schema                   - Encrypted via OS Keystore
           - Atomic write-rename                       - Master AES-256-GCM Envelope
             (temp file -> atomic fs.rename)             (ADR 0002 / ADR 0012)
                      |                                           |
                      v                                           v
           [ Schema Migration Runner ]                 [ Export Redactor Guard ]
           - Stepwise v1 -> v2 transforms              - Zero secrets in debug bundles
           - Backward-compatible defaults              - Support diagnostic safety
```

### Technical Specification

#### 1. File & Storage Isolation
The system enforces strict physical separation of configuration files inside the user application data directory (`~/.chat-bridge/` or `%APPDATA%\chat-bridge\`):
1. **`settings.json` (Plain, Validated, Redactable):**
   - Stores all application preferences, filter settings, picked chat identifiers, and non-sensitive sink parameters.
   - Zero secrets or credentials are ever permitted in this file (enforced by Zod schema and lint guards).
2. **`secrets.vault` (OS Keystore-Protected Envelope Vault):**
   - Dedicated key-value credential store backed by `better-sqlite3` or encrypted binary payload.
   - Encrypted using the application's master key derived from the OS Keystore (macOS Keychain via Electron `safeStorage`, Windows DPAPI, or `0600` Linux keyfile as specified in [ADR 0012](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0012-desktop-packaging-native-toolchain-keystore.md)).

#### 2. Atomic Write-Rename Resilience
To prevent file corruption during sudden power termination, battery depletion, or process crashes:
- The `SettingsStore` writes updates to a temporary sibling file: `settings.json.tmp.<pid>.<timestamp>`.
- Calls `fs.fsyncSync()` on the temporary file descriptor to ensure bytes are physically flushed to the storage controller.
- Atomically replaces the target file using `fs.renameSync()`, which is an atomic filesystem operation on POSIX and modern Windows NTFS systems.
- Automatically maintains a single backup file `settings.json.bak` prior to replacement. If `settings.json` fails JSON parsing upon boot, the system attempts recovery from `settings.json.bak` and logs an incident event.

#### 3. Type-Safe Zod Schema & Versioned Migrations
All settings are validated at boot and prior to persistence using strict Zod schemas with a top-level `schemaVersion` integer:

```typescript
export interface AppSettings {
  schemaVersion: number;
  language: 'en' | 'vi';
  theme: 'system' | 'light' | 'dark';
  filters: {
    groupsEnabled: boolean;
    otpFilterEnabled: boolean;
    hidePhoneNumbers: boolean;
    blockedContactIds: string[];
    customRegexPatterns: string[];
  };
  chats: {
    pickedChatIds: string[];
  };
  sinks: Record<string, {
    enabled: boolean;
    options: Record<string, unknown>; // e.g. spreadsheetId, localDbPath
  }>;
}
```

- When an older version is detected (`currentVersion < LATEST_VERSION`), the `ConfigMigrationRunner` applies sequential migration transforms (`migrateV1ToV2`, `migrateV2ToV3`).
- Missing fields are populated with deterministic, secure default values without losing user customisations.

#### 4. Reactive Change Bus
The `ConfigurationManager` exposes an internal event emitter (`TypedEventEmitter<ConfigEvents>`):
- `settings.on('change:chats', (pickedIds) => ...)`: Notifies the chat normalizer and chat picker cache in real time.
- `settings.on('change:filters', (newFilters) => ...)`: Notifies the message pipeline without requiring an engine reboot.
- `settings.on('change:sinks', (sinkConfigs) => ...)`: Dynamically spins up or pauses outbox sink queue workers ([ADR 0005](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0005-outbox-multi-queue-worker-pacing.md)).

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1: Monolithic Plain JSON | Option 2: Two-Tier Segregated (Accepted) | Option 3: Unified SQLite in `outbox.db` |
| :--- | :--- | :--- | :--- |
| **Security & Privacy (Section 11, 14)** | **Poor.** Secrets live in the same file as UI settings; high risk of accidental leakage during log/config exports. | **High.** Physical separation. Secrets are encrypted via OS Keystore in a separate vault; `settings.json` contains zero secrets. | **High.** All database bytes encrypted via envelope encryption. |
| **Crash Durability & Atomic Persistence** | **Risky.** Standard `fs.writeFile` can truncate or corrupt the file during an ungraceful shutdown. | **High.** Atomic temporary file write-flush-rename (`fs.renameSync`) prevents corruption. | **High.** SQLite WAL transactions provide ACID durability. |
| **Concurrency & Lock Contention** | **Low.** Simple file reads, but simultaneous writes race without locking. | **High.** Read-heavy cached memory structure; atomic file replacement handles writes cleanly across UI and CLI. | **Poor.** Reading preferences or picked chats blocks or contends with active outbox queue ingestion and pacing transactions. |
| **Schema Evolution & Migrations** | **Fragile.** Manual `if (!obj.foo)` checks scattered across the codebase. | **Robust.** Stepwise Zod schema transforms guarantee compile-time and runtime type safety. | **Complex.** Requires database DDL migration scripts and table schema versioning for simple settings changes. |
| **Extensibility & Plain Language UX** | Simple JSON, but hard to sanitize safely. | Clean typed boundaries; UI and CLI share identical schema and validation messages. | High coupling between storage engine and UI settings. |

---

## 4. Consequences and Mitigations

* **Two Distinct Storage Files:** Managing both `settings.json` and `secrets.vault` introduces two separate file handles.  
  * *Mitigation:* The `ConfigurationManager` encapsulates both stores behind a single unified interface (`config.getSettings()` vs `config.getSecret(key)`), preventing downstream code from managing individual files.
* **CLI and Desktop Concurrency:** A user might run a CLI command (`chat-bridge chats pick ...`) while the Electron desktop app is active.  
  * *Mitigation:* The desktop app monitors `settings.json` filesystem modification events (`fs.watch`) with debounce, automatically reloading memory state when modified externally by the CLI.
* **Accidental Secret Injection into `settings.json`:** Developers or sink authors might accidentally store an API key inside `settings.json.sinks.options`.  
  * *Mitigation:* Zod schema validation explicitly rejects known secret keys (e.g. `secret`, `token`, `password`, `apiKey`) inside `settings.json`, throwing validation errors during development and CI contract tests.

