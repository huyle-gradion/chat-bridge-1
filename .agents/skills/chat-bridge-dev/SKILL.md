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

## 2. Test-Driven Development (TDD) Runbook

Every feature implementation must follow strict TDD:

1. **Step 1: Write Test First (Red)**
   - Create or update a test in `tests/` using Vitest.
   - Use `FakeSource` for chat replay and `MockMarginceServer` for push/pull endpoints.
   - Run `npx vitest run <test-file>` and verify the test fails with an expected assertion error.
2. **Step 2: Implement Minimal Code (Green)**
   - Implement only the minimal logic required to satisfy the failing test under `src/`.
   - Run `npx vitest run <test-file>` and verify the test passes.
3. **Step 3: Refactor & Guard Check**
   - Verify zero circular dependencies (`madge` or lint checks).
   - Verify zero dead code or unused exports.
   - Verify no PII or real credentials in test fixtures.

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

