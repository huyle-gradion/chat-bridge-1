# ADR 0001: Desktop Shell Architecture & Runtime Selection

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 4, 7 [I-1, I-2, I-5, C-3, C-7], 11, 13)

---

## 1. Context and Problem Statement

Chat Bridge must provide three operational interfaces sharing a single unified engine:
1. **Desktop App (Feature I-5):** An installable application for macOS and Windows. Non-technical sales reps must be able to double-click install, connect accounts, and configure sinks without touching a terminal (Acceptance Criteria in Section 13).
2. **Local Web UI (Feature I-2):** A web-based interface running strictly on `localhost` for setup, chat picking, feeds, and settings.
3. **CLI (Feature I-1):** A scriptable command-line interface for testers and developers (`chat-bridge status`, `run`, `sink`, etc.) with `--json` output.

The chat connectors—**`baileys`** (WhatsApp) and **`zca-js`** (Zalo)—are Node.js libraries with deep Node runtime dependencies (crypto, WebSockets, streams, file system). Furthermore, the app requires OS-level keystore encryption (**Feature C-3**: macOS Keychain and Windows DPAPI) and system tray/desktop notifications (**Feature C-7**).

We evaluated three architectural approaches:
1. **Option 1 (Electron):** Main process executes Node.js engine and connectors; renderer displays local UI.
2. **Option 2 (Tauri / Native Webview + Node.js Sidecar):** Rust-based webview shell managing an external packaged Node.js process.
3. **Option 3 (Headless Node.js Daemon + System Browser):** Node.js local web server automatically opening the system default browser.

---

## 2. Decision

We will proceed with **Option 1: Electron**:

1. **Desktop Application:** Packaged using Electron (`electron-builder` / `electron-forge`) targeting macOS (`.dmg`) and Windows (`.exe` installer).
2. **Main Process:** Hosts the unified engine, encrypted SQLite outbox, local HTTP API server, and chat providers (`baileys`, `zca-js`, `fake`).
3. **Renderer Process:** Displays the Setup Wizard (I-4) and Web UI (I-2), communicating with the engine over local HTTP / IPC.
4. **CLI Executable:** Distributed as a standalone Node.js CLI script (`bin/chat-bridge.js`) that imports the exact same engine core (`src/engine/`) directly in pure Node without launching Electron or Chromium.

---

## 3. Rationale and Comparison

| Evaluation Metric | Option 1: Electron (Selected) | Option 2: Tauri + Sidecar | Option 3: Daemon + Browser |
| :--- | :--- | :--- | :--- |
| **Connector Compatibility** | **Native.** `baileys` and `zca-js` run directly in Node main process. | **Complex.** Requires bundling, spawning, and supervising a secondary Node runtime. | **Native.** Pure Node process. |
| **OS Keystore (C-3)** | **Built-in `safeStorage`.** Direct macOS Keychain and Windows DPAPI bindings out of the box. | Requires cross-language FFI between Rust keyring and Node. | Requires native C++ addons (`keytar`, `@napi-rs/keyring`) which frequently break cross-compilation. |
| **Desktop Usability (I-5, Section 13)** | **Native Window & Tray.** Standalone app window, dock/tray icons, desktop notifications. | **Native Window & Tray.** | **Poor.** Opens as a browser tab alongside personal browsing; easily closed by mistake. |
| **Idle Memory Budget (< 250 MB)** | **~140–180 MB.** Fits safely within Section 11 budget. | **~60–100 MB.** | **~50–70 MB.** |
| **Implementation Risk (Deadline: Nov 27)** | **Low.** 100% TypeScript/Node codebase, standard build pipeline. | **High.** Dual-runtime (Rust + TS) maintenance, IPC overhead, dual-OS sidecar bundling. | **Medium.** Cannot easily satisfy non-terminal standalone install criteria. |

---

## 4. Consequences and Mitigations

* **Memory Footprint & Long-Running Scalability:** Electron consumes more RAM than Tauri or a pure daemon due to Chromium.  
  * *Mitigation:* The engine core (`src/engine/`) is strictly decoupled from Electron APIs so it can run headless at ~50 MB RSS. In the desktop app, when the window is closed to the system tray, the app minimizes/unloads the Chromium renderer process, dropping the memory footprint significantly during long-running background bridging. Background processes and outbox queues maintain bounded in-memory buffers.
* **Installer Size:** Binaries will be larger (~80–100 MB).  
  * *Mitigation:* Acceptable per spec scope (broadband installer download for desktop users).
* **CLI Code Sharing:** The CLI must not depend on Electron APIs.  
  * *Mitigation:* Keystore access will use an adapter interface: Electron environment uses `safeStorage`, while standalone CLI and CI use a portable keyfile/fallback mechanism (`0600` permissions on Linux/CI as specified in C-3).

