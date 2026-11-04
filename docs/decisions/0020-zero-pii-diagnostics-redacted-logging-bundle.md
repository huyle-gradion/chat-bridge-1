# ADR 0020: Zero-PII Diagnostics, Redacted Logging & One-Click Diagnostic Bundle Architecture

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 2, 7 [Features C-1, C-9], 11, 14), `docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md`, `docs/decisions/0019-application-configuration-store-secrets-segregation.md`

---

## 1. Context and Problem Statement

When non-technical sales representatives experience runtime anomalies—such as connector disconnections, OAuth token expirations, HTTP 429 rate pacing, or network timeouts—support engineers require diagnostic telemetry to troubleshoot root causes ([Features C-1, C-9](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L168-L178)).

However, chat integration software operates under severe privacy and operational constraints:
1. **Strict Zero-PII Mandate ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L341-L349)):**  
   *"No real chat data in the repo: no real phone numbers, names or messages in test data, screenshots, issues or logs."*
2. **Zero External Tracking ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L294)):**  
   *"No tracking. Only messages that pass the filters leave, and only to sinks the rep added."*
3. **Resource & Memory Budgets ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L305-L308)):**  
   The application must stay below 250 MB idle RSS and experience under 10% memory growth over 2-hour runs. Continuous, unconstrained disk logging leads to disk exhaustion and high I/O latency.
4. **Non-Technical Usability ([Section 2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L55)):**  
   A sales representative cannot be asked to manually search through hidden system directories (`~/Library/Logs` or `%APPDATA%`), nor can they be expected to manually scrub customer phone numbers or confidential messages from text logs before submitting a support request.

We evaluated three architectural approaches:
1. **Option 1: Standard File Logging (Winston / Pino) with Ad-hoc String Replacement.**
2. **Option 2 (Accepted): Zero-PII Streaming Redactor, Bounded In-Memory Ring Buffer & Sanitized Diagnostic Bundle.**
3. **Option 3: External Telemetry & Crash Reporting SaaS (Sentry / Datadog).**

---

## 2. Decision

We choose **Option 2: Zero-PII Streaming Redactor, Bounded In-Memory Ring Buffer & Sanitized Diagnostic Bundle**:

```
 [ Subsystems: Engine / Sources / Sinks / Outbox ]
                         |
                         | (structured log event)
                         v
          [ Streaming PII Redactor Pipeline ]
          - Salted SHA-256 phone pseudonymizer ([PHONE:a8f9b2])
          - Message body stripper ([REDACTED_TEXT: 48 chars])
          - Secret/Token scanner (HMAC secrets, Bearer tokens, cookies)
          - Contact display name pseudonymizer ([USER:4c2d])
                         |
                         v (sanitized JSON record)
          [ Bounded In-Memory Ring Buffer ]
          - Fixed capacity: 2,000 entries (~2 MB RAM)
          - Zero steady-state disk I/O writes
          - Circular FIFO eviction
                         |
          +--------------+--------------+
          |                             |
          v (User clicks "Export Logs"  v (Fatal Uncaught Exception)
             or runs CLI command)
  [ Diagnostic Bundle Generator ]  [ Crash Snapshot Generator ]
  - Generates single .zip file     - Writes emergency minidump to
  - Combines:                        crash-snapshot.json
    * sanitized-logs.jsonl         - Sanitized telemetry only
    * health-snapshot.json         - Plain-language recovery dialog
    * settings-sanitized.json
    * environment-summary.json
```

### Technical Specification

#### 1. Streaming Redactor Pipeline (`packages/core/diagnostics`)
Every log statement passes through a synchronous redaction pipeline before entering any buffer:
1. **Phone Number Pseudonymization:** Matches E.164 and local Vietnamese/international phone patterns (`/(?:\+?\d{9,15})/g`). Replaces matches with a deterministic, session-salted pseudonym: `[PHONE:${sha256(phone + sessionSalt).slice(0, 8)}]`. This preserves the ability to correlate an issue with a specific sender across multiple log entries without revealing the phone number.
2. **Chat Message Text Stripping:** Inspects any field representing chat content (e.g. `text`, `caption`, `messageBody`). Replaces the string with a descriptor preserving length and character flags only: `[REDACTED_TEXT: ${text.length} chars, truncated=${truncated}]`. Raw message characters are immediately discarded.
3. **Credentials & Token Scrubbing:** Automatically scrubs known sensitive keys (`secret`, `token`, `password`, `key`, `authorization`, `cookie`, `signature`). Replaces values with `[REDACTED_SECRET]`.
4. **Display Name Masking:** Account and sender display names are replaced with `[USER:${sha256(name + sessionSalt).slice(0, 6)}]`.

