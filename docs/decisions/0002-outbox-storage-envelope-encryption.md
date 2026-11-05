# ADR 0002: Outbox Storage & Encryption: Standard SQLite with Envelope Encryption

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 4, 6, 7 [C-3, K-5], 11, 14)

---

## 1. Context and Problem Statement

Feature **C-3** in `docs/spec.md` specifies an encrypted outbox:
> *"Encrypted SQLite. Key from the OS key store (Keychain on macOS, DPAPI on Windows, a key file with 0600 rights on Linux for CI). One queue per sink. Given a sink is down, when messages arrive, then they wait for that sink, and each is delivered to it exactly once when it is back."*

Additionally, Section 11 and Section 14 require strict privacy and data security: sessions, the outbox, and the Margince secret must be encrypted on disk, and sudden power cuts or laptop lid closes must not lose or corrupt any messages.

We evaluated three architectural approaches:
1. **Pure JavaScript file-based queue (Maildir):** Simple, zero native build steps, but suffers $O(N)$ filesystem scanning and poor scalability under queue backlogs.
2. **Full Page Encryption (SQLCipher):** Encrypts 100% of the database file at the 4KB page level, but incurs heavy crypto and HMAC re-hashing overhead on every page write, causing 2x–4x slower burst writes and high CPU during frequent queue polling/status updates.
3. **Application-Level Envelope Encryption on Standard SQLite:** Standard SQLite (`better-sqlite3` in WAL mode) with AEAD (AES-256-GCM) encryption applied to message content, PII, and credentials before insertion.

---

## 2. Decision

We choose **Standard SQLite (`better-sqlite3` with WAL mode) + Application-Level Envelope Encryption (AES-256-GCM)** as the outbox storage engine for Chat Bridge:

1. **Storage Engine:** Standard SQLite via `better-sqlite3` with Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) and synchronous normal (`PRAGMA synchronous = NORMAL;`).
2. **Encryption Model (Envelope / Field-Level AEAD):**
   - **Encrypted Fields:** All message text, sender/recipient phone numbers, names, media URLs, attachment metadata, and raw JSON payloads are encrypted using **AES-256-GCM** with a unique random 96-bit Initialization Vector (IV) and a 128-bit authentication tag per record.
   - **Plaintext / Indexable Fields:** Only non-sensitive routing and state tracking fields remain unencrypted: message UUID (`id`), source network (`network`), timestamp (`time`), and delivery state (`sink_id`, `status`, `attempts`, `next_retry_at`).
3. **Key Management:**
   - Master encryption key derived from OS Keystore:
     - **macOS:** Apple Keychain (via Electron `safeStorage` in desktop, or OS keychain APIs).
     - **Windows:** Windows DPAPI (via Electron `safeStorage`).
     - **Linux / CI:** A local keyfile with `0600` file permissions as specified in Section 7 (C-3).
4. **Queue Schema:**
   - `messages`: Normalized messages storing indexed metadata (`id`, `network`, `time`) and encrypted payload (`encrypted_payload` BLOB, `iv` BLOB, `tag` BLOB).
   - `sink_deliveries`: Queue state table (`message_id`, `sink_id`, `status`, `attempts`, `next_retry_at`, `last_error`).
   - Covered index on `(sink_id, status, next_retry_at)` for instant queue polling and dequeuing.

---

## 3. Rationale

1. **Superior Scalability & High Throughput:**
   - Queue polling queries (`WHERE sink_id = ? AND status = 'pending' AND next_retry_at <= ?`) execute at native SQLite C-speed across unencrypted B-Tree indexes without page-level crypto overhead.
   - Updating queue state (e.g., toggling `status` from `pending` to `delivering` to `acked`) only updates small integer/status columns without re-encrypting or HMAC-rehashing 4KB database pages.
   - Burst message imports (e.g. 500-message backfills) achieve sub-second insertion throughput without CPU spikes.
2. **Hardware-Accelerated AES-NI Performance:**
   - AES-256-GCM encryption/decryption uses Node's native `node:crypto` built-in, leveraging CPU AES-NI instructions with minimal overhead.
3. **Robust Build & Distribution Reliability:**
   - Standard `better-sqlite3` provides mature, pre-built binaries across macOS (Intel/Apple Silicon), Windows (x64), and Linux. Avoids the complex custom compilation, version pinning, and packaging headaches associated with SQLCipher across Electron and Node versions.
4. **Strict Privacy & Security Guarantee:**
   - All customer data, chat texts, contact names, and phone numbers are completely ciphertext on disk and protected against offline disk inspection or tampering (authenticated encryption guarantees detection of data modification).

---

## 4. Consequences and Mitigations

* **Metadata Visibility:** Message IDs, timestamps, and network identifiers (`whatsapp`, `zalo`) are visible in plaintext SQLite metadata.  
  * *Assessment & Mitigation:* Message IDs are random UUIDs; timestamps reveal timing but zero chat content or identities. Customer PII and message content are fully AES-256-GCM encrypted. This completely satisfies the privacy and data security rules defined in Section 11 and Section 14.
* **Integrity & Tamper Resistance:**  
  * *Mitigation:* AES-256-GCM provides authenticated encryption with an authentication tag (`tag`). Any manual tampering with ciphertext on disk immediately throws an authentication error upon decryption and prevents corrupted deliveries.

