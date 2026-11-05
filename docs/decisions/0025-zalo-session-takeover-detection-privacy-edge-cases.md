# ADR 0025: Zalo Connector Architecture, Session Takeover Detection & Privacy Edge Cases

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 7 [Features S-2, C-1, C-7], 11, 13, 15), `docs/decisions/0006-connector-session-persistence-identity.md`, `docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md`

---

## 1. Context and Problem Statement

Chat Bridge integrates personal Zalo accounts via the unofficial `zca-js` library ([Section 1](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L30), [Feature S-2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L184)):
- Connects via QR code scan in the UI.
- Normalizes incoming messages to canonical `Message` schema within 5 seconds.
- Caches sender profiles fetched via `getUserInfo`.
- Emits desktop warnings when Zalo Web takes over the session ([Feature C-7](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L176)).

### Critical Protocol & Privacy Edge Cases
1. **Single Concurrent Web Session Limit & Account Ban Hazards:**
   - Zalo strictly limits each user account to **one active web/browser session**.
   - If the sales representative opens `chat.zalo.me` in Google Chrome while Chat Bridge is running, Zalo's WebSocket servers immediately terminate the `zca-js` session with error code `1001` (Session Conflict / Disconnected by newer session).
   - **The Hazard:** If Chat Bridge treats this as a standard network drop and attempts aggressive automatic reconnection, it enters an infinite ping-pong takeover loop with the rep's browser. Zalo's anti-abuse heuristics will flag the account as an automated bot, resulting in a temporary or permanent account ban.
2. **Identity Ambiguity: `uidFrom` vs `globalId` ([Section 15](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L360)):**
   - Spec Open Question: *"Is a Zalo user id the same when seen from two different accounts? Also test zca-js globalId."*
   - In Zalo's internal architecture, `uidFrom` is sometimes scoped to the specific user's relationship or conversation session, whereas `globalId` represents the immutable platform-wide user identifier.
3. **Contact vs Stranger Phone Number Privacy ([Section 15](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L359)):**
   - Spec Open Question: *"Does Zalo's `getUserInfo` give a phone number for a stranger, or only for friends?"*
   - If a stranger messages the sales representative, `getUserInfo` returns profile metadata (display name, avatar URL) but masks or omits the phone number unless the contact has explicitly shared their phone number or enabled public discovery.
   - The system must conform strictly to the privacy rule: *"A phone number is sent only if WhatsApp/Zalo gave it."*

We evaluated three architectural approaches:
1. **Option 1: Aggressive Reconnect with Exponential Backoff.**
2. **Option 2 (Accepted): Conflict-Aware Session Watchdog, Safe Lockout State Machine, and Two-Tier Identity Resolution.**
3. **Option 3: Passive Disconnect with Generic Offline Classification.**

---

## 2. Decision

We choose **Option 2: Conflict-Aware Session Watchdog, Safe Lockout State Machine, and Two-Tier Identity Resolution**:

```
                              [ Incoming zca-js Event ]
                                          |
                      +-------------------+-------------------+
                      | (Normal Message)                      | (Connection Error / Drop)
                      v                                       v
          [ Ingestion Pipeline ]                      [ Evaluate Close Code ]
          - Resolve Sender Profile                            |
          - Cache Profile in sessions.db       +--------------+--------------+
          - Forward to Outbox                  |                             |
                                               v                             v
                                  [ Close Code === 1001 ]       [ Network Timeout / Socket Error ]
                                  (Session Conflict / Takeover) (Transient Network Flap)
                                               |                             |
                                               v                             v
                                  [ Freeze Zalo Connector ]     [ Exponential Jittered Backoff ]
                                  - Do NOT auto-reconnect       - Max 5 retries over 5 minutes
                                  - Set state: KICKED_BY_WEB    - Back to Active on reconnect
                                  - Trigger C-7 Warning
                                               |
                                               +------------------------+
                                               |                        |
                                               v                        v
                                    [ Desktop Notification ]     [ UI Persistent Banner ]
                                    "Zalo opened elsewhere.     "Zalo was opened in another window.
                                     Click to reconnect."        Messages are paused."
                                                                        |
                                                                        v
                                                            [ Rep Clicks "Reconnect" ]
                                                                        |
                                                                        v
                                                             [ Fresh QR Code Prompt ]
```

### Technical Specification

