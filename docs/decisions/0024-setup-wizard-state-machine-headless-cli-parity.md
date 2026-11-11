# ADR 0024: Setup Wizard State Machine, Step Recovery & Headless CLI Parity

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 7 [Features I-1, I-4, C-8, C-2, K-0], 9, 10, 11, 13), `docs/decisions/0004-web-ui-transport-local-api.md`, `docs/decisions/0007-frontend-stack-plain-language-guard.md`, `docs/decisions/0019-application-configuration-store-secrets-segregation.md`

---

## 1. Context and Problem Statement

On first launch, Chat Bridge must guide a non-technical sales representative through initial configuration in under 15 minutes with zero terminal interaction, no configuration files, and no technical assistance ([Section 2](../spec.md#L47), [Feature I-4](../spec.md#L203)):
1. **Connect WhatsApp** (QR code or pairing code, can be skipped)
2. **Connect Zalo** (QR code, can be skipped)
3. **Tick chats** (Chat picker; nothing leaves the computer until at least one chat is ticked)
4. **Check filters** (Groups off by default, block contacts, OTP text regex)
5. **Choose where to send** (Margince, Google Sheets, local database; configure credentials and press "Test")

### Key Architectural Challenges & Mandates
1. **CLI and Web UI Strict Parity ([Section 7 Feature I-1](../spec.md#L200)):**
   - *"Every feature ships in the web UI (what the rep sees) and the CLI (what tests and developers use) at the same time."*
   - Headless automated tests ([ADR 0018](0018-testing-harness-scenario-contract-runner.md)) and CLI power users must be able to drive the exact same setup flow via `chat-bridge setup`.
2. **State Recovery & Crash Resilience:**
   - If the sales representative closes the laptop, switches Wi-Fi networks, or encounters a power cut during Step 3 or Step 4, onboarding must resume at the interrupted step without forcing the user to re-scan QR codes or lose selected chats.
3. **Partial Skips & Step Reversibility:**
   - Either WhatsApp or Zalo can be skipped independently.
   - Any completed step must be editable later from the Settings page ([Feature I-4](../spec.md#L203)) using the identical underlying domain logic.

We evaluated three architectural options:
1. **Option 1: Disjoint Client-Side UI State with Independent CLI Commands.**
2. **Option 2 (Accepted): Unified Backend Onboarding State Machine with Persistent Progress in `settings.json` and Headless CLI Adapter.**
3. **Option 3: In-Memory Step Coordinator in Desktop Main Process.**

---

## 2. Decision

We choose **Option 2: Unified Backend Onboarding State Machine with Persistent Progress in `settings.json` and Headless CLI Adapter**:

```
                                  [ First App Launch ]
                                            |
                                            v
                             [ Read settings.json: onboarding ]
                                            |
                         +------------------+------------------+
                         | (completed: true)                   | (completed: false)
                         v                                     v
                  [ Main App UI / Feed ]             [ Route to Current Step ]
                                                               |
    +----------------------------------------------------------+
    |
    v
  [ Step 1: Connect WhatsApp ] --------> (Skip / Connect) --+
    |                                                       |
    v                                                       |
  [ Step 2: Connect Zalo ] ------------> (Skip / Connect) --+
    |                                                       | (Persist Session in
    v                                                       |  sessions.db)
  [ Step 3: Tick Chats ] --------------> (Select >= 1) -----+
    |                                                       | (Save pickedChatIds in
    v                                                       |  settings.json)
  [ Step 4: Check Filters ] -----------> (Verify / Adjust) -+
    |                                                       | (Save filterRules in
    v                                                       |  settings.json)
  [ Step 5: Choose Sinks & Test ] -----> [ Run Sink Tests ] |
    |                                           |           |
    |                                           v           |
    |                                     [ Tests Pass ]    |
    |                                           |           |
    v                                           v           |
  [ Mark onboarding.completed = true ] <--------------------+
    |
    v
  [ Start Outbox Engine Pipeline & Transition to Home Screen ]
```

### Technical Specification

#### 1. Persistent Onboarding State Schema
Located in `packages/core/src/wizard/types.ts` and managed via `SettingsStore` ([ADR 0019](0019-application-configuration-store-secrets-segregation.md)):
```typescript
export type WizardStepId = 
  | 'welcome'
  | 'connect-whatsapp'
  | 'connect-zalo'
  | 'tick-chats'
  | 'check-filters'
  | 'choose-sinks'
  | 'complete';

export interface OnboardingState {
  completed: boolean;
  currentStep: WizardStepId;
  stepStatus: Record<WizardStepId, 'pending' | 'completed' | 'skipped'>;
  updatedAt: string; // ISO 8601 UTC
}
```

#### 2. Backend Wizard State Machine Service (`WizardOrchestrator`)
Located in `packages/core/src/wizard/WizardOrchestrator.ts`:
- **State Transitions:**
  ```typescript
  export class WizardOrchestrator {
    constructor(
      private settings: SettingsStore,
      private sources: SourceManager,
      private sinks: SinkManager,
      private engine: MessagePipeline
    ) {}

    public getStatus(): OnboardingState;
    public async completeStep(step: WizardStepId, data?: unknown): Promise<OnboardingState>;
    public async skipStep(step: WizardStepId): Promise<OnboardingState>;
    public async testSinkConfiguration(sinkType: SinkType, config: SinkConfig): Promise<SinkTestResult>;
    public async finalizeOnboarding(): Promise<void>;
  }
  ```
- **Validation Rules:**
  - `finalizeOnboarding()` enforces that at least one source is connected (or fake source active in development/test), at least one chat is ticked (`pickedChatIds.size > 0`), and at least one sink has passed verification test (`testResult.ok === true`).
  - Upon finalization:
    1. Sets `onboarding.completed = true` in `settings.json`.
    2. Writes atomic file update ([ADR 0019](0019-application-configuration-store-secrets-segregation.md)).
    3. Triggers outbox queue workers and connector message ingestion.

#### 3. Loopback REST & SSE Endpoints
Exposed by the local HTTP server ([ADR 0004](0004-web-ui-transport-local-api.md)):
- `GET /api/v1/wizard/state`: Returns current `OnboardingState`.
- `POST /api/v1/wizard/step/:id/complete`: Commits step payload, updates `settings.json`, returns next step.
- `POST /api/v1/wizard/step/:id/skip`: Marks step `skipped` and advances.
- `POST /api/v1/wizard/sinks/test`: Executes transient sink connectivity test without activating background queues.
- `POST /api/v1/wizard/finish`: Finalizes onboarding and boots the engine.

#### 4. Headless CLI Parity (`chat-bridge setup`)
Located in `packages/cli/src/commands/setup.ts`:
- In interactive terminal mode, `chat-bridge setup` runs an interactive prompt flow using `@clack/prompts`:
  1. Displays plain-language banners for WhatsApp and Zalo connection (renders terminal QR or pairing code).
  2. Renders a multi-select interactive checklist for discovered chats (`[x] Alice, [ ] Bob, [x] Team Sales`).
  3. Displays default filters (Groups: Off, OTP: Enabled).
  4. Prompts for Margince connection string, Sheets authorization, or local database path, running `test()` inline.
- In headless automation mode (e.g., CI or automated tests):
  ```bash
  chat-bridge setup --headless --config fixture-setup.json
  ```
  Applies all step settings synchronously and marks onboarding completed in < 1 second.

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1: Disjoint Client UI State | Option 2 (Accepted): Unified Backend State Machine | Option 3: In-Memory Main Process State |
| :--- | :--- | :--- | :--- |
| **Crash & Reboot Resilience** | **Fails.** Refreshing or closing window loses step progress. | **Guaranteed.** Every step transition is atomically committed to `settings.json`. | Lost if Electron process exits. |
| **CLI & Web Parity (Feature I-1)** | **Broken.** CLI cannot replicate wizard steps cohesively. | **Full Parity.** CLI and UI invoke the exact same `WizardOrchestrator` methods. | High IPC complexity for CLI. |
| **Testing Harness Integration** | Hard to test UI wizard in headless unit tests. | **Trivial.** `WizardOrchestrator` is 100% testable with mock sources and sinks. | Requires spinning up Electron test runners. |
| **Reversibility in Settings** | Wizard components divorced from Settings pages. | **Shared Controllers.** Settings tabs reuse identical validation logic. | High duplication. |

---

## 4. Consequences and Mitigations

* **Trade-off 1:** Slightly higher initial boilerplate defining structured REST endpoints for wizard state.
  * *Mitigation:* Decoupling wizard state from the React DOM allows 100% test coverage in Vitest without browser mocks, speeding up development and preventing onboarding regression bugs.
* **Trade-off 2:** If a user skips both WhatsApp and Zalo, the wizard cannot proceed to Chat Picker.
  * *Mitigation:* The state machine dynamically disables Step 3 (Chat Picker) if 0 sources are connected, displaying a helpful plain-language prompt: *"Please connect at least WhatsApp or Zalo to choose your chats."*

