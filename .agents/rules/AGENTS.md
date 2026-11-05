# Chat Bridge: Agent Guidelines & Project Rules

This document defines the development rules, architectural contracts, and context hygiene standards for the **Chat Bridge** project.

---

## 1. Context Window & Conversation Hygiene

To keep the agent's context window lean and fast:
* **No Raw Dumps:** Never output large raw chat streams, multi-thousand-line JSON/JSONL archives, or bulky database queries into the chat context.
* **Filter & Paginate:** Pipe test outputs, logs, or JSON inspection through `head`, `tail`, or `jq` before reporting back.
* **Subagent Delegation:** For extensive library codebase exploration (such as inspecting `baileys` or `zca-js` internal types or checking long protocol schemas), delegate to the `research` subagent to isolate the noise from the main conversation.
* **Periodic Compaction:** Recommend the `/compact` command after completing major feature milestones (e.g., after Outbox is verified, before starting Source adapters).

---

## 2. Core Architecture & Plug-in Contracts (Sections 4 & 6)

The system consists of three strictly decoupled components:
1. **Sources (Input Providers):**
   - Implements `SourceContract`: `login()`, `start(onMessage)`, `stop()`, `status()`, `chats()`, `history(since)`, `send(thread, text)`.
   - Providers: `Fake` (test fixture replay), `Zalo` (`zca-js`), `WhatsApp` (`Baileys`).
2. **Engine (Message Pipeline & Outbox):**
   - Normalizes messages into the unified `Message` shape (Section 5).
   - Drops noise (stories, newsletters, reactions, typing, edits).
   - Enforces the Chat Picker (only ticked chats leave the computer).
   - Applies filters (blocked contacts, regex/OTP patterns, groups disabled by default).
   - Persists messages in an **encrypted SQLite Outbox** with **one independent queue per sink**.
   - Handles pacing, retries, and backoff per sink.
3. **Sinks (Output Providers):**
   - Implements `SinkContract`: `configure(settings)`, `test()`, `deliver(batch)`, `health()`, `pullReplies(max)`, `ack(results)`.
   - Providers: `Archive` (daily JSONL), `Local Database` (SQLite), `Google Sheets`, `Margince` (push with HMAC-SHA256 signature).

**Rule:** Sources and Sinks must NEVER communicate directly with each other or bypass the Engine contracts.

---

## 3. Engineering Quality Rules & Guards (Section 14)

* **Test-Driven Development (TDD):**
  - Always write the unit/integration test first (Red), verify it fails, then implement the minimal code to pass (Green).
  - Feature PRs must prove a red run followed by a green run.
* **Strict Privacy & Security:**
  - The AI agent **NEVER** holds a chat login, session token, or password.
  - The AI agent develops and tests **exclusively** against the `Fake` source and the `Mock Margince` server.
  - No real chat data, real phone numbers, real names, or customer PII in test fixtures, mocks, or logs.
* **Code Hygiene & Guards:**
  - Zero import cycles.
  - Zero dead code or unused exports.
  - No commented-out code.
  - No `TODO` comments without an associated issue tracker link.
  - Zero icons, emojis, or em dashes in CLI output, UI text, code comments, documentation, and agent communication.
* **User-Facing Plain Language (UX Guard):**
  - Never expose internal jargon to the user on UI screens or error dialogs (no *"sink"*, *"outbox"*, *"JID"*, or *"regex"*).
  - Use plain English: e.g., *"Where to send"* instead of *"Sink"*, *"Waiting messages"* instead of *"Outbox queue"*.
  - Every error message must clearly describe what happened and state the exact next click to fix it.
* **Automated PR & Review Workflow:**
  - When assigned a task or user story, the agent executes the complete 6-step lifecycle autonomously (Red -> Green -> Guard -> Adversarial Audit).
  - Creates a dedicated feature branch, pushes to the remote, and opens a Pull Request via GitHub CLI (`gh pr create`).
  - PR descriptions must include full Red-to-Green test logs, guard passes, and adversarial audit summaries for developer sign-off.

