# ADR 0017: Local MCP (Model Context Protocol) Server Architecture & Read-Replica Safety

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 3, 7 [Feature I-3], 11, 14, 16), `.agents/rules/AGENTS.md`, [ADR 0009](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0009-local-storage-sinks-database-archive.md), [ADR 0014](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0014-human-in-the-loop-replies-pull-ack-state-machine.md)

---

## 1. Context and Problem Statement

Sections 3 and 7 of `docs/spec.md` specify the Model Context Protocol (MCP) server under the "Should" scope:
1. **Feature I-3 Definition ([Section 7](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L213)):**
   - *"A read-only MCP server."*
   - *"stdio or HTTP on localhost."*
   - *"Tools: list threads, search messages, read a thread. Send is off by default and asks every time."*
2. **Absolute Anti-Spam & Zero-Autonomous-Send Invariant ([Section 3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L78), [Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L347)):**
   - *"Automatic or bulk sending. Never."*
   - AI agents (Claude Desktop, Cursor, local LLMs) must never be able to autonomously broadcast or send chat messages over connected Zalo or WhatsApp accounts without explicit human authorization.
3. **Data Isolation & Read Privacy ([Section 2, 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L52,L294)):**
   - Only messages that the rep explicitly selected in the Chat Picker and that passed all privacy filters (dropped OTPs, blocked contacts, groups disabled) may ever be visible.
   - Live outbox queues and internal engine databases must be protected from SQLite read locks and memory contention.

We evaluated three architectures:
1. **Option 1: In-Daemon HTTP/SSE MCP Endpoint inside the Engine Process.**
2. **Option 2: Dedicated CLI `stdio` MCP Server over Analytical SQLite Read-Replica with Human-Staged Reply Gate.**
3. **Option 3: Embedded Web UI Chatbot Widget.**

---

## 2. Decision

We choose **Option 2: Dedicated CLI `stdio` MCP Server over Analytical SQLite Read-Replica with Human-Staged Reply Gate**:

```
  [ External AI Client ] (Claude Desktop / Cursor / Local LLM)
             |
             | stdio (JSON-RPC 2.0 via @modelcontextprotocol/sdk)
             v
  [ chat-bridge mcp ] (CLI Subcommand Process)
             |
             +-----------------------+-----------------------+
             |                                               |
             v (Read Tools)                                  v (Optional Send Tool)
  [ Read-Only Analytical SQLite ]               [ Human-in-the-Loop Reply Staging ]
  (better-sqlite3 { readonly: true })           - Disabled by default
  - list_threads()                              - When invoked: inserts draft to
  - search_messages()                             `inbox_replies` (ADR 0014)
  - read_thread()                                 status: 'pending_user_click'
             |                                               |
             v                                               v
   Zero lock contention with                     Desktop UI notification:
   engine; privacy filters already               "AI assistant suggested a reply.
   guaranteed by ADR 0009 / 0010                 Click to review & send."
```

### Technical Specification

#### 1. Transport & Lifecycle
- **Command:** `chat-bridge mcp` implemented in `packages/cli` using the official `@modelcontextprotocol/sdk`.
- **Transport:** Standard input/output (`stdio`), the standard protocol preferred by desktop AI orchestrators (e.g., Claude Desktop `claude_desktop_config.json`).
- **Process Lifecycle:** Ephemeral child process managed by the LLM client; starts on demand and terminates automatically when the client closes the session. Adds **0 MB idle RSS** to the system when not in use.

#### 2. Read Isolation & Privacy Guarantees
- The MCP process does **not** query the internal engine outbox or live memory caches.
- It opens the dedicated analytical SQLite database (`chat-bridge-analytical.db` established in [ADR 0009](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0009-local-storage-sinks-database-archive.md)) with the SQLite flag `{ readonly: true, fileMustExist: true }`.
- **Architectural Advantages:**
  1. **Strict Privacy:** The analytical database contains only messages that have already passed through the 6-stage normalization and filter pipeline ([ADR 0010](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0010-message-normalization-filtering-pipeline-feed.md)) and were ticked in the Chat Picker. Private chats, OTPs, stories, and blocked contacts are physically absent.
  2. **Zero Concurrency Penalties:** SQLite WAL mode allows concurrent read connections without blocking engine write transactions.
  3. **Offline Availability:** Tools can query historical conversations even if the primary Electron desktop UI application is closed.

