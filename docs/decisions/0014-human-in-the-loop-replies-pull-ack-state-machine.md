# ADR 0014: Human-in-the-Loop Replies & Pull/Ack State Machine

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 3, 6, 7 [R-1, R-2], 8), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Sections 3, 7, and 8 of `docs/spec.md` specify the protocol and user experience for handling customer replies originating from Margince CRM:
1. **Scope and Priority ([Section 3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L71), [Features R-1, R-2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L205-L208)):** In "Should" scope (Priority 1), Margince customer replies appear in a dedicated UI inbox (via pull) and are transmitted to the recipient chat network.
2. **Absolute Anti-Spam Safety Invariant ([Section 3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L83), [Feature R-2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L208)):**
   - *"A reply is sent only after **one human click**."*
   - *"Never retried automatically."*
   - *"Automatic or bulk sending. **Never.**"*
3. **Margince Pull/Ack Protocol ([Section 8](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L225-L235)):**
   - **Pull:** `POST /webhooks/ext/openchannel/pull/{ref}` requesting waiting replies.
   - **Ack:** `POST /webhooks/ext/openchannel/ack/{ref}` confirming `sent` or `failed` with reason.
   - All requests must use the canonical HMAC-SHA256 signature scheme with endpoint-scoped slugs (`pull` and `ack`) to prevent signature reuse ([ADR 0008](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0008-margince-push-protocol-hmac-mock.md)).
4. **Architectural Challenge:** The codebase must provide physical, architectural prevention against any background automation or batch job ever auto-sending messages without explicit, verified human UI intervention.

We evaluated three reply architectures:
1. **Option 1 (Direct In-Memory Pass-Through with Modal):** Client UI polls Margince directly via local proxy and calls `source.send()` on button click.
2. **Option 2 (Staged Replies Storage + Single-Use Action Token Gate + One-Shot Ack Machine):** Staged persistence in SQLite with single-use cryptographic tokens ensuring physical human initiation, coupled with strict one-shot dispatching and signed acks.
3. **Option 3 (Autonomous Queue with Rule-Based Auto-Approve):** Rules engine allowing automatic sending of pre-approved replies.

---

## 2. Decision

We choose **Option 2: Staged Replies Storage with Single-Use Action Token Gate & Strict One-Shot Dispatch / Ack State Machine**:

```
 [ Margince CRM ]
        ^
        | Pull (HMAC signed, slug: 'pull')
        v
 [ Adaptive Pull Polling Worker ] ----------------------------+
        |                                                     |
        v                                                     v
 [ SQLite: `inbox_replies` Table ]              [ Ephemeral Action Token ]
 (status: 'pending_user_click')                 (UUIDv4 tied to reply ID)
        |                                                     |
        +-----------------------+-----------------------------+
                                |
                                v
                [ UI Inbox Screen: Reply Card ]
                - Displays text, recipient, thread
                - "Send Reply" button armed with action token
                                |
                                v (Human Clicks "Send")
                [ API: POST /api/v1/replies/:id/send ]
                - Verifies & immediately burns Action Token
                - Transitions status to 'sending'
                                |
                                v
                [ Source Connector: `send(thread, text)` ]
                                |
                +---------------+---------------+
                | (Success)                     | (Error / Thrown)
                v                               v
         status = 'sent'                status = 'failed' (reason)
                |                               |
                +---------------+---------------+
                                |
                                v
        [ Immediate Ack: POST /webhooks/ext/openchannel/ack/{ref} ]
          (HMAC signed, slug: 'ack', deliveryId + status)
```

### 1. Adaptive Pull Polling Worker

1. When the Margince sink is active, a background `PullWorker` executes periodically:
   - Request: `POST /webhooks/ext/openchannel/pull/{ref}` with `{ "limit": 10 }`.
   - Signed with HMAC-SHA256 using slug `pull` ([ADR 0008](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0008-margince-push-protocol-hmac-mock.md)).
2. **Adaptive Polling Cadence:**
   - Active state (replies received or user active in UI): Polls every **30 seconds**.
   - Idle state (zero replies over 10 consecutive checks): Backs off to **120 seconds** to preserve the Margince 60 req/min quota.
