# ADR 0008: Margince Push Protocol, HMAC Signing & Mock Server Architecture

* **Status:** Accepted (Updated with Margince openchannel ground truth)
* **Date:** 2026-11-04 (Updated 2026-11-05)
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 3, 4, 6, 7 [K-4], 8, 11, 13, 14), `margince/margince` repository (`extensions/openchannel`), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Margince CRM is the primary destination (*sink*) for Chat Bridge ([Section 1](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L35-L45), [Feature K-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L195)). The communication architecture is defined by the Margince `openchannel` extension specification (`extensions/openchannel` and `backend/pkg/extension/inbound.go` in `margince/margince`):
1. **Unidirectional Outbound Calls:** Chat Bridge always calls out to Margince; Margince never calls the rep's computer, removing any need for public IP addresses, NAT traversal, or tunnels.
2. **Cryptographic Request Signing (HMAC-SHA256):** Every HTTP push request must be signed over a scope, endpoint slug, endpoint ref, timestamp, nonce, and message payload.
3. **Anti-Replay Security ([Section 13](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L337)):** Tamper-proof replay defense: replaying a captured network request must be refused. Margince returns an opaque 401 Unauthorized for replayed nonces, invalid signatures, or expired timestamps to avoid endpoint enumeration.
4. **Mock Server & Contract Equality ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L347)):** The AI agent and automated test suite must run 100% offline using the Mock Margince Server. The mock server and the live Margince instance must satisfy the exact same contract test suite.
5. **Non-Technical Usability ([Feature K-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L195)):** The sales rep connects to Margince simply by pasting a single connection string.

We evaluated three integration architectures:
1. **Option 1 (Ad-hoc API Key / Bearer Token Header):** Simple authorization header, but lacks anti-replay protection and endpoint scoping.
2. **Option 2 (Canonical HMAC-SHA256 Request Envelope + Deterministic Mock Server):** Newline-delimited canonical signature payload, sliding time window with nonce tracking, and a high-fidelity local mock server matching Margince OpenChannel ground truth.
3. **Option 3 (OAuth 2.0 Client Credentials Flow):** Standard OAuth handshake, but adds unnecessary token negotiation round-trips for machine-to-machine webhook ingestion.

---

## 2. Decision

We choose **Option 2: Canonical HMAC-SHA256 Request Envelope with Nonce Replay Defense & Unified Mock Server Contract Suite**:

1. **Unified Connection String URI:**
   - The rep configures the sink by pasting a single connection URI:
     `margince://<host>/openchannel?ref=<ref>&key=<hex_or_base64_secret>`  
     (e.g., `margince://crm.example.com/openchannel?ref=oc_7f3b&key=9a4c...`)
   - The parser validates the scheme and parameters. The secret key is immediately stored encrypted in SQLite outbox storage (ADR 0002).
2. **Canonical Signature Construction:**
   - **Endpoint Path:** `POST /webhooks/ext/openchannel/receive/{ref}`
   - **Slug:** `receive`
   - **Scope:** Fixed literal `margince-inbound-v1`
   - **Timestamp ($ts$):** Unix timestamp in seconds (`Math.floor(Date.now() / 1000)`).
   - **Nonce ($nonce$):** Hex-encoded unique caller string (`^[0-9a-fA-F]+$`, max 64 characters).
   - **Payload ($rawBody$):** The exact UTF-8 serialized JSON string representing the `arrival` schema.
   - **Canonical String:** Newline-delimited payload:
     ```text
     margince-inbound-v1
     receive
     <ref>
     <ts>
     <nonce>
     <rawBody>
     ```
   - **Signature Calculation:**
     $$\text{signature} = \text{"sha256="} + \text{HMAC-SHA256}_{key}(\text{canonicalString}).\text{hex}()$$
3. **HTTP Transport Headers:**
   - Outbound requests attach:
     - `X-Margince-Timestamp: <ts>`
     - `X-Margince-Nonce: <nonce>`
     - `X-Margince-Signature: sha256=<signature>`
     - `Content-Type: application/json`