#### 3. Standard Read-Only Tool Set

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `list_threads` | `limit?: number` (default 20, max 100), `offset?: number` | Lists all chat threads where messages have been ingested, including thread title, native ID, network, and last activity timestamp. |
| `search_messages` | `query: string`, `thread?: string`, `limit?: number` | Performs SQLite full-text search across messages, returning matching IDs, snippets, sender names, and timestamps. |
| `read_thread` | `thread: string`, `limit?: number` (default 50, max 200), `beforeTime?: string` | Returns chronological messages within a thread up to the specified date-time boundary. |

#### 4. The Human-in-the-Loop Send Gate
In compliance with the spec requirement (*"Send is off by default and asks every time"*):
1. The `send_message` tool is **completely omitted** from the MCP server capabilities unless explicitly started with the flag:
   ```bash
   chat-bridge mcp --enable-mcp-send
   ```
2. When enabled, invoking `send_message(thread, text)` does **not** call any source connector or transmit messages to Zalo or WhatsApp.
3. Instead, it writes a staged record into the `inbox_replies` table ([ADR 0014](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0014-human-in-the-loop-replies-pull-ack-state-machine.md)):
   - `status`: `'pending_user_click'`
   - `source`: `'mcp_ai_assistant'`
   - `text`: the suggested draft
4. The MCP tool immediately returns:
   ```json
   {
     "status": "staged_for_user_approval",
     "message": "Draft created in Chat Bridge inbox. The user must review and click Send in the desktop app."
   }
   ```
5. The desktop app triggers a native notification: *"AI assistant prepared a reply for [Contact]. Click to review."* Only a physical click in the UI dispatches the message.

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1 (In-Daemon HTTP/SSE) | Option 2: CLI `stdio` over Read-Replica (Accepted) | Option 3 (Embedded UI Chatbot) |
| :--- | :--- | :--- | :--- |
| **Client Ecosystem Fit** | ⚠️ Complex SSE configuration for Claude/Cursor |  Native standard `stdio` configuration | ❌ Proprietary chat widget |
| **Privacy & Zero-Leakage** | ⚠️ Could leak live outbox queue state |  Reads only filtered, delivered analytical data | ⚠️ Exposes internal UI state |
| **Anti-Spam Safety** | ⚠️ Autonomous HTTP dispatch risk |  Zero-autonomous send; enforced human click gate (ADR 0014) |  Manual, but high UI complexity |
| **System Resource Impact** | ⚠️ Permanent memory & port listener |  0 MB idle; ephemeral CLI subprocess lifecycle | ❌ Bloats frontend bundle size |
| **Database Concurrency** | ⚠️ Potential event loop latency |  SQLite WAL zero-lock concurrent read | ⚠️ Competes on frontend thread |

---

## 4. Consequences and Mitigations

* **Trade-off 1: Analytical database must exist before queries can succeed.**
  * *Mitigation:* If `chat-bridge-analytical.db` does not exist yet (e.g. user hasn't turned on the analytical database sink or no messages delivered), the MCP server gracefully returns empty thread lists with a clear error: `"No messages have been archived to the local database yet."`
* **Trade-off 2: Full-text search performance on large archives (100k+ messages).**
  * *Mitigation:* ADR 0009 defines SQLite FTS5 indexes on `messages(text, sender_name)` ensuring sub-10ms query execution across 100k+ rows.
* **Trade-off 3: Configuration discoverability for non-technical users.**
  * *Mitigation:* Add a 1-click button in Settings > Developer: *"Copy Claude Desktop Config"*, which places the exact JSON snippet containing the path to `chat-bridge mcp` onto the user's clipboard.