#### 1. Session Takeover Watchdog & Anti-Ban State Machine
Located in `packages/core/src/sources/zalo/ZaloSource.ts`:
- **Disconnection Trapping:**
  ```typescript
  export type ZaloConnectionState = 
    | 'disconnected'
    | 'connecting'
    | 'scanning_qr'
    | 'connected'
    | 'kicked_by_web'
    | 'rate_limited';
  ```
- **Takeover Guard:**
  When `zca-js` emits `error` or `close`:
  ```typescript
  if (isSessionTakeoverError(error)) {
    this.state = 'kicked_by_web';
    this.watchdog.stopHeartbeat();
    
    // STRICT ANTI-BAN RULE: Never auto-reconnect on session conflict
    this.emit('session_conflict', {
      source: 'zalo',
      message: 'Zalo was opened in a web browser or another device.',
      actionRequired: 'Click reconnect when you are ready to resume message forwarding.'
    });
  }
  ```
- **Plain-Language User Notification (Feature C-7):**
  - Triggers native desktop notification ([ADR 0021](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0021-desktop-process-lifecycle-sleep-wake-tray.md)):
    *Title:* "Zalo connection paused"  
    *Body:* "Zalo was opened in another window. Click here to resume."
  - UI Home Screen and Status Bar render a high-visibility amber banner with a single action button: *"Reconnect Zalo"*.

#### 2. Identity Mapping: `globalId` vs `uidFrom`
Located in `packages/core/src/sources/zalo/ZaloNormalizer.ts`:
- When normalizing messages into the canonical `Message` schema ([Section 5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L101)):
  - Canonical Message ID:
    ```typescript
    message.id = `cb_zalo_${rawMsg.msgId}`;
    ```
  - Sender ID Resolution:
    - Primary candidate: `rawMsg.globalId || rawMsg.uidFrom`.
    - `sessions.db` maintains a `zalo_identities` table mapping `uidFrom -> globalId` so when a contact is observed across groups or direct messages, their identity is unified.
    - If `globalId` is not returned by older `zca-js` protocols, fallback to `uidFrom`.

#### 3. Stranger Phone Number Privacy Handling
- `getUserInfo(uid)` is queried on first contact and cached in `sessions.db` for 30 days ([Section 7 Feature S-2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L184)).
- **Phone Field Mapping:**
  ```typescript
  const phone = (profile.phoneNumber && profile.phoneNumber.trim().length > 0) 
    ? normalizeE164(profile.phoneNumber) 
    : null;

  sender: {
    id: senderId,
    name: profile.displayName || rawMsg.senderName || 'Unknown Contact',
    phone: phone, // Explicit null if stranger or hidden
    isMe: rawMsg.uidFrom === this.myUid
  }
  ```
- No speculative phone derivation or heuristic extraction is ever performed. If Zalo does not provide a phone number, the field is sent as `null`.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Aggressive Reconnect Loop | Option 2 (Accepted): Conflict Watchdog + Explicit Gate | Option 3: Passive Disconnect |
| :--- | :--- | :--- | :--- |
| **Account Ban Prevention** | **Dangerous.** Infinite ping-pong with rep's browser triggers Zalo anti-bot ban. | **100% Safe.** Immediately halts socket reconnects until explicit rep confirmation. | Safe from ban, but silent. |
| **UX & Plain Language (C-7)**| Confusing. Rep's browser tab repeatedly gets kicked out. | **Clear.** Desktop notification and banner explain what happened and next click. | Confusing. Rep wonders why messages stopped arriving. |
| **Identity Unification** | Uses `uidFrom` only; splits identity if seen across channels. | **Unified.** Resolves `globalId` where available with local SQLite cache. | Fragmented IDs. |
| **Privacy Compliance** | Risk of leaking unverified metadata. | **Strictly Compliant.** Phone populated only if explicitly supplied by API. | Variable. |

---

## 4. Consequences and Mitigations

* **Trade-off 1:** When the sales rep opens Zalo Web to send personal messages, message forwarding in Chat Bridge pauses until they click "Reconnect".
  * *Mitigation:* This is an unavoidable constraint of Zalo's single-web-session architecture. Educating the rep via the C-7 banner and desktop notification sets clear expectations. Messages sent while disconnected are fetched via history backfill upon reconnection ([ADR 0011](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0011-history-import-rate-pacing-priority-scheduling.md)).
* **Trade-off 2:** `getUserInfo` rate limiting by Zalo servers during high-traffic group message bursts.
  * *Mitigation:* A local in-memory LRU cache backed by SQLite `contact_profiles` table ensures `getUserInfo` is executed strictly once per unique sender ID, eliminating redundant network calls.

