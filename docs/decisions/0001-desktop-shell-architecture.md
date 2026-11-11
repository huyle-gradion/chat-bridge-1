# ADR 0001: Desktop Shell Architecture & Runtime Selection

* **Status:** Accepted
* **Date:** 2026-11-04 (revised 2026-11-09)
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 4, 7 [I-1, I-2, I-5, C-3, C-7], 11, 13)

---

## 1. Context and Problem Statement

Chat Bridge must provide three operational interfaces sharing a single unified engine:
1. **Desktop App (Feature I-5):** An installable application for macOS and Windows. Non-technical sales reps must be able to double-click install, connect accounts, and configure sinks without touching a terminal (Acceptance Criteria in Section 13).
2. **Local Web UI (Feature I-2):** A web-based interface running strictly on `localhost` for setup, chat picking, feeds, and settings.
3. **CLI (Feature I-1):** A scriptable command-line interface for testers and developers (`chat-bridge status`, `run`, `sink`, etc.) with `--json` output.

The chat connectors (**`baileys`** (WhatsApp) and **`zca-js`** (Zalo)) are Node.js libraries with deep Node runtime dependencies (crypto, WebSockets, streams, file system). Furthermore, the app requires OS-level keystore encryption (**Feature C-3**: macOS Keychain and Windows DPAPI) and system tray/desktop notifications (**Feature C-7**).

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
| **Connector Compatibility** | **Native.** `baileys` and `zca-js` run directly in Node main process. | **Workable via Node sidecar.** Connectors run unchanged, but this adds per-platform binaries, native addon packaging (`better-sqlite3`), sidecar signing/notarization, and lifecycle supervision. | **Native.** Pure Node process. |
| **OS Keystore (C-3)** | **Built-in `safeStorage`.** Direct macOS Keychain and Windows DPAPI bindings out of the box. | Rust `keyring` reads the key and passes it to the sidecar over stdin. Simple, but the key crosses a process boundary. | Requires native C++ addons (`keytar`, `@napi-rs/keyring`) which frequently break cross-compilation. |
| **Desktop Usability (I-5, Section 13)** | **Native Window & Tray.** Standalone app window, dock/tray icons, desktop notifications. | **Native Window & Tray.** | **Poor.** Opens as a browser tab alongside personal browsing; easily closed by mistake. |
| **Idle Memory Budget (< 250 MB, engine process)** | **Engine process ~140–180 MB; whole app ~230–360 MB with window open (estimate).** | **Engine (sidecar) ~80–150 MB; whole app ~130–250 MB macOS, ~170–320 MB Windows (estimate).** | **Engine ~80–150 MB (estimate, real sessions).** |
| **Implementation Risk (Deadline: Nov 27)** | **Low.** 100% TypeScript/Node codebase, standard build pipeline. | **High.** Small Rust shell the TS team must own; sidecar lifecycle (port, auth, readiness, crash restart, clean exit); per-platform Node + native-addon packaging and sidecar signing on macOS and Windows. | **Medium.** Cannot easily satisfy non-terminal standalone install criteria. |

---

## 4. Consequences and Mitigations

* **Memory Footprint & Long-Running Scalability:** Electron consumes more RAM than Tauri or a pure daemon due to Chromium. All memory figures in Section 3 are unmeasured estimates. The spec budget (`docs/spec.md` Section 11) applies to the engine process, which in Electron is the main process; renderer, GPU and utility processes are reported separately.
  * *Mitigation:* The engine core (`src/engine/`) is strictly decoupled from Electron APIs so it can run headless; CI enforces the budget on the headless engine in pure Node. Closing the window to the system tray calls `win.destroy()` (not `hide()`), freeing the renderer; the window is recreated on reopen. The feed list is virtualized so an open window does not grow with traffic. Background processes and outbox queues maintain bounded in-memory buffers.
  * *Validation:* Measure RSS with `app.getAppMetrics()` (per process and total) as soon as the shell exists, with real WhatsApp and Zalo sessions. If the main process exceeds 250 MB idle, revisit this decision.
* **Installer Size:** Binaries will be larger (~80–100 MB).  
  * *Mitigation:* Acceptable per spec scope (broadband installer download for desktop users).
* **CLI Code Sharing:** The CLI must not depend on Electron APIs.  
  * *Mitigation:* Keystore access will use an adapter interface: Electron environment uses `safeStorage`, while standalone CLI and CI use a portable keyfile/fallback mechanism (`0600` permissions on Linux/CI as specified in C-3).

---

## 5. Revision History

* **2026-11-09:** Corrected the Tauri connector and keystore rows (sidecar is workable; no FFI needed), scoped and marked memory figures as estimates, replaced "unload renderer" with `win.destroy()` on close to tray, and added a measurement check. Reworded the Tauri implementation risk to name the actual costs (Rust ownership, sidecar lifecycle, packaging and signing) instead of IPC overhead. Memory row now compares engine process and whole app on the same basis for each option. Decision unchanged. The Electron shell is not yet implemented in `packages/desktop/`.
