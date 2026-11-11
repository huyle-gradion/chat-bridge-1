# ADR 0005: Outbox Multi-Queue Worker, Pacing & Pipelining

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 4, 6, 7 [C-3, C-5, K-0], 8, 11)

---

## 1. Context and Problem Statement

Feature **C-3**, **C-5**, and **K-0** in `docs/spec.md` require:
1. **Multi-Sink Independence:** A sales rep can activate multiple destinations simultaneously (Margince, Google Sheets, Local SQLite DB, Daily Archive JSONL). Each sink must operate on an independent outbox queue: a degraded, slow, or offline sink must never block or delay delivery to any other active sink.
2. **Pacing and Rate Limiting:** Outbound calls must strictly respect each provider's quotas (Margince: 60 requests/minute per IP, 120 per endpoint; Google Sheets: 60 write requests/minute per user). On HTTP 429 ("slow down") or network disconnections, deliveries must pause and back off automatically.
3. **Crash & Power Loss Safety:** Sudden laptop lid closes, system restarts, or app crashes must result in zero message loss. Queued deliveries must safely resume upon startup.
4. **Permanent vs. Transient Failures:** Messages rejected permanently (`refused`, invalid schema, or unauthorized credentials) must not be retried infinitely; their failure reason must be recorded in plain language for the user.
5. **Resource Budgets:** Idle CPU must remain `< 2%` of one core, and 2-hour continuous test runs must demonstrate `< 10%` memory growth with zero unbounded queue leaks ([Section 11](../spec.md#L301-L309)).

We evaluated three architectural approaches:
1. **Option 1 (Polling Interval Timers per Sink):** Each sink executes an independent `setInterval` timer polling SQLite every 500–1000ms.
2. **Option 2 (Reactive Event-Driven Workers + Token Bucket Pacing):** Sinks sleep when queues are empty, waking up reactively on message ingestion or scheduled retry timers, with rate limiting governed by a Token Bucket algorithm.
3. **Option 3 (Single Synchronous Dispatch Loop):** A single sequential dispatcher loop iterating through active sinks one by one.

---

## 2. Decision

We choose **Option 2: Reactive Event-Driven Workers + Token Bucket Pacing with Coordinated SQLite WAL Transactions**:

1. **Reactive Dispatching & Zero-CPU Idle State:**
   - When a normalized message passes filters and enters the outbox, the engine executes a single atomic write transaction creating the message record in `messages` and creating pending rows in `sink_deliveries` for each active sink.
   - The engine emits an internal in-process event (`outbox:queued`).
   - If a sink's worker is currently idle (sleeping), this event immediately wakes it up to process the new batch.
   - When the queue is empty or waiting for rate tokens / retry timers, workers sleep. No polling loops run, achieving `< 0.1%` idle CPU.
2. **Independent `SinkWorker` Instances:**
   - Every active sink runs an isolated `SinkWorker` state machine.
   - Sink workers maintain their own in-memory delivery queue, token bucket, and error tracking.
   - Sinks never wait for or interact with other sinks.
3. **Token Bucket Rate Limiting:**
   - Each sink worker is configured with a Token Bucket rate limiter based on its provider contract:
     - **Margince:** Capacity $C = 10$, refill rate $R = 1.0 \text{ token/s}$ (60 requests/min).
     - **Google Sheets:** Capacity $C = 5$, refill rate $R = 1.0 \text{ token/s}$ (60 write requests/min).
     - **Local Database & Archive:** High capacity ($C = 500$, $R = 500 \text{ token/s}$) for instantaneous disk commits.
   - When burst traffic arrives, up to $C$ batches can flush immediately; subsequent batches are paced at the steady rate $R$.
   - When tokens are exhausted, the worker calculates the exact delay until the next token refills and schedules a single `setTimeout` wake-up.
4. **Batch Delivery & Atomic State Transitions:**
   - Workers query pending deliveries up to the sink's configured `batchSize` (e.g., 50–100 messages for Margince and Google Sheets).
   - The worker invokes `sink.deliver(batch)`.
   - Results are processed per message:
     - `accepted` or `duplicate`: Delivery marked as completed.
     - `refused`: Delivery marked as `refused`, storing the plain-language failure reason; no retries are scheduled.
     - Network failure / 429 / 5xx: Delivery marked as `pending` with an incremented attempt count and a recalculated `next_retry_at`.
   - Status updates are committed in a single fast SQLite write transaction per batch.
5. **Jittered Exponential Backoff:**
   - For transient network errors and HTTP 429, retry delay is calculated as:
     $$t_{\text{wait}} = \min(t_{\text{max}}, t_{\text{base}} \times 2^{\text{attempts}}) \times (1 + \text{random}() \times 0.2)$$
     where $t_{\text{base}} = 2\text{s}$, $t_{\text{max}} = 300\text{s}$ (5 minutes), and full jitter prevents thundering-herd retry storms upon network reconnection.
6. **Graceful Shutdown & Resume:**
   - On process termination (SIGINT, SIGTERM, app exit), workers finish their in-flight delivery batches, persist state, and close SQLite handles cleanly within a 3-second grace period.
   - On startup, workers query for any `pending` deliveries where `next_retry_at <= now()` and immediately resume queue processing.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Polling Interval Timers | Option 2: Reactive Workers + Token Bucket (Selected) | Option 3: Single Synchronous Dispatcher |
| :--- | :--- | :--- | :--- |
| **Idle CPU Budget (< 2%)** | **Violated.** Constant periodic database polling wastes CPU cycles and battery. | **Optimal (<0.1%).** Completely event-driven; zero CPU consumption when queues are empty. | Low, but subject to thread stalls. |
| **Queue Isolation** | Good, but independent uncoordinated polling risks SQLite write lock contention. | **Total Isolation.** Sinks process at independent rates; slow or dead sinks have zero impact on healthy sinks. | **Violated.** A slow or failing sink stalls all other sinks in the loop. |
| **Pacing & Burst Control** | Crude intervals; prone to burst boundary violations and HTTP 429 rate bans. | **Accurate.** Token Bucket permits controlled burst digestion while guaranteeing compliance with provider per-minute quotas. | Poor. Throttling one sink slows down all sinks. |
| **Crash & Resume Safety** | Good (SQLite persistence). | **Crash-Proof.** State held in WAL-mode SQLite; resumes seamlessly after app restart or sleep. | Good. |
| **Implementation Complexity** | Low. | **Moderate & Maintainable.** Isolated worker classes, single event emitter, zero external message broker dependencies. | Low, but fundamentally architecturally flawed for multi-sink requirements. |

---

## 4. Consequences and Mitigations

* **SQLite Concurrent Write Serialization:**
  * *Trade-off:* Multiple workers attempting to update delivery status simultaneously can experience `SQLITE_BUSY` contention.
  * *Mitigation:* `better-sqlite3` is configured with `timeout: 5000` (busy timeout). In addition, writes are batched (one update transaction per batch of 50–100 messages), keeping write transaction durations under 5 milliseconds.
* **System Sleep & Laptop Lid Closes:**
  * *Trade-off:* When a laptop is closed, timers pause, and upon wake-up, system wall-clock time jumps ahead.
  * *Mitigation:* The engine registers system resume listeners (via Electron `powerMonitor.on('resume')` in desktop, or periodic time-jump detection in CLI). Upon resume, all workers recalculate token buckets and immediately trigger a queue check.
* **Long-Running Memory Stability:**
  * *Trade-off:* High message backlogs could accumulate memory if in-flight batches are held in memory.
  * *Mitigation:* In-memory queues only hold message IDs and metadata; payload bodies are queried and decrypted on-demand during batch assembly and garbage-collected immediately following delivery acknowledgment, ensuring compliance with the `< 10%` memory growth rule.

