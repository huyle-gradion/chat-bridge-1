# ADR 0028: Chat Roster Discovery, Dynamic Chat Picker & Ad-Hoc Message Push Orchestration

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 4, 7 [Features C-8, C-2, I-4], 10, 11), `docs/decisions/0002-outbox-storage-envelope-encryption.md`, `docs/decisions/0005-outbox-multi-queue-worker-pacing.md`, `docs/decisions/0009-local-storage-sinks-database-archive.md`, `docs/decisions/0010-message-normalization-filtering-pipeline-feed.md`, `docs/decisions/0019-application-configuration-store-secrets-segregation.md`

---

## 1. Context and Problem Statement

The Chat Picker is the central privacy boundary of Chat Bridge ([Section 4](../spec.md#L80), [Feature C-8](../spec.md#L173)):
- *"The rep sees a list of their chats and ticks the ones to send."*
- ***Nothing leaves the computer until at least one chat is ticked.***
- *"New chats start unticked."*
- *"The feed has 'send these messages' for a one-off push of selected messages."*

### Key Architectural Challenges & Mandates
1. **Zero Outbound Data Leakage Before Explicit Consent:**
   - Even if WhatsApp or Zalo connects and ingests thousands of conversations, zero messages must be enqueued into `outbox.db` queues or sent to any sink (Margince CRM, Google Sheets, local database) unless that specific chat has been ticked by the rep.
2. **Local Roster Discovery & Incremental Sync:**
   - Chat rosters (group names, direct contact names, avatars, last message timestamps) must be cached locally to render the Chat Picker screen instantly without making synchronous protocol queries on every page visit.
   - The chat roster itself must **never be transmitted to sinks**; it is purely local UI metadata.
3. **Unticked Chat Ingestion & Feed Display:**
   - When an unticked contact sends a message, the message must appear in the local Web UI Feed so the rep can see it and decide whether to tick the chat. However, it must never enter any sink outbox queue.
4. **Ad-Hoc One-Off Message Forwarding ("Send these messages"):**
   - The sales rep can select 1 or more specific messages from an unticked contact in the Feed and click *"Send these messages"*.
   - This must securely enqueue only the selected messages to active sinks without permanently ticking the chat for future messages.

We evaluated three architectural options:
1. **Option 1: Ingestion-Time Outbox Enqueueing with Sink-Time Gating.**
2. **Option 2 (Accepted): Pipeline Gating with Ephemeral Feed Isolation, Local SQLite Roster Cache & Ad-Hoc Outbox Injection.**
3. **Option 3: Pure In-Memory Ephemeral Chat Filter.**

---

## 2. Decision

We choose **Option 2: Pipeline Gating with Ephemeral Feed Isolation, Local SQLite Roster Cache & Ad-Hoc Outbox Injection**:

```
                       [ Incoming Normalized Message ]
                                      |
                                      v
                     [ Stage 3: Chat Picker Gate ]
                                      |
                     Is chat ticked in settings.json?
                     (pickedChatIds.has(thread.id))
                                      |
                    +-----------------+-----------------+
                    | (Ticked)                          | (Unticked)
                    v                                   v
          [ Insert into outbox.db ]           [ Insert ONLY into feed.db ]
          - Enqueue per active sink           - Status: 'filtered_unpicked'
          - Insert into feed.db ('waiting')   - NEVER touches outbox queues!
                    |                                   |
                    v                                   v
          [ Delivered to Sinks ]              [ Visible in Local UI Feed ]
                                                        |
                                                        v
                                         [ Rep selects 3 messages & clicks ]
                                         [     "Send these messages"       ]
                                                        |
                                                        v
                                         [ POST /api/v1/feed/send-adhoc ]
                                                        |
                                                        v
                                         [ Fetch messages from feed.db ]
                                         [ Inject directly into outbox.db ]
                                         [ with reason: 'manual_adhoc' ]
                                                        |
                                                        v
                                         [ Dispatched to Active Sinks ]
                                         (Chat remains unticked!)
```

### Technical Specification

#### 1. Local Chat Roster Store (`chat_roster`)
Located in `analytics.db` ([ADR 0009](0009-local-storage-sinks-database-archive.md)):
```sql
CREATE TABLE IF NOT EXISTS chat_roster (
    thread_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,                -- 'whatsapp' | 'zalo' | 'fake'
    name TEXT NOT NULL,
    is_group INTEGER NOT NULL,           -- 0 = DM, 1 = Group
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_message_text TEXT,
    last_message_at TEXT,                -- ISO 8601 UTC
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_roster_last_msg ON chat_roster (last_message_at DESC);
```
- **Sync Behavior:**
  - WhatsApp: Updated when Baileys emits `chats.upsert`, `chats.update`, or incoming messages.
  - Zalo: Updated when `zca-js` fetches thread lists or receives message events.
  - Cached locally with sub-millisecond query latency; Chat Picker screen loads instantly without network lag.

#### 2. Ticked Chat Selection Authority (`SettingsStore`)
- Persisted in `settings.json` under `pickedChatIds` ([ADR 0019](0019-application-configuration-store-secrets-segregation.md)):
  ```typescript
  export interface PickedChatsConfig {
    pickedChatIds: string[]; // Set of thread IDs approved by user
  }
  ```
- **In-Memory Fast Set:**
  `PipelineFilter` maintains a fast `Set<string>` updated on configuration change events.
- **Strict Hard Gate:**
  ```typescript
  if (this.pickedChatIds.size === 0 || !this.pickedChatIds.has(message.thread.id)) {
    // Drop from outbound queueing; persist ONLY to ephemeral feed
    await this.feedStore.insert({
      ...message,
      feedStatus: 'filtered_unpicked'
    });
    return null; // Pipeline stops here; 0 bytes reach outbox.db
  }
  ```

#### 3. Unticked Ingestion & Ephemeral Feed Retention
- Messages from unticked chats are stored in `feed.db` ([ADR 0010](0010-message-normalization-filtering-pipeline-feed.md)) with status `filtered_unpicked`.
- Ephemeral feed entries are encrypted at rest with envelope encryption ([ADR 0002](0002-outbox-storage-envelope-encryption.md)) and automatically pruned after a 7-day TTL.
- Feed UI clearly labels these messages with a subtle gray badge: *"Unticked chat"*.

#### 4. Ad-Hoc One-Off Message Forwarding Architecture
Located in `packages/core/src/feed/AdHocForwarder.ts`:
- **Endpoint:** `POST /api/v1/feed/send-adhoc`
  ```json
  {
    "messageIds": ["cb_zalo_12345", "cb_zalo_12346"]
  }
  ```
- **Execution Workflow:**
  1. Retrieves canonical messages from `feed.db` by ID.
  2. Verifies that messages exist and have not already been delivered to all active sinks.
  3. Inserts each message into `outbox.db` queues for all currently enabled sinks:
     ```sql
     INSERT INTO outbox_entries (
         message_id, sink_id, priority, status, delivery_reason, payload, created_at
     ) VALUES (
         ?, ?, 10, 'pending', 'manual_adhoc', ?, ?
     ) ON CONFLICT (message_id, sink_id) DO NOTHING;
     ```
  4. Updates the message's feed status from `filtered_unpicked` to `waiting` (and subsequently `sent` when delivered).
  5. **Chat Remains Unticked:** The `pickedChatIds` array is untouched. Future messages from that sender continue to be filtered unless the user explicitly toggles the chat in the Chat Picker.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Enqueue All to Outbox + Late Filter | Option 2 (Accepted): Gated Pipeline + Ephemeral Feed + Ad-Hoc Injection | Option 3: Pure In-Memory Filter |
| :--- | :--- | :--- | :--- |
| **Privacy Guarantee** | **Fragile.** Messages from unapproved contacts sit in outbound database queues. | **Absolute.** Zero unapproved messages ever touch `outbox.db`. | High leak risk on restarts. |
| **Ad-Hoc One-Off Push** | Awkward queue status mutations. | **Clean.** Direct one-off injection with explicit audit reason `manual_adhoc`. | Impossible after memory wipe. |
| **Roster UI Speed** | Slow; requires querying remote chat network APIs. | **Sub-millisecond.** Local SQLite `chat_roster` table cached with WAL. | Re-queries network on boot. |
| **Storage Hygiene** | High database bloat. | **Pruned.** Unticked feed messages auto-deleted after 7-day TTL. | No local history. |

---

## 4. Consequences and Mitigations

* **Trade-off 1:** If a sales representative receives thousands of messages per day in unticked high-traffic groups, storing them in `feed.db` could consume local disk space.
  * *Mitigation:* The 7-day TTL pruner ([ADR 0010](0010-message-normalization-filtering-pipeline-feed.md)) runs every 24 hours. Additionally, groups are disabled by default ([Feature C-2](../spec.md#L170)), so unpicked group spam is dropped at Stage 2 before even touching `feed.db`.
* **Trade-off 2:** If the user sends an ad-hoc message and then later ticks the chat, duplicate messages could potentially be queued.
  * *Mitigation:* The unique constraint on `(message_id, sink_id)` in `outbox.db` guarantees that no message can ever be delivered more than once to any sink, preventing duplicates.

