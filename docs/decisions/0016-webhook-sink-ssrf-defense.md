# ADR 0016: Webhook Sink Architecture & SSRF Defense

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 3, 6, 7 [Feature K-2], 11, 16), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Sections 3 and 7 of `docs/spec.md` define the Webhook Sink as part of the "Should" scope:
1. **Feature K-2 Definition ([Section 7](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L215)):** *"Sends signed batches of messages as JSON to a URL the rep gives."*
2. **Sink Contract Alignment ([Section 6](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L149-L158)):** The Webhook provider must implement `SinkContract` (`configure(settings)`, `test()`, `deliver(batch)`, `health()`, and declare rate/batch `limits`).
3. **The Security Threat — Server-Side Request Forgery (SSRF) and DNS Rebinding:**
   - Chat Bridge runs locally on the user's desktop computer within corporate or residential intranets.
   - Allowing users to enter an arbitrary HTTP target URL opens critical vulnerabilities if not guarded:
     - **Private Intranet Probing:** Accessing RFC 1918 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), local router admin portals (`http://192.168.1.1`), or local microservices.
     - **Cloud Metadata Harvesting:** Querying link-local cloud metadata services (`http://169.254.169.254/latest/meta-data/`) if the user runs on cloud-hosted remote desktop instances.
     - **Loopback Exploitation:** Hitting local loopback services (`http://127.0.0.1:3000` or `http://localhost:8080`) to bypass local authentication.
     - **Time-of-Check to Time-of-Use (TOCTOU) DNS Rebinding:** An attacker controls a domain that initially resolves to a public IP during the configuration check (`test()`), but short TTL DNS expires and resolves to `127.0.0.1` during actual message batch delivery (`deliver()`).
4. **UX & Plain-Language Guard ([Section 2, 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L55-L57)):** The setup screen ("Where to send") must validate inputs clearly and never expose raw networking jargon like "CIDR", "SSRF", or "SocketException" to the non-technical sales rep.

We evaluated three architectural options:
1. **Option 1: Standard Unchecked HTTP Client with String Regex Validation.**
2. **Option 2: Zero-Trust Webhook Sink with Socket-Level DNS Pre-Resolution, IP Pinning, CIDR Denylist & HMAC-SHA256 Signing.**
3. **Option 3: External Managed Cloud Relay Service.**

---

## 2. Decision

We choose **Option 2: Zero-Trust Webhook Sink with Socket-Level DNS Pre-Resolution, IP Pinning, CIDR Denylist & HMAC-SHA256 Signing**:

```
 [ Outbox Worker Queue: 'webhook' ]
                |
                v (Batch of up to 50 normalized messages)
 [ WebhookSink.deliver(batch) ]
                |
                +---> [ 1. DNS Pre-Resolution & CIDR Denylist Check ]
                |     - Resolves hostname via dns.promises.lookup()
                |     - Validates ALL resolved IPv4/IPv6 addresses against CIDR blocklist
                |     - Denies private, loopback, link-local, and multicast ranges
                |
                +---> [ 2. Socket-Level IP Pinning Agent ]
                |     - Custom http.Agent / https.Agent pins the verified IP
                |     - Overrides lookup callback to guarantee connect() targets verified IP
                |     - Eliminates TOCTOU DNS Rebinding attacks
                |
                +---> [ 3. Payload Serialization & HMAC-SHA256 Signing ]
                |     - Canonical JSON body: { "event": "message.batch", "messages": [...] }
                |     - Headers:
                |         X-ChatBridge-Signature: sha256=<hex>
                |         X-ChatBridge-Timestamp: <ISO-8601>
                |         X-ChatBridge-Delivery: <UUIDv4>
                |
                +---> [ 4. HTTP POST with Strict Timeout & Adaptive Token Bucket ]
                      - 15s connection/response timeout
                      - Evaluates response: 2xx -> 'accepted', 429/5xx -> retry, 4xx -> 'refused'
```

### Detailed Component Specifications

#### 1. CIDR Denylist & Network Boundaries
The Webhook sink immediately rejects any target hostname that resolves to forbidden IP ranges:
- **IPv4 Loopback:** `127.0.0.0/8`
- **IPv4 Private (RFC 1918):** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **IPv4 Link-Local / Cloud Metadata:** `169.254.0.0/16`
- **IPv4 Carrier-Grade NAT (RFC 6598):** `100.64.0.0/10`
- **IPv4 Multicast & Broadcast:** `224.0.0.0/4`, `255.255.255.255/32`
- **IPv4 Zero-address:** `0.0.0.0/8`
- **IPv6 Loopback:** `::1/128`
- **IPv6 Unique Local (RFC 4193):** `fc00::/7`
- **IPv6 Link-Local:** `fe80::/10`
- **IPv6 Unspecified:** `::/128`

> [!IMPORTANT]
> **HTTPS Requirement:** By default, webhook URLs must use the `https://` scheme. Plain `http://` is strictly prohibited unless an explicit development flag (`allowInsecureHttp: true`) is passed in automated CI tests.

