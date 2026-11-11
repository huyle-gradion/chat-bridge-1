# ADR 0006: Chat Connector Session Persistence, Security & Identity Mapping

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 4, 6, 7 [S-1, S-2, S-3, C-6, C-7], 11, 14, 15)

---

## 1. Context and Problem Statement

Connecting unofficial chat networks (**`baileys`** for WhatsApp, **`zca-js`** for Zalo) introduces three critical technical challenges:
1. **Encrypted Credential Storage ([Section 6](../spec.md#L140), [Section 11](../spec.md#L295), [Section 14](../spec.md#L347)):**  
   The spec mandates that sessions must be encrypted on disk. Standard Baileys usage (`useMultiFileAuthState`) dumps hundreds of plaintext JSON files (Signal identity keys, pre-keys, session tokens) into a folder. This directly violates privacy rules and risks file corruption during sudden laptop lid closes or power failures. Zalo cookies and tokens (`zpw_sek`) must likewise be protected against offline disk extraction.
2. **Identity Normalization: WhatsApp LID-to-Phone Mapping ([Feature C-6](../spec.md#L175)):**  
   WhatsApp uses two address formats: phone JIDs (`<phone>@s.whatsapp.net`) and Linked Identity JIDs (`<lid>@lid`). A single customer communicating in both direct messages and group chats can present different IDs. Feature C-6 explicitly requires keeping a local LID-to-phone mapping so that one person seen by phone and by LID is delivered with **one unified person ID**.
3. **Session Lifecycle & Inactivity Warnings ([Feature C-7](../spec.md#L176)):**  
   - *WhatsApp 14-day rule:* WhatsApp automatically revokes linked companion sessions if the primary smartphone stays offline for 14 consecutive days.
   - *Zalo single web session rule:* Zalo invalidates companion web sessions whenever the account is logged into from another browser or desktop client.

We evaluated three architectural approaches:
1. **Option 1 (File-Level AES Wrapper on Disk):** Encrypting individual JSON files on disk within a directory.
2. **Option 2 (Unified Encrypted SQLite Session Store + Persistent Identity Table):** Storing all Baileys Signal keys, Zalo session cookies, and LID mappings in SQLite tables protected by AES-256-GCM envelope encryption.
3. **Option 3 (Ephemeral In-Memory Only Sessions):** Zero disk persistence, requiring a new QR code scan every time the application restarts.

---

## 2. Decision

We choose **Option 2: Unified Encrypted SQLite Session Store + Persistent Identity Table**:

1. **Encrypted Authentication State Store (`auth_sessions`):**
   - We implement a custom Baileys `AuthenticationState` (`creds`, `keys: { get, set }`) and a Zalo session adapter backed by a dedicated SQLite table:
     ```sql
     CREATE TABLE auth_sessions (
       provider TEXT NOT NULL,
       key_id TEXT NOT NULL,
       encrypted_data BLOB NOT NULL,
       iv BLOB NOT NULL,
       tag BLOB NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (provider, key_id)
     );
     ```
   - Every key-value record (Signal pre-keys, sender keys, identity keys, Zalo cookies/tokens) is encrypted using **AES-256-GCM** with the master key derived from the OS Keystore (ADR 0002).
   - Atomic SQLite transactions guarantee crash safety during multi-key updates and key rotations.
2. **Persistent LID-to-Phone Identity Resolution (`identity_mappings`):**
   - Identity pairings are persisted in a dedicated lookup table:
     ```sql
     CREATE TABLE identity_mappings (
       network TEXT NOT NULL,
       alias_id TEXT NOT NULL,
       primary_id TEXT NOT NULL,
       display_name TEXT,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (network, alias_id)
     );
     CREATE INDEX idx_identity_reverse ON identity_mappings(network, primary_id);
     ```
   - When Baileys emits contact sync payloads (`contacts.upsert`, `contacts.update`) or message protocol stanzas containing alternate identity attributes, the mapping table is updated.
   - An in-memory LRU cache (1,000 entries) caches mappings for sub-millisecond lookup during message normalization.
   - In the engine pipeline, incoming messages with `from: <lid>` are automatically rewritten to the corresponding `<phone>` identifier before dispatch to sinks.
3. **Zalo User Info Caching (Feature S-2):**
   - User profile lookups (`getUserInfo`) are stored in a local SQLite cache table with a 30-day TTL to avoid rate-limiting or account flags from Zalo servers:
     ```sql
     CREATE TABLE zalo_user_cache (
       uid TEXT PRIMARY KEY,
       display_name TEXT NOT NULL,
       phone TEXT,
       updated_at INTEGER NOT NULL
     );
     ```
4. **Session Watchdogs & Plain-Language Alerts (Feature C-7):**
   - **WhatsApp 14-day Inactivity Guard:** The engine records `last_primary_device_active_at` on every incoming WhatsApp event. A background check evaluates `now() - last_active`. When the gap reaches **12 days** (48 hours before cutoff), the engine dispatches an alert:  
     *"Open WhatsApp on your phone in the next 2 days, or this computer will be logged out. [How?]"*
   - **Zalo Web Takeover Detector:** When `zca-js` triggers a disconnection with code indicating duplicate login (`SESSION_LOGGED_OUT_OTHER_DEVICE`), the source enters `taken-over` status immediately, stops automatic reconnect loops, and displays a plain-language banner:  
     *"Your Zalo account was opened in another browser. Click 'Reconnect' to reconnect Chat Bridge."*

---

## 3. Rationale and Comparison

| Evaluation Metric | Option 1: File-Level AES Wrapper | Option 2: Encrypted SQLite Store (Selected) | Option 3: In-Memory Only |
| :--- | :--- | :--- | :--- |
| **Privacy & Security (Sec. 11, 14)** | Passable, but leaves temp file residue and uncoordinated files on disk. | **Strict & Clean.** 100% of sensitive session keys, cookies, and tokens are AES-256-GCM encrypted in SQLite. Zero loose plaintext files. | Highest security, but catastrophic UX. |
| **Crash Durability & Atomicity** | **Fragile.** Power failure during multi-file Signal key rotation corrupts session. | **Atomic & ACID.** Pre-key deletions and session rotation execute in atomic transactions. | N/A (lost on exit). |
| **LID Resolution Performance** | Slow; requires secondary file parsing. | **Sub-millisecond.** In-memory LRU cache backed by indexed SQLite B-Tree. | Lost on every restart. |
| **Resource Efficiency** | High disk I/O churn from hundreds of file reads/writes. | **Low I/O.** Single open database handle in WAL mode with memory caching. | Lowest disk I/O. |
| **User Experience (Sec. 2)** | Good. | **Seamless.** Sessions restore instantly across app reboots with zero rep intervention. | **Fails.** User must scan QR codes on every single app launch. |

---

## 4. Consequences and Mitigations

* **Pre-Key Accumulation & Database Bloat:**
  * *Trade-off:* Baileys generates and rotates hundreds of one-time Signal pre-keys over time. Without pruning, the `auth_sessions` table could grow indefinitely.
  * *Mitigation:* A daily pruning routine deletes consumed pre-keys that are older than 7 days, maintaining a compact database footprint.
* **Out-of-Order Message Arrival Before LID Discovery:**
  * *Trade-off:* If a group message from `<alice_lid>` arrives before Baileys receives the initial contact sync containing Alice's phone number, the message is normalized with `from: <alice_lid>`.
  * *Mitigation:* Once the pairing (`<alice_lid> -> <alice_phone>`) is discovered, the mapping is saved. For sinks that support updates (e.g. Margince review cards), Margince's phone-merge key logic handles reconciliation on the CRM side per Section 1 and Section 8.

