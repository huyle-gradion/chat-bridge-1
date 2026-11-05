---
name: chat-bridge-dev
description: Workflow, TDD runbook, and architectural standards for building Chat Bridge features, sources, sinks, and outbox pipeline.
---

# Chat Bridge Development & TDD Guide

Use this skill when implementing features, tests, sources, engine pipelines, or sinks in **Chat Bridge**.

---

## 1. Core Architecture & Contracts

Chat Bridge strictly decouples chat ingestion, pipeline processing, and destination delivery:

```
[ Sources ]  --->  (SourceContract)  --->  [ Engine Pipeline ]  --->  (SinkContract)  --->  [ Sinks ]
```

* **Sources (`src/sources/`):** Implement `SourceContract` (`login`, `start`, `stop`, `status`, `chats`, `history`, `send`).
* **Engine Pipeline (`src/engine/`):**
  - Normalizes raw chat events into canonical `Message` format.
  - Drops noise (reactions, edits, stories, newsletters, typing events).
  - Enforces Chat Picker (messages leave computer only if the chat is ticked).
  - Applies Filters (blocked contacts, group filter, OTP text regex).
  - Persists to Outbox: Standard SQLite (`better-sqlite3`, WAL mode) with **AES-256-GCM Envelope Encryption** for payload and PII, keyed from OS Keystore. One independent queue per active sink.
* **Sinks (`src/sinks/`):** Implement `SinkContract` (`configure`, `test`, `deliver`, `health`, `limits`, `pullReplies`, `ack`).

---

## 2. User Story TDD Execution Runbook

Every user story implementation must follow the **5-Step Factory Lifecycle** defined in [`docs/factory-model-setup.md`](../../docs/factory-model-setup.md#operational-runbook-executing-a-user-story-via-the-factory):

1. **Step 1: Story Trigger & Context Loading**
   - Read target story BDD scenarios from [`docs/user-stories.md`](../../docs/user-stories.md) and related ADRs in [`docs/decisions/`](../../docs/decisions/).
2. **Step 2: Red Phase (Test First)**
   - Create or update Vitest suite using `FakeSource`, `ScenarioBuilder`, or `MockMarginceServer`.
   - Run `pnpm test <test-file>` and confirm expected failure (Red).
3. **Step 3: Green Phase & Autonomous Feedback Loop**
   - Implement minimal production code required to satisfy the test.
   - Re-run test suite. Autonomously diagnose stack traces and iterate until all tests pass (Green).
4. **Step 4: Quality Gate Verification**
   - Run `pnpm guard` to enforce:
     * Zero circular dependencies (`guards/no-cycles.ts`).
     * Boundary isolation between Sources, Sinks, and Engine (`guards/contract-boundary.ts`).
     * Zero banned internal jargon in UI strings (`guards/plain-language.ts`).
     * Zero unused exports (`guards/unused-exports.ts`).
5. **Step 5: Definition of Done & Sign-Off**
   - Mark story checkbox done (`- [x]`) in [`docs/user-stories.md`](../../docs/user-stories.md).
   - Present clean diff summary and test evidence for developer review and approval.

---

## 3. Strict Project Rules & Guardrails

* **Privacy & Credentials:**
  - The AI agent **NEVER** holds or requests real chat credentials, session tokens, or QR logins.
  - All automated tests run **exclusively** against synthetic fixtures in `FakeSource` and the `MockMarginceServer`.
  - Zero customer PII or real phone numbers in test data, mocks, or logs.
* **Plain Language (UX Guard):**
  - Never display internal jargon on UI screens or user-facing CLI errors:
    - Say *"Where to send"* instead of *"Sink"*.
    - Say *"Waiting messages"* instead of *"Outbox queue"*.
    - Say *"Message pattern"* instead of *"Regex"*.
  - Every error message must state what happened and provide the exact next click to fix it.
* **Contract Integrity:**
  - Sources and Sinks must **NEVER** import or interact directly with each other. All interactions route through the Engine.

---

## 4. Key References

* **Source of Truth Specification:** `docs/spec.md`
* **Architecture Decision Records:** `docs/decisions.md` (and `docs/decisions/*.md`)
* **Agent Guidelines:** `.agents/rules/AGENTS.md`