#### 2. Anti-DNS-Rebinding Socket Pinning
To defeat TOCTOU attacks where DNS records change between hostname validation and HTTP connection:
- A custom `lookup` function is injected into the Node.js `https.Agent`.
- The resolved and verified IP address is passed directly to the socket connect layer, while preserving the original hostname in the `Host` header and TLS Server Name Indication (SNI) for certificate validation.
- Redirects (`HTTP 301, 302, 307, 308`) are **not followed automatically** by the client library. Any redirect must undergo the complete DNS and CIDR re-validation cycle before a new request is made.

#### 3. Payload Format and Cryptographic Signatures
The webhook delivers messages matching the normalized shape defined in `docs/spec.md` Section 5:

```json
{
  "event": "message.batch",
  "batchId": "b1a2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "timestamp": "2026-11-04T22:45:00.000Z",
  "count": 2,
  "messages": [
    {
      "id": "whatsapp:sales-rep-1:3EB0ABCD1234",
      "network": "whatsapp",
      "account": "sales-rep-1",
      "thread": "84901234567@s.whatsapp.net",
      "threadKind": "dm",
      "direction": "inbound",
      "time": "2026-11-04T22:44:30.000Z",
      "from": {
        "accountId": "84901234567@s.whatsapp.net",
        "displayName": "Customer A",
        "phone": "+84901234567"
      },
      "to": [
        {
          "accountId": "sales-rep-1"
        }
      ],
      "text": "Hello, please send the quote."
    }
  ]
}
```

**Signature Scheme:**
- Header: `X-ChatBridge-Signature: sha256=<hex_digest>`
- Header: `X-ChatBridge-Timestamp: <ISO-8601>`
- Header: `X-ChatBridge-Delivery: <batchId>`
- Calculation: `HMAC-SHA256(secretKey, "${timestamp}.${rawBody}")`
- The user can input their own webhook signing secret or click "Generate Secret" in the UI. Secrets are encrypted at rest using the OS Keystore ([ADR 0002](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0002-outbox-storage-envelope-encryption.md)).

#### 4. Sink Contract Implementation Details
- **`configure(settings)`:** Validates URL schema, checks secret length (min 16 chars).
- **`test()`:** Sends a lightweight verification ping `{ "event": "endpoint.verify" }` to the destination URL. If the server answers with HTTP 2xx within 10 seconds, returns success; otherwise provides a plain-language error message.
- **`limits`:** Default batch size = 50 messages; rate limit = 60 requests/minute.
- **`deliver(batch)`:**
  - HTTP `200/201/204`: All messages marked `accepted`.
  - HTTP `429` (Rate Limited) or `500/502/503/504`: Temporary failure, worker triggers Token Bucket exponential backoff with jitter ([ADR 0005](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0005-outbox-multi-queue-worker-pacing.md)).
  - HTTP `400/401/403/404/422`: Unrecoverable client error; batch marked `refused` with plain-language description and warning logged to UI status banner.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Naive HTTP Client | Option 2: Zero-Trust IP Pinning & HMAC (Accepted) | Option 3: External Cloud Relay |
| :--- | :--- | :--- | :--- |
| **SSRF Defense** | ❌ Vulnerable to TOCTOU rebinding & internal network access |  Deterministic block at socket connection level; zero bypass |  Protected from internal LAN, but introduces relay target abuse |
| **Privacy & Zero-Cloud Invariant** |  Direct from desktop |  Direct from desktop; zero third-party intermediaries | ❌ Payload traverses external third-party infrastructure |
| **Payload Integrity & Authentication** | ⚠️ Unsigned or basic auth only |  HMAC-SHA256 with timestamp replay prevention |  Depends on relay-to-target auth |
| **Deployment Complexity** |  Zero configuration |  Zero extra npm packages (built-in Node `https`, `crypto`, `dns`) | ❌ Requires hosting, managing, and securing a cloud relay service |
| **Plain-Language UX** | ⚠️ Raw networking errors |  Instant, human-friendly errors ("Address not allowed") | ⚠️ Confusing proxy relay errors |

---

## 4. Consequences and Mitigations

* **Trade-off 1: Inability to target local webhook receivers for developer testing (`localhost:3000`).**
  * *Mitigation:* Add an explicit developer configuration toggle in `chat-bridge.config.json` / CLI (`--allow-local-webhooks`) that is strictly disabled by default in the desktop installer UI.
* **Trade-off 2: Strict TLS certificate validation prevents self-signed certificates on staging webhooks.**
  * *Mitigation:* Require valid CA certificates. If internal self-signed certificates are genuinely needed, users must add the root CA to the OS trust store (macOS Keychain / Windows Certificate Manager), which Node's TLS engine naturally honors.
* **Trade-off 3: Custom DNS lookups bypass system-wide VPN split-tunnel configurations if improperly bound.**
  * *Mitigation:* Use standard Node.js `dns.promises.lookup()` (which delegates to `getaddrinfo` system calls) rather than custom DNS resolvers, ensuring all OS-level VPN and enterprise proxy configurations remain completely respected.