4. **Anti-Replay Validation Contract:**
   - Requests with $| \text{now}() - ts | > 900\text{s}$ (15 minutes, `MaxInboundSkew`) are rejected with `401 Unauthorized` (opaque, empty body).
   - Nonces are tracked against the endpoint. Re-used nonces are rejected with `401 Unauthorized` (opaque, empty body).
5. **Single Arrival Delivery Response Contract:**
   - The payload format is a single arrival document (`MarginceInboundArrival`):
     ```json
     {
       "message_id": "whatsapp:rep:native123",
       "thread_id": "thread-456",
       "occurred_at": "2026-11-05T10:45:00Z",
       "subject": "Optional subject",
       "body": "Customer text message",
       "from": {
         "account": "customer-id",
         "email": "customer@example.com",
         "name": "Customer Name"
       },
       "to": {
         "account": "rep-id",
         "email": "rep@example.com",
         "name": "Dylan Rep"
       },
       "participants": [
         {
           "account": "participant-id",
           "name": "Group Member"
         }
       ]
     }
     ```
   - Margince responds with HTTP 202 Accepted (empty body) once verified and queued.
   - On HTTP 202, the sink worker marks delivery as `accepted`.
   - On HTTP 429, the sink treats it as queue over capacity (rate limit) and performs exponential backoff.
   - Any refusal (bad signature, unknown ref, expired timestamp, replayed nonce) returns opaque HTTP 401 with an empty body.
6. **Local Mock Margince Server (`packages/testing/src/mocks/margince-server.ts`):**
   - Implements an embedded Node.js HTTP server running on `127.0.0.1:<mock_port>`.
   - Validates HMAC signatures against `margince-inbound-v1` scope and `receive` slug.
   - Enforces replay windows, evaluates Margince rate limits (60 req/min per IP, max 1000 pending inbound), and records received arrivals.
   - Provides test inspection APIs (`getReceivedArrivals()`, `getReceivedMessages()`, `simulateRateLimit()`, `reset()`).
   - Supports in-memory `dispatch(path, init)` for hermetic sandboxed execution.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Bearer Token | Option 2: Canonical HMAC + Mock Server (Selected) | Option 3: OAuth 2.0 Client Credentials |
| :--- | :--- | :--- | :--- |
| **Replay Defense (Sec. 13)** | **None.** Captured requests can be replayed repeatedly. | **Guaranteed.** 15m timestamp window + unique per-request nonce cache. | Token expiration mitigates, but does not prevent same-token replay. |
| **Spec Conformance (Sec. 8)** | Fails spec requirements. | **100% Conforming.** Exact implementation of Margince openchannel extension. | Adds unnecessary OAuth token negotiation endpoints. |
| **Offline Testing (Sec. 14)** | Requires manual mocks. | **High Fidelity.** Embedded mock server satisfies identical contract tests. | Requires complex local OAuth identity provider mock. |
| **Rep Setup UX (Feature K-4)** | Multiple fields to enter. | **1-Click Paste.** Single `margince://` connection URI. | Requires Client ID, Secret, and Token URL. |
| **Performance Overhead** | Zero. | **Negligible.** Fast hardware-accelerated SHA256 (<0.1ms per arrival). | High (token refresh latency). |

---

## 4. Consequences and Mitigations

* **System Clock Drift:**
  * *Trade-off:* If the sales rep's computer clock drifts by more than 15 minutes, HMAC verification fails with `401 Unauthorized`.
  * *Mitigation:* The engine synchronizes with server time or NTP if skew errors occur.
* **Payload Serialization Variance:**
  * *Trade-off:* Re-serializing JSON can alter whitespace or key order, corrupting the HMAC signature.
  * *Mitigation:* The engine serializes the message arrival to a JSON string **once**; that exact string is used to compute the HMAC and passed directly to the HTTP request stream.
