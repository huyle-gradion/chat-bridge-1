# ADR 0018: End-to-End TDD Test Harness, Synthetic Scenario Engine & Contract Test Suite

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 3, 6, 7 [Feature S-1], 8, 11, 13, 14), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Sections 8, 11, 13, and 14 of `docs/spec.md` establish rigorous engineering quality, privacy, and verification mandates:
1. **Strict AI & Privacy Sandbox Invariants ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L341-L358)):**
   - The AI agent **NEVER** holds a chat login, session token, or password.
   - The AI agent develops and tests **exclusively** against the `Fake` source and the `Mock Margince` server.
   - **Zero PII in repo:** No real phone numbers, real names, or real customer messages in test fixtures, mocks, or logs.
2. **Test-Driven Development (TDD) Mandate ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L352)):**
   - Unit and integration tests must be written first (Red), verified to fail, then followed by minimal implementation to pass (Green).
3. **Contract Parity ([Section 8](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L244)):**
   - *"The mock Margince server and the real one must pass the same contract tests."*
   - Any source or sink provider must strictly satisfy the behavioral contracts of `SourceContract` and `SinkContract` ([Section 6](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L121-L158)).
4. **Acceptance Invariants ([Section 13](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L326-L340)):**
   - Automated proof for all 12 final acceptance criteria: multi-sink independent queue isolation, down-sink recovery, crash durability, OTP/group/contact filtering, LID-to-phone mapping, and 500-message pacing under budget.
5. **The Fragile Mocking Trap:** Without a standardized testing package, integration tests across sources, engines, and sinks suffer from static fixture drift, inconsistent mocking of protocol edge cases (e.g. 40k chars, OTPs, reactions), and brittle network dependencies.

We evaluated three testing architectures:
1. **Option 1: Ad-hoc Vitest Mocks & Scattered Static JSON Fixtures.**
2. **Option 2: Unified Testing Framework (`packages/testing`): Synthetic Scenario Engine, Parameterized Contract Runner & Offline Playwright Harness.**
3. **Option 3: Containerized Docker-Compose Integration Environment.**

---

## 2. Decision

We choose **Option 2: Unified Testing Framework (`packages/testing`) with Synthetic Scenario Engine, Parameterized Contract Runner & Offline Playwright Harness**:

```
                       [ packages/testing ]
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
  [ Synthetic Scenario     [ Parameterized Contract   [ Fault-Injection &
        Engine ]                 Runners ]             Durability Harness ]
  - Deterministic seeds    - describeSourceContract   - Network drops & 429s
  - Realistic edge cases:  - describeSinkContract     - Abrupt crash & recovery
    * 40k char cutoff      - Guarantees 100% parity     (zero message loss)
    * OTP detection          between Mock Margince
    * Media placeholders     and Real Margince
    * LID vs Phone maps
         |                       |                       |
         +-----------------------+-----------------------+
                                 |
                                 v
            [ Hermetic Offline Playwright E2E Runner ]
            - Drives complete UI wizard (Charlotte beta flow)
            - 100% localhost; zero external network access
            - Sub-second unit loops & deterministic CI runs
```

### Technical Specification

#### 1. Synthetic Scenario Engine (`ScenarioBuilder`)
Located in `packages/testing/src/scenarios/`, the `ScenarioBuilder` provides a fluent, programmatic API to generate deterministic, reproducible message streams:
- **Seed-Based Determinism:** Every test scenario accepts an optional integer seed for 100% reproducible test runs.
- **Edge-Case Injectors:**
  - `withLongText(length: 40000)`: Tests the 32,768-character truncation rule and `truncated: true` flag ([Section 5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L118)).
  - `withOtpCode(pattern)`: Injects realistic 6-digit OTP verification codes to verify privacy filter dropping ([C-2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L170)).
  - `withNoise(kind)`: Injects reactions, stories (`status@broadcast`), edits, and typing notifications to verify drop filters ([C-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L172)).
  - `withLidMapping(phone, lid)`: Generates WhatsApp linked identity pairings to verify singular person resolution ([C-6](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L175)).
  - `withMedia(filename, size)`: Generates media events to verify placeholder extraction (e.g. `[image: invoice.jpg, 1.2 MB]`) ([Section 3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L76)).

#### 2. Parameterized Contract Test Suite
Located in `packages/testing/src/contracts/`, these reusable test suites validate that any provider strictly conforms to the engine interface:

