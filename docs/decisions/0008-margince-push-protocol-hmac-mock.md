# ADR 0008: Margince Push Protocol, HMAC Signing & Mock Server Architecture

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 3, 4, 6, 7 [K-4], 8, 11, 13, 14), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Margince CRM is the primary destination (*sink*) for Chat Bridge ([Section 1](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L35-L45), [Feature K-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L195)). The communication architecture is defined by Tam Vu's `openchannel` extension specification ([Section 8](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L216-L248)):
1. **Unidirectional Outbound Calls:** Chat Bridge always calls out to Margince; Margince never calls the rep's computer, removing any need for public IP addresses, NAT traversal, or tunnels.
2. **Cryptographic Request Signing (HMAC-SHA256):** Every HTTP push request must be signed over a scope, endpoint slug, endpoint ref, timestamp, nonce, and message payload.
3. **Anti-Replay Security ([Section 13](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L337)):** Tamper-proof replay defense: replaying a captured network request must be refused.
4. **Mock Server & Contract Equality ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L347)):** The AI agent and automated test suite must run 100% offline using the Mock Margince Server. The mock server and the live Margince instance must satisfy the exact same contract test suite.
5. **Non-Technical Usability ([Feature K-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L195)):** The sales rep connects to Margince simply by pasting a single connection string.

We evaluated three integration architectures:
1. **Option 1 (Ad-hoc API Key / Bearer Token Header):** Simple authorization header, but lacks anti-replay protection and endpoint scoping.
2. **Option 2 (Canonical HMAC-SHA256 Request Envelope + Deterministic Mock Server):** Newline-delimited canonical signature payload, sliding time window with nonce tracking, and a high-fidelity local mock server.
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
   - **Slug:** `push`
   - **Scope:** `openchannel:v1`
   - **Timestamp ($ts$):** Unix timestamp in seconds (`Math.floor(Date.now() / 1000)`).
   - **Nonce ($nonce$):** Cryptographically random UUIDv4 (`crypto.randomUUID()`).
   - **Payload ($rawBody$):** The exact UTF-8 serialized JSON string representing `Message[]` (Section 5).
   - **Canonical String:** Newline-delimited payload:
     ```text
     openchannel:v1
     push
     <ref>
     <ts>
     <nonce>
     <rawBody>
     ```
   - **Signature Calculation:**
     $$\text{signature} = \text{HMAC-SHA256}_{key}(\text{canonicalString}).\text{hex}()$$
3. **HTTP Transport Headers:**
   - Outbound requests attach:
     - `X-Bridge-Timestamp: <ts>`
     - `X-Bridge-Nonce: <nonce>`
     - `X-Bridge-Signature: <signature>`
     - `Content-Type: application/json`
4. **Anti-Replay Validation Contract:**
   - Requests with $| \text{now}() - ts | > 300\text{s}$ (5 minutes) are rejected with `401 Unauthorized` (Timestamp Expired).
   - Nonces are tracked in a 10-minute sliding window memory cache. Re-used nonces are rejected with `409 Conflict` (Replay Detected).
5. **Batch Delivery Response Contract:**
   - Margince responds with HTTP 200 and an ordered results array:
     ```json
     {
       "results": [
         { "id": "whatsapp:rep:native123", "status": "accepted" },
         { "id": "whatsapp:rep:native124", "status": "duplicate" },
         { "id": "whatsapp:rep:native125", "status": "refused", "reason": "Recipient phone blocked in CRM" }
       ]
     }
     ```
   - `accepted` and `duplicate` are treated as successful deliveries. `refused` items are marked failed with the plain-language reason.
6. **Local Mock Margince Server (`src/mock-server/marginceMock.ts`):**
   - Implements an embedded Node.js HTTP server running on `127.0.0.1:<mock_port>`.
   - Validates HMAC signatures, enforces replay windows, evaluates Margince rate limits (60 req/min per IP), and records received batches.
   - Provides test inspection APIs (`GET /_mock/received`, `POST /_mock/reset`, `POST /_mock/simulate-rate-limit`).
   - A single contract test suite (`test/contract/margince-contract.test.ts`) executes against both the Mock Server and Tam Vu's live staging endpoint.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Bearer Token | Option 2: Canonical HMAC + Mock Server (Selected) | Option 3: OAuth 2.0 Client Credentials |
| :--- | :--- | :--- | :--- |
| **Replay Defense (Sec. 13)** | **None.** Captured requests can be replayed repeatedly. | **Guaranteed.** 300s timestamp window + unique per-request nonce cache. | Token expiration mitigates, but doesn't prevent same-token replay. |
| **Spec Conformance (Sec. 8)** | Fails spec requirements. | **100% Conforming.** Exact implementation of Tam Vu's openchannel PR. | Adds unnecessary OAuth token negotiation endpoints. |
| **Offline Testing (Sec. 14)** | Requires manual mocks. | **High Fidelity.** Embedded mock server satisfies identical contract tests. | Requires complex local OAuth identity provider mock. |
| **Rep Setup UX (Feature K-4)** | Multiple fields to enter. | **1-Click Paste.** Single `margince://` connection URI. | Requires Client ID, Secret, and Token URL. |
| **Performance Overhead** | Zero. | **Negligible.** Fast hardware-accelerated SHA256 (<0.1ms per batch). | High (token refresh latency). |

---

## 4. Consequences and Mitigations

* **System Clock Drift:**
  * *Trade-off:* If the sales rep's computer clock drifts by more than 5 minutes, HMAC verification fails with `Timestamp Expired`.
  * *Mitigation:* When Margince rejects with timestamp skew, its response headers include `Date: <server_time>`. The engine detects the skew, records the delta offset, and automatically adjusts timestamps on subsequent requests.
* **Payload Serialization Variance:**
  * *Trade-off:* Re-serializing JSON can alter whitespace or key order, corrupting the HMAC signature.
  * *Mitigation:* The engine serializes the message batch to a JSON string **once**; that exact string is used to compute the HMAC and passed directly to the HTTP request stream.