3. Received replies are inserted into `inbox_replies`:
   ```sql
   CREATE TABLE inbox_replies (
     id TEXT PRIMARY KEY,               -- Internal UUID
     delivery_id TEXT UNIQUE NOT NULL,  -- Margince delivery ID
     network TEXT NOT NULL,             -- 'whatsapp' or 'zalo'
     thread TEXT NOT NULL,              -- Target chat thread ID
     recipient TEXT NOT NULL,           -- Recipient identifier
     text TEXT NOT NULL,                -- Content to send
     status TEXT NOT NULL,              -- 'pending_user_click', 'sending', 'sent', 'failed', 'dismissed'
     action_token TEXT,                 -- Ephemeral token required for execution
     error_reason TEXT,                 -- Failure reason if rejected
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   ```

### 2. Single-Use Action Token & Human Gate

1. To strictly enforce the *"sent only after one human click"* and *"never automatic"* invariant:
   - When the UI loads an inbox reply card, the engine generates an ephemeral `action_token` (UUIDv4) associated with that specific reply row.
   - The UI "Send" button submits `POST /api/v1/replies/:id/send` with `action_token` in the request header.
   - The engine validates that the record is in `pending_user_click` status and the `action_token` matches.
   - **Immediate Invalidation:** The engine immediately sets `action_token = NULL` and status to `sending` inside a single SQLite transaction before initiating any network action.
   - This physically prevents double-clicks, automated scripts, or replay loops from dispatching messages.

### 3. One-Shot Connector Dispatch & Immediate Ack

1. The engine dispatches the payload to the corresponding chat connector:
   ```typescript
   await sourceConnector.send(reply.thread, reply.text);
   ```
2. **Error Translation & Zero Automatic Retries:**
   - If the network call throws (e.g. contact blocked, session expired, invalid group), the error is caught, translated into a plain-language explanation, and recorded as `failed`.
   - **Invariant:** A failed reply is **never retried automatically**.
3. **Signed Acknowledgment Dispatch:**
   - The engine immediately prepares an acknowledgment payload:
     ```json
     {
       "deliveryId": "del_89abc",
       "status": "sent" // or "failed"
       "reason": "Recipient has blocked messaging" // if failed
     }
     ```
   - Sent to `POST /webhooks/ext/openchannel/ack/{ref}` signed with HMAC-SHA256 using slug `ack`.

---

## 3. Rationale and Comparison

| Dimension | Option 1: In-Memory Pass-Through | Option 2: Staged DB + Action Token Gate (Selected) | Option 3: Autonomous Queue with Rules |
| :--- | :--- | :--- | :--- |
| **"Never Automatic" Invariant** | Moderate. Client-side only; vulnerable to state desync. | **Absolute & Enforced.** Ephemeral token and database state machine make auto-send physically impossible. | **Violated.** Violates explicit spec rule *"Automatic or bulk sending. Never."* |
| **Durability Across App Restarts** | **Poor.** Unsent replies vanish if laptop sleeps or restarts. | **Crash-Proof.** State stored in `inbox_replies`; un-sent cards reload cleanly in UI. | High. |
| **Quota Protection (60 req/min)** | Poor. Ad-hoc polling easily floods CRM endpoints. | **Adaptive.** Token-bucket bounded polling with 30s–120s backoff leaves ample quota for outbound push. | High. |
| **Auditability & Tamper Resistance** | None. | **Full History.** Complete record of human-initiated actions, native errors, and ack confirmations. | Leaky. |

---

## 4. Consequences and Mitigations

* **Orphaned Replies if Unsent:** Replies may sit in `pending_user_click` indefinitely if the sales rep ignores them.
  * *Mitigation:* The UI provides an explicit "Dismiss" button which updates status to `dismissed` and sends an acknowledgment with reason `"Dismissed by sales rep"`, clearing the card from both Margince and the local inbox.
* **Network Interruption During Ack:** If the source connector sends the chat message, but the subsequent ack to Margince fails due to a network outage, Margince might not know the reply was sent.
  * *Mitigation:* If the `ack` call fails due to a transient network error, the ack payload is enqueued into the Outbox with standard retry pacing, ensuring Margince receives the confirmation without ever re-sending the message to the chat network.