1. **`describeSourceContract(name, factory)`:**
   - Tests lifecycle: `start(onMessage)`, `stop()`, idempotency of repeated starts/stops.
   - Tests session status: `status()` transitions (`connected`, `needs-login`, `taken-over`, `error`).
   - Tests chat discovery: `chats()` formatting, thread kinds, pagination.
   - Tests send safety: `send(thread, text)` validates input and returns delivery confirmations.
2. **`describeSinkContract(name, factory)`:**
   - Tests configuration & test: `configure(settings)`, `test()` with valid and invalid credentials.
   - Tests batch delivery: `deliver(batch)` results mapping (`accepted`, `duplicate`, `refused`).
   - Tests rate limits and backoff: Respects declared `limits`, handles HTTP 429 / retry headers without unhandled rejections.
   - Tests health reporting: `health()` returns `ok`, `degraded`, or `down`.

> [!IMPORTANT]
> **Mock vs Real Parity:** Both `packages/sinks/margince` (tested against `packages/testing/src/mocks/margince-server.ts`) and any staging Margince server run the **exact same** `describeSinkContract('MarginceSink', ...)` suite, guaranteeing 100% protocol adherence.

#### 3. Fault-Injection & Durability Harness
Located in `packages/testing/src/harness/fault-injection.ts`:
- **Simulated Failures:** Injects network timeouts, HTTP 500/503 errors, and token exhaustion into active sinks.
- **Queue Isolation Verification:** Injects persistent failures into Sink A (e.g. Margince down) while Sink B (Local DB) and Sink C (Sheets) remain healthy; asserts Sink B and C deliver continuously without blocking, while Sink A accumulates waiting messages in the encrypted outbox.
- **Process Crash Recovery (`simulateCrash()`):** Simulates abrupt termination of the engine process, restarts it, and asserts that every message in the outbox is recovered and delivered **exactly once** when connectivity returns ([Section 13](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L335)).

#### 4. Hermetic Playwright E2E Suite
Located in `packages/testing/src/e2e/`:
- Bundles end-to-end user journeys executed against the Vite frontend served over loopback.
- **Charlotte Nguyen Usability Suite:** Simulates the complete 15-minute onboarding flow:
  1. Opens setup wizard ([Feature I-4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L203)).
  2. Connects WhatsApp and Zalo via fake QR codes.
  3. Ticks one chat in the Chat Picker.
  4. Configures Margince connection string (pointing to local mock server).
  5. Verifies messages appear in mock Margince timeline.
- **Zero Internet Requirement:** Executes entirely in headless Chromium offline in CI, completing the full acceptance checklist in under 10 seconds.

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1: Ad-hoc Vitest Mocks | Option 2: Unified Testing Framework (Accepted) | Option 3: Docker-Compose Harness |
| :--- | :--- | :--- | :--- |
| **Execution Velocity (TDD Inner Loop)** |  Fast (<1s), but brittle |  Sub-second Vitest runs; instant feedback | ❌ Slow (>30s container boot overhead) |
| **Contract Parity (Mock vs Real)** | ❌ Fragile drift across mocks |  Shared parameterized suites enforce 100% contract parity |  Good, but heavy maintenance |
| **Zero-PII & Privacy Security** | ⚠️ Risk of dev data leakage |  Guaranteed: 100% synthetic, deterministic data |  Good |
| **Crash & Fault Simulation** | ❌ Cannot simulate OS crashes cleanly |  Programmatic WAL crash & restart assertion | ⚠️ Requires container kill orchestration |
| **Offline CI Execution** |  Fully offline |  100% hermetic & offline; zero network dependencies | ❌ Docker daemon required |

---

## 4. Consequences and Mitigations

* **Trade-off 1: Synthetic data may miss unknown upstream protocol quirks in `zca-js` or `baileys`.**
  * *Mitigation:* When a human developer discovers a new edge case during manual testing with personal accounts, they record the synthetic schema into `ScenarioBuilder` (without real PII), creating a permanent regression test.
* **Trade-off 2: Playwright browser downloads in CI.**
  * *Mitigation:* Cache Playwright browser binaries in CI actions; unit and contract tests in `packages/testing` run under pure Vitest Node environments and do not require browser binaries.
* **Trade-off 3: Code duplication across package tests.**
  * *Mitigation:* Contract tests are exported directly as helper functions from `@chat-bridge/testing`, allowing any new source or sink package to instantiate full test coverage in 5 lines of code.

