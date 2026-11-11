# ADR 0026: WhatsApp Pairing-Code Handshake & Multi-Device Login State Machine

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 7 [Features S-3, I-1, I-4, C-7], 9, 10, 11), `docs/decisions/0004-web-ui-transport-local-api.md`, `docs/decisions/0006-connector-session-persistence-identity.md`

---

## 1. Context and Problem Statement

Connecting WhatsApp in Chat Bridge must support both camera QR scanning and pairing-code authentication ([Section 7 Feature S-3](../spec.md#L185)):
- Non-technical sales representatives frequently work on desktop workstations without webcams, with covered cameras, or need to link a mobile device without pointing a camera at their screen.
- WhatsApp Multi-Device protocol provides an alternative pairing flow: the client enters their phone number with country code, the server generates an 8-character alphanumeric pairing code (e.g. `ABCD-1234`), and the rep enters this code in their WhatsApp mobile app under *Linked Devices > Link with phone number instead*.

### Architectural Challenges & Constraints
1. **Interactive Two-Way Negotiation Over Local API:**
   - While QR code authentication is unidirectional (engine renders ASCII or SVG QR to stream), pairing codes require a bidirectional interactive handshake: phone number submission -> socket negotiation -> code broadcast -> countdown timer -> connection confirmation.
2. **Short Time-to-Live (TTL) & Socket Race Conditions:**
   - WhatsApp pairing codes expire within 60–120 seconds. If the user mistypes the code on their phone or takes too long, the socket closes with an authentication timeout.
   - The user may change their mind and click *"Scan QR code instead"*, or enter a different phone number. Switching authentication modes must cleanly abort any pending pairing handshake without leaving orphaned Baileys sockets or corrupting Signal pre-keys in `sessions.db` ([ADR 0006](0006-connector-session-persistence-identity.md)).
3. **Headless CLI Parity ([Feature I-1](../spec.md#L200)):**
   - Must be fully functional in terminal mode: `chat-bridge login whatsapp --pairing-code +84901234567`.

We evaluated three architectural approaches:
1. **Option 1: Polling-Based REST Endpoints with Short Intervals.**
2. **Option 2 (Accepted): Two-Way Event-Driven Handshake via Loopback REST & Persistent SSE Stream with Cancellation Guards.**
3. **Option 3: Electron Main Process Direct IPC Dialogue (Web UI Only).**

---

## 2. Decision

We choose **Option 2: Two-Way Event-Driven Handshake via Loopback REST & Persistent SSE Stream with Cancellation Guards**:

```
[ Sales Rep (UI or CLI) ]                  [ Loopback HTTP Server ]             [ Baileys Connector ]
           |                                          |                                   |
           |-- 1. POST /whatsapp/pairing-code ------->|                                   |
           |      { phoneNumber: "+84901234567" }     |                                   |
           |                                          |-- 2. Validate E.164 ------------->|
           |                                          |      Request Pairing Code         |
           |                                          |                                   |-- 3. Baileys Handshake -> WhatsApp
           |                                          |                                   |<-- Code: "ABCD-1234" (TTL: 60s) --+
           |<-- 4. SSE event: 'whatsapp:pairing_code' -|                                   |
           |      { code: "ABCD-1234", ttl: 60 }      |                                   |
           |                                          |                                   |
   [ Rep Enters Code                                  |                                   |
     On Phone App ]                                   |                                   |
           |                                          |                                   |<-- 5. Multi-Device Signal Sync ---+
           |                                          |<-- 6. Socket 'open' Event --------|
           |<-- 7. SSE event: 'whatsapp:connected' ---|                                   |
           |      { phone: "+84901234567", ... }      |                                   |-- 8. Commit Signal Keys to
           |                                          |                                          sessions.db
```

### Technical Specification

#### 1. Phone Number Normalization & Validation
Located in `packages/core/src/sources/whatsapp/WhatsAppAuth.ts`:
- Input numbers are cleaned using `google-libphonenumber`:
  ```typescript
  export function validateAndCleanPhoneNumber(rawNumber: string): string {
    const phoneUtil = PhoneNumberUtil.getInstance();
    const parsed = phoneUtil.parseAndKeepRawInput(rawNumber, 'VN'); // Default fallback Vietnam
    if (!phoneUtil.isValidNumber(parsed)) {
      throw new InvalidPhoneNumberError('Please enter a valid phone number with country code (e.g. +84...)');
    }
    // Baileys requires pure digit format without leading '+'
    return `${parsed.getCountryCode()}${parsed.getNationalNumber()}`;
  }
  ```

#### 2. Handshake State Machine & Mode Switching
Located in `packages/core/src/sources/whatsapp/WhatsAppSource.ts`:
```typescript
export type WhatsAppAuthMode = 'qr' | 'pairing_code';

export interface WhatsAppAuthState {
  mode: WhatsAppAuthMode;
  code?: string;
  qrData?: string;
  expiresAt?: number;
  error?: string;
}
```
- **Concurrency & Mode Switching Guard:**
  - If a pairing code request arrives while the socket is generating QR codes, the connector cancels the active QR poll, resets the auth credentials, and calls:
    ```typescript
    const code = await sock.requestPairingCode(cleanedPhoneNumber);
    this.sseEmitter.emit('whatsapp:pairing_code', {
      code: formatPairingCode(code), // e.g., "ABCD-1234"
      expiresInSeconds: 60
    });
    ```
  - **Cancel Endpoint (`POST /api/v1/sources/whatsapp/cancel`):**
    If the sales rep clicks *"Cancel"* or switches back to QR code mode, any active pairing request is terminated, the timeout is cleared, and the socket gracefully falls back to generating a fresh QR code without recreating the underlying `sessions.db` tables.

#### 3. Plain-Language UI Experience (Feature I-4)
- **Segmented Visual Code Tiles:** The Web UI displays the 8-character pairing code in two large-font 4-character boxes (`ABCD` - `1234`) with a 1-click *"Copy code"* button.
- **Visual Countdown Progress Bar:** A smooth 60-second animated timer shows remaining validity. If the timer reaches 0 before connection, the screen displays: *"Code expired. Click here to generate a new code"*.
- **Desktop Notification on Success:** Once linked, emits desktop notification: *"WhatsApp connected successfully."*

#### 4. Headless CLI Parity (`chat-bridge login`)
In CLI mode:
```bash
chat-bridge login whatsapp --pairing-code +84901234567
```
Output:
```
Requesting pairing code for +84901234567...
-------------------------------------------
Your pairing code is: ABCD-1234
Enter this code on your phone in WhatsApp > Linked Devices > Link with phone number.
Code expires in: 60s
-------------------------------------------
[✓] WhatsApp linked successfully! Connected as +84901234567.
```

---

## 3. Rationale and Comparison

| Dimension | Option 1: Polling REST Endpoints | Option 2 (Accepted): Event-Driven SSE + REST | Option 3: Electron IPC Only |
| :--- | :--- | :--- | :--- |
| **Real-Time Responsiveness** | Laggy (1–2s polling jitter). | **Instant.** Code and connection state stream immediately over SSE. | Fast, but desktop-only. |
| **CLI & Web Parity (Feature I-1)** | Clunky polling logic in CLI. | **Identical Engine.** CLI and Web UI listen to the exact same event stream. | **Zero CLI support.** |
| **Graceful Abort & Cancellation** | Prone to dangling requests. | **Clean Cancellation.** Aborts active timeout and restores QR generation. | Complex window lifecycle ties. |
| **Security & Session Hygiene** | Redundant credential lookups. | **Strict.** Keys committed atomically to `sessions.db` only upon `open` event. | High coupling to renderer. |

---

## 4. Consequences and Mitigations

* **Trade-off 1:** WhatsApp enforces strict rate limits on pairing code generation (too many rapid requests trigger HTTP 429 / socket lockout).
  * *Mitigation:* The backend enforces a local client-side rate limit: maximum 3 pairing code requests per 5 minutes per phone number. A cooldown timer is displayed in the UI if reached.
* **Trade-off 2:** Country code entry errors by non-technical reps.
  * *Mitigation:* The UI provides an interactive country selector dropdown with pre-filled flags and prefixes (defaulting to `+84 Vietnam`), running client-side phone validation before dispatching to the engine.