#### 2. Bounded In-Memory Ring Buffer
- Retains up to 2,000 recent structured log entries in memory as an array-backed circular buffer.
- Memory consumption is strictly bounded ($\approx$ 2 MB RAM), safely fitting within the 250 MB idle RSS budget ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L305)).
- Avoids continuous background disk writing, protecting SSDs and preventing disk fill issues on sales reps' laptops.

#### 3. One-Click Diagnostic Bundle Export
Available via the UI ("Settings $\to$ App Health $\to$ Export Diagnostics") and CLI (`chat-bridge status --diagnostics`):
1. **Generates a timestamped archive:** `chat-bridge-diagnostics-YYYY-MM-DD-HHmmss.zip`.
2. **Contents:**
   - `logs.jsonl`: Formatted snapshot of the 2,000 redacted in-memory log entries.
   - `telemetry.json`: Telemetry sampler metrics from [ADR 0013](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md) (CPU 5-minute average, RSS memory, per-sink queue sizes, error rates).
   - `settings-sanitized.json`: Copy of `settings.json` with picked chat IDs and blocked contacts pseudonymized using the same session salt.
   - `system.json`: OS version, CPU architecture, Electron/Node version, bridge version, and uptime.
3. **Pre-Export Audit Linter:** An automated self-test runs across the generated zip bytes before saving, scanning for raw phone numbers, credit card patterns, or unmasked secrets. If any pattern is detected, the export is aborted with an error, preventing accidental leakage.

#### 4. Automated Redaction Test Guard (CI & TDD)
Located in `packages/core/test/diagnostics-redactor.test.ts`:
- Injects synthetic scenarios containing real-looking phone numbers (`+84912345678`), OTP codes (`123456`), confidential text snippets (`"Customer agreed to buy 5 units for $10,000"`), and Bearer tokens.
- Asserts that zero raw substrings survive in the log buffer or exported bundle.

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1: File Logging (Winston / Pino) | Option 2: Streaming Redactor + Ring Buffer (Accepted) | Option 3: Third-Party APM (Sentry) |
| :--- | :--- | :--- | :--- |
| **Privacy & Zero-PII Compliance** | **Poor.** High probability of unhandled object leaks, stack trace leaks, or connector debug dumps containing raw PII. | **Guaranteed.** Synchronous streaming redactor strips text, masks phones with salted hashes, and audits exports before disk write. | **Non-Compliant.** Spec forbids third-party tracking; sends telemetry over the Internet to external SaaS. |
| **Resource Efficiency** | Unbounded disk growth; requires complex file rotation and log cleanup daemons. | **Bounded (~2 MB RAM).** Zero disk writes during normal operation; instant export on demand. | Background telemetry network daemon increases idle battery and CPU consumption. |
| **User Experience (Support)** | Rep must locate obscure hidden log folders and manually redact customer data before emailing. | **One-Click Plain UX.** Dedicated UI button exports a pre-sanitized zip ready to share. | Requires complex enterprise dashboard setup. |
| **Offline & CI Verification** | Non-deterministic file writes in CI. | Fully verifiable in offline CI via deterministic fuzzing tests. | Requires cloud credentials to test. |

---

## 4. Consequences and Mitigations

* **Loss of Historical Logs Prior to 2,000 Entries:** In-memory ring buffer evicts older entries during high-throughput backfill runs.  
  * *Mitigation:* The 2,000-entry capacity is tuned to capture at least 30 minutes of typical activity. Furthermore, persistent error counts and rate-limiting metrics are permanently tracked in the telemetry sampler ([ADR 0013](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md)).
* **Crash Snapshot on Hard Segfault:** A hard C++ native crash (e.g. native SQLite segfault) might terminate the process before the ring buffer can be dumped.  
  * *Mitigation:* Electron's crash reporter is configured to dump minidumps without heap memory to local disk, and Node's `process.on('uncaughtException')` catches JavaScript errors and synchronously writes `crash-snapshot.json` before exiting.

