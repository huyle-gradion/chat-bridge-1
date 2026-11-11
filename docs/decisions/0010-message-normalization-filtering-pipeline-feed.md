# ADR 0010: Message Normalization, Filtering Pipeline & Ephemeral Feed State Machine

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 4, 5, 6, 7 [C-2, C-4, C-8], 10, 11, 14), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Between receiving raw chat events from connectors (WhatsApp, Zalo, Fake) and enqueuing messages into the encrypted Outbox for multi-sink delivery, the engine must enforce strict privacy controls, noise rejection, and user-defined routing rules:

1. **Noise Dropping ([Feature C-4](../spec.md#L154)):** Broadcast stories (`status@broadcast`), newsletter channels, emoji reactions, message edits, and typing notifications must never reach a sink.
2. **Chat Picker Enforcement ([Feature C-8](../spec.md#L155)):** Sales reps tick specific chats that are permitted to leave the computer. **Nothing leaves the computer until at least one chat is ticked.** New chats start unticked.
3. **Privacy & Policy Filters ([Feature C-2](../spec.md#L152)):**
   - Groups are disabled by default.
   - Blocked contact list (`from.accountId` or phone number).
   - Regex/text pattern filters (e.g., automated OTP code filtering `\b\d{4,8}\b` enabled by default).
   - Phone number privacy redaction ("hide phone numbers").
4. **Feed Observability & Manual Override ([Feature C-8](../spec.md#L155), [Section 10](../spec.md#L274)):** The UI Feed screen must display messages as they arrive classified as `sent`, `filtered`, `dropped`, or `waiting`. Reps can select unticked or filtered messages and trigger a manual one-off push ("send these messages").
5. **Privacy & Security Constraints ([Section 11](../spec.md#L295-L298)):** Cleartext customer PII, phone numbers, and chat contents must never be stored unencrypted on disk, even when retained for the local Feed preview.

We evaluated three architectural approaches:
1. **Option 1 (In-Memory Drop & Forget Pipeline):** Raw events failing filters or chat picker checks are discarded in RAM immediately without disk writes.
2. **Option 2 (Unified 6-Stage Pipeline with Ephemeral Encrypted Feed & 7-Day TTL):** A deterministic, sequential pipeline that persists all incoming events in an encrypted operational feed log before selective enqueueing into the outbox.
3. **Option 3 (Post-Outbox Filtering in Sink Workers):** Enqueue every message directly into the outbox and let individual sink workers evaluate chat picker, filters, and noise rules prior to network delivery.

---

## 2. Decision

We choose **Option 2: Unified 6-Stage Sequential Pipeline with Ephemeral Encrypted Feed & Automatic TTL Cleanup**:

```
[ Raw Event ]
      |
      v
[ 1. Normalizer ] ---------> Unified Message Shape (Section 5)
      |
      v
[ 2. Noise Dropper ] ------> Is story / reaction / edit / typing? ---> Yes: Mark 'dropped' -> Feed Log
      | No
      v
[ 3. Chat Picker Gate ] ---> Is thread ticked? ----------------------> No:  Mark 'unpicked' -> Feed Log
      | Yes
      v
[ 4. Privacy Filters ] ----> Group off / Blocked / OTP pattern? -----> Yes: Mark 'filtered' -> Feed Log
      | Passed
      v
[ 5. Data Redactor ] ------> Apply phone masking per sink settings (preserve raw identity for CRM)
      |
      v
[ 6. Outbox Enqueue ] -----> Write to `messages` + `sink_deliveries` (status: 'pending') -> Wake Workers
```

### 1. Pipeline Execution Stages

1. **Stage 1: Normalizer (`normalizer.ts`):**
   - Ingests raw events from `SourceContract` (`onMessage`).
   - Maps network-specific payloads into the standard `Message` schema ([Section 5](../spec.md#L97-L114)).
   - Truncates message text exceeding 32,768 characters and sets `truncated: true`.
   - Converts binary attachments into descriptive placeholders (e.g., `[image: invoice.jpg, 1.2 MB]`).
   - Resolves WhatsApp LID to canonical phone number via the local LID map ([ADR 0006](0006-connector-session-persistence-identity.md)).
2. **Stage 2: Noise Dropper (`noise_filter.ts`):**
   - Matches and drops:
     - WhatsApp broadcast stories (`status@broadcast`).
     - WhatsApp newsletter JIDs (`@newsletter`).
     - Message reaction events (`reactionMessage`).
     - Message edits / protocol revoke messages.
     - Ephemeral typing / presence indicators.
   - If matched, record is assigned status `dropped` and logged to the feed table; pipeline execution halts before outbox.
3. **Stage 3: Chat Picker Gate (`chat_picker.ts`):**
   - Queries the local `picked_chats` table.
   - If the incoming `thread` ID is unticked, the message is assigned status `unpicked` and recorded in the feed log.
   - **Hard Privacy Invariant:** No message with status `unpicked` ever creates records in `sink_deliveries`.
4. **Stage 4: Privacy & Policy Filters (`policy_filters.ts`):**
   - **Group Policy:** If `threadKind === 'group'` and the group filter is enabled (default: true), message is assigned status `filtered_group`.
   - **Blocked Contacts:** Checks `from.accountId` and `from.phone` against the `blocked_contacts` table. If matched, assigned status `filtered_blocked`.
   - **Pattern / OTP Filter:** Evaluates configured regex rules against `message.text`. The default rule:
     ```regexp
     /\b(?:\d{4,8}|OTP|code|ma\s+xac\s+thuc)\b/i
     ```
     matches one-time passwords and verification codes. If matched, assigned status `filtered_pattern`.
5. **Stage 5: Data Redactor (`data_redactor.ts`):**
   - If the user enables "hide phone numbers", phone numbers in `from.phone` and message text are masked (`+8498***123`) for sinks that don't need raw identity (e.g., Google Sheets, Local Analytical DB).
   - For Margince, the raw phone number is preserved in the CRM envelope so Tam's PR can trigger the contact review card ([Section 8](../spec.md#L243-L245)), unless the rep explicitly checks "Mask phone numbers sent to Margince".
6. **Stage 6: Outbox Enqueue (`outbox_writer.ts`):**
   - Encrypts payload with AES-256-GCM ([ADR 0002](0002-outbox-storage-envelope-encryption.md)).
   - Writes `messages` row and creates `pending` rows in `sink_deliveries` for all active sinks.
   - Emits reactive wake event `outbox:queued` ([ADR 0005](0005-outbox-multi-queue-worker-pacing.md)).

### 2. Ephemeral Feed Persistence & Privacy Model

To support the UI Feed screen without storing unencrypted PII on disk:
- Feed records are persisted in the internal SQLite operational database (`~/.chat-bridge/internal.db`) in a dedicated `feed_messages` table.
- **Envelope Encryption:** The message preview text, sender display name, and contact information are encrypted with the same OS Keystore AES-256-GCM master key used for the outbox.
- **Retention TTL:** A background vacuum job runs daily, pruning feed records older than 7 days or capping the table at 5,000 entries, preventing unbounded disk growth.

### 3. Manual Override: "Send These Messages"

When a sales rep selects filtered or unpicked messages in the UI Feed and clicks "Send these messages":
1. The engine checks that the target sink is configured and healthy.
2. The selected message IDs are retrieved from `feed_messages`.
3. The engine creates `pending` rows in `sink_deliveries` for the active sinks, marked with flag `manual_override: 1`.
4. The feed status is updated to `waiting` (and subsequently `sent` upon sink confirmation).

---

## 3. Rationale and Comparison

| Dimension | Option 1: In-Memory Drop & Forget | Option 2: Unified 6-Stage Pipeline + Encrypted Feed (Selected) | Option 3: Post-Outbox Filtering in Sinks |
| :--- | :--- | :--- | :--- |
| **Spec Compliance (Feed & Override)** | **Violated.** UI cannot show filtered/unpicked items; manual push is impossible. | **Full Compliance.** Supports Feed classification (`sent`, `filtered`, `dropped`, `waiting`) and one-off send. | High, but exposes unvetted items to sink processing. |
| **Data Privacy & Leakage** | High (nothing stored), but fails core product features. | **High & Guaranteed.** All feed entries are AES-256-GCM encrypted; automatic 7-day TTL pruning. | **Poor.** Enqueues blocked/unpicked data into delivery queues unnecessarily. |
| **Write Amplification & Throughput** | Low (only passed messages written). | **Optimized.** Single indexed SQLite WAL transaction; negligible write overhead with AES-NI hardware crypto. | High. Writes every noise event and group message to queue tables before worker discards. |
| **Architectural Separation** | Mixed across event handlers. | **Clean & Modular.** Discrete, testable pipeline stages conforming to single-responsibility principle. | Leaky. Sink workers must know about global privacy and chat picking logic. |

---

## 4. Consequences and Mitigations

* **Disk Usage for Filtered/Dropped Feed:** Storing dropped and filtered items could increase disk usage during high chat volume.
  * *Mitigation:* The automatic 7-day TTL pruner and 5,000-message table ceiling strictly cap `feed_messages` storage to under 15 MB in SQLite WAL mode.
* **Regex Performance on Large Messages:** Evaluating regular expressions over 32,768-character messages could block the Node.js event loop if poorly structured.
  * *Mitigation:* Text pattern filters use non-backtracking regular expressions, and evaluation is capped to the first 4,096 characters for OTP pattern checks.

