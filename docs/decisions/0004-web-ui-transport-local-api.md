# ADR 0004: Web UI Transport & Local API Protocol: Embedded HTTP with Server-Sent Events

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 4, 7 [I-1, I-2, I-4, I-5, C-1, C-7, C-9, S-2, S-3], 9, 10, 11)

---

## 1. Context and Problem Statement

Chat Bridge operates with two frontend deployment surfaces driven by a single unified engine:
1. **Desktop Shell (Feature I-5):** Electron desktop window displaying the Setup Wizard and UI.
2. **CLI Browser Mode (Feature I-2, Section 9):** Developers and testers running `chat-bridge ui`, which serves the web interface directly to their system browser.

Both operational modes require:
- **Interactive Commands:** Picking chats ([C-8](../spec.md#L173)), toggling filters ([C-2](../spec.md#L170)), configuring/testing sinks ([K-0](../spec.md#L191)), initiating manual message sends.
- **Real-Time Event Streaming:** Streaming dynamic QR codes for Zalo and WhatsApp logins ([S-2](../spec.md#L184), [S-3](../spec.md#L185)), live feed updates as messages arrive ([C-1](../spec.md#L169)), real-time import progress counters ([S-3](../spec.md#L185)), and engine health telemetry ([C-9](../spec.md#L177)).

### Security & Resource Constraints
- **Strict Privacy & Anti-Snooping:** The web server must listen strictly on `localhost` (`127.0.0.1`). Because the bridge processes private chat conversations and contact data, an unauthenticated local HTTP port would expose the rep to Cross-Site Request Forgery (CSRF) and DNS rebinding attacks from arbitrary web pages running in the rep's browser.
- **Resource Budget:** Idle CPU must remain `< 2%` of one core, and idle memory `< 250 MB` RSS ([Section 11](../spec.md#L301-L309)). Constant polling for UI state destroys the CPU budget.

We evaluated three architectural approaches:
1. **Option 1 (Electron IPC + Separate CLI Web Server):** Use native Electron `ipcRenderer`/`ipcMain` in Desktop, and build a secondary HTTP server for `chat-bridge ui`.
2. **Option 2 (Unified Embedded HTTP + Server-Sent Events with Loopback Token Auth):** Single embedded HTTP server for both desktop and CLI, using standard REST for mutations and Server-Sent Events (SSE) for unidirectional real-time data push.
3. **Option 3 (Embedded HTTP + Full-Duplex WebSockets):** Bidirectional WebSocket connection (`ws`) handling all client-server communication.

---

## 2. Decision

We choose **Option 2: Unified Embedded HTTP Server + Server-Sent Events (SSE) secured with ephemeral Loopback Token Authentication**:

1. **Unified Server Architecture:**
   - The engine embeds a lightweight HTTP service (using a lean framework such as `Hono` over Node's native `node:http`) bound strictly to `127.0.0.1`.
   - Both the Electron desktop renderer and external system browsers (`chat-bridge ui`) interact with the exact same HTTP/SSE endpoints. Zero code branching between desktop and browser frontends.
2. **Ephemeral Loopback Token Security (Anti-CSRF & DNS Rebinding Guard):**
   - At engine launch, a cryptographically secure 256-bit random session token is generated in memory (`crypto.randomBytes(32).toString('hex')`).
   - The token is never written to disk or transmitted unencrypted.
   - When launching the UI (or opening the browser via CLI `chat-bridge ui`), the token is passed via URL hash fragment:  
     `http://127.0.0.1:<port>/#token=<session_token>`
   - The URL hash fragment is processed exclusively by client-side JavaScript and is never sent in HTTP request headers or server logs.
   - All REST requests (`POST`, `PUT`, `DELETE`, authenticated `GET`) and the SSE connection require an `Authorization: Bearer <session_token>` header or `X-Chat-Bridge-Token` custom header.
   - Any request missing a valid token, having a non-loopback `Host` header, or with an untrusted `Origin` header is rejected immediately with `403 Forbidden`.
3. **Event Streaming via Server-Sent Events (`GET /api/events`):**
   - Real-time updates (QR codes, message arrivals, outbox queue counts, app health metrics, warning banners) are streamed unidirectionally over a single persistent SSE connection (`text/event-stream`).
   - The browser native `EventSource` (or standard `fetch` stream reader) handles automatic reconnection without external libraries.
4. **Commands & Mutations via REST:**
   - Standard JSON REST endpoints handle idempotent operations and queries (e.g., `GET /api/status`, `POST /api/chats/pick`, `POST /api/filters/block`, `POST /api/sinks/test`).

---

## 3. Rationale and Comparison

| Evaluation Metric | Option 1: Electron IPC + CLI Server | Option 2: Embedded HTTP + SSE (Selected) | Option 3: Embedded HTTP + WebSockets |
| :--- | :--- | :--- | :--- |
| **Code Unification** | **Poor.** Dual API implementation: Electron IPC handlers vs CLI HTTP routes. | **100% Unified.** Identical client bundle, routes, and validation in desktop and browser. | **100% Unified.** Single WebSocket protocol for desktop and browser. |
| **Security & Privacy** | IPC is isolated, but CLI HTTP port remains an open attack surface without custom auth. | **Robust.** Ephemeral loopback token + strict Origin/Host checks completely neutralizes CSRF and DNS rebinding. | Requires custom ticket-based handshake during HTTP-to-WS upgrade. |
| **Real-Time Efficiency** | Native IPC events. | **High.** Lightweight text stream, zero polling, standard HTTP/1.1 or HTTP/2 transport. | Frame overhead, ping/pong keepalive state machine. |
| **Idle CPU Overhead** | Low. | **Near-zero (<0.2% CPU).** Native Node streams sleeping on event loop until events fire. | Slight connection keep-alive overhead. |
| **Client Complexity** | High. Frontend must check runtime environment (`window.electron` vs `window.fetch`). | **Minimal.** Native browser `fetch` and `EventSource` with zero third-party client dependencies. | Requires client WebSocket management and reconnect backoff logic. |

---

## 4. Consequences and Mitigations

* **Dynamic Port Allocation & Conflict Handling:**
  * *Trade-off:* Fixed port numbers (e.g. 3901) can conflict with other local development servers or multiple running instances.
  * *Mitigation:* The engine attempts to bind to default port `3901`. If occupied, it automatically binds to port `0` (system-assigned ephemeral port). The Electron shell or CLI launcher reads the assigned port and opens `http://127.0.0.1:<assigned_port>/#token=<token>`.
* **Token Exposure via Browser History:**
  * *Trade-off:* Tokens in URL fragments might persist in the local browser history.
  * *Mitigation:* Upon initialization, the frontend script extracts `window.location.hash`, stores the token in memory (`sessionStorage` or local closure), and immediately strips the hash from the address bar via `history.replaceState(null, '', window.location.pathname)`.
* **SSE Disconnections & Background Tab Throttling:**
  * *Trade-off:* Browsers may throttle background tab timers or close idle HTTP connections.
  * *Mitigation:* The SSE endpoint emits a periodic heartbeat comment (`: ping\n\n`) every 15 seconds. If disconnected, the frontend client automatically reconnects and performs a quick reconciliation `GET /api/status` to catch up on any missed state transitions.

