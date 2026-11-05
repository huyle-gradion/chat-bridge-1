# ADR 0009: Local Storage Sinks: Dedicated Analytical Database & Daily JSONL Archive

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 3, 4, 6, 7 [K-0, K-1, K-5], 10, 11)

---

## 1. Context and Problem Statement

The spec defines two local persistent sinks that run entirely on the sales rep's computer without external cloud dependencies:
1. **Local Database Sink ([Feature K-5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L193)):** Stores messages in a local SQLite file with a documented, human-readable schema so external tools (Excel, Python, Datasette, PowerBI, Metabase) can query chat history directly.
2. **Archive Sink ([Feature K-1](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L192)):** Emits one append-only JSONL file per calendar day (`YYYY-MM-DD.jsonl`). The Web UI Archive screen ([Section 10](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L284)) allows the rep to search messages by contact, date, and text.
3. **Pluggable Multi-Sink Independence ([Feature K-0](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L191)):** The rep can turn either or both sinks on or off in Settings. Local sinks must never block cloud sinks (Margince, Google Sheets) or interfere with outbox delivery queues.

We evaluated three storage topologies:
1. **Option 1 (Monolithic Shared Database):** Storing user analytical records in the same SQLite file as the internal outbox and session credentials.
2. **Option 2 (Dual-Database Architecture + Daily Partitioned JSONL Stream):** Strictly separating the internal operational database (`internal.db` / `outbox.db`) from the user-facing analytical database (`messages.db`), complemented by daily JSONL files.
3. **Option 3 (Flat Files Only):** Writing only daily JSONL files and relying on ad-hoc text search for UI queries without a local relational database.

---

## 2. Decision

We choose **Option 2: Dual-Database Architecture (Isolated Operational vs. Analytical Databases) with Daily Partitioned JSONL Streaming**:

1. **Physical Database Isolation:**
   - **Internal Operational Database (`~/.chat-bridge/internal.db`):** Owned exclusively by the engine. Houses AES-256 encrypted payloads, session credentials, queue state, and token buckets (ADR 0002, ADR 0006). Never exposed to external tools or direct user browsing.
   - **User Analytical Database (`~/Documents/Chat Bridge/messages.db` or configured path):** Managed by the Local Database Sink (`K-5`). Uses a standard, unencrypted relational schema with WAL mode enabled (`PRAGMA journal_mode = WAL;`). External analytics tools can connect in read-only mode (`immutable=1` or standard read lock) without risking outbox locks or database corruption.
2. **Analytical Database Schema (Feature K-5):**
   ```sql
   CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     network TEXT NOT NULL,
     account TEXT NOT NULL,
     thread TEXT NOT NULL,
     thread_kind TEXT NOT NULL CHECK(thread_kind IN ('dm', 'group')),
     direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
     time TEXT NOT NULL,
     sender_id TEXT NOT NULL,
     sender_name TEXT NOT NULL,
     sender_phone TEXT,
     text TEXT NOT NULL,
     placeholder TEXT,
     truncated INTEGER NOT NULL DEFAULT 0,
     raw_json TEXT NOT NULL
   );

   CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time);
   CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread);
   CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
   ```
   - Deduplication: Ingestion uses `INSERT OR IGNORE INTO messages ...` keyed on `id`, guaranteeing that each message is stored exactly once.
3. **Daily JSONL Archive Sink (Feature K-1):**
   - Path structure: `~/Documents/Chat Bridge/archive/YYYY-MM-DD.jsonl` partitioned by message calendar date (using the rep's local timezone).
   - Delivery uses append streams with atomic writes (`fs.createWriteStream(filePath, { flags: 'a' })`).
   - Format: Single-line serialized `Message` JSON object terminated by `\n`.
4. **Instantaneous UI Archive Search:**
   - When the rep queries the Archive screen ([Section 10](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L284)) by contact, text, or date range, the UI queries the local SQLite index for fast sub-50ms responses, rather than linearly parsing multi-gigabyte flat JSONL files.

---

## 3. Rationale and Comparison

| Evaluation Metric | Option 1: Monolithic Shared DB | Option 2: Dual Isolated Databases (Selected) | Option 3: Flat Files Only |
| :--- | :--- | :--- | :--- |
| **Outbox Lock Isolation** | **High Risk.** External BI tools querying large historical ranges cause `SQLITE_BUSY` on outbox writes. | **Zero Contention.** External tools only lock the user-facing analytical DB; internal outbox engine remains 100% responsive. | High safety, but lacks SQL query capability. |
| **Data Security & Privacy** | Broken: external tools either see encrypted gibberish or unencrypted outbox credentials. | **Clean Separation.** Outbox is encrypted ciphertext; user analytical DB has clear relational columns in user's home folder. | Clear JSON lines on disk. |
| **External Tool Usability (K-5)** | Requires custom decrypted SQLite extension. | **Plug-and-Play.** Standard SQLite schema instantly readable by Metabase, Python Pandas, DBeaver, Datasette, Excel. | Requires custom JSONL import scripts. |
| **Archive Search Latency (K-1)** | Fast. | **Sub-50ms.** B-Tree indexed queries across contacts, dates, and full text. | $O(N)$ linear file scan; degrades as archive grows over months. |

---

## 4. Consequences and Mitigations

* **Disk Storage Growth Over Time:**
  * *Trade-off:* Storing both an analytical SQLite file and daily JSONL archives duplicates local storage on the rep's hard drive.
  * *Mitigation:* Text chat messages are lightweight (~500 bytes per record). 100,000 messages consume only ~50 MB in JSONL and ~70 MB in SQLite. In Settings, the rep can independently enable/disable either sink or customize the storage directory.
* **External Lock Contention on Analytical DB:**
  * *Trade-off:* An external analytics application might lock `messages.db` for a prolonged analytical query.
  * *Mitigation:* The sink sets `PRAGMA busy_timeout = 5000;` and WAL mode (`journal_mode = WAL`), allowing concurrent readers without blocking the sink worker from appending new incoming messages.

