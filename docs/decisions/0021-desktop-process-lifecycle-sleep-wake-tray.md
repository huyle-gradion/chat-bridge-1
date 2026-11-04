# ADR 0021: Desktop Process Lifecycle, Sleep/Wake Resiliency & System Tray Daemon Architecture

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 4, 7 [Features C-1, C-3, C-5, C-7, I-5], 11, 13), `docs/decisions/0001-desktop-shell-architecture.md`, `docs/decisions/0005-outbox-multi-queue-worker-pacing.md`, `docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md`

---

## 1. Context and Problem Statement

Chat Bridge is packaged as an installable desktop application for macOS and Windows, designed for non-technical sales representatives operating on personal or corporate laptops ([Section 2, 7 [Feature I-5]](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L49-L57)).

Laptops operate in an inherently unstable physical environment:
1. **Window Close Expectations:** When a user clicks the window close button (`X` on Windows, red dot on macOS), they expect the bridge to continue syncing chats in the background. Terminating the process stops message delivery, violating user expectations.
2. **Idle Memory Budget ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L305)):** The spec sets a strict **< 250 MB idle RSS** budget. A standard Electron application running Chromium renderer views continuously consumes 150–200 MB of RAM even when minimized, leaving minimal headroom during burst message arrivals ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L307)).
3. **OS Sleep and Wake Cycles (Lid Close):** When a user closes their laptop lid or the OS enters power suspension, active WebSocket connections to WhatsApp (`baileys`) and Zalo (`zca-js`) silently drop or become half-open sockets. Upon waking:
   - If the engine blindly writes to dead sockets, unhandled socket exceptions crash the engine.
   - If the engine blindly initiates immediate simultaneous reconnection storms, WhatsApp and Zalo risk flagging or banning the rep's account for abnormal bot behavior ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L297)).
4. **Data Integrity on Shutdown ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L296)):** *"A crash, a reboot or a closed laptop loses no message that reached the outbox."* When the OS shuts down, restarts, or user logs out, active SQLite transactions and WAL caches must be flushed cleanly without file corruption.
5. **Zero Admin Rights Required ([Section 2, 13](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L55)):** Non-technical users cannot be asked to install root system services (`launchd` daemons or Windows Services requiring UAC elevation).

We evaluated three architectural approaches:
1. **Option 1: Standard Electron Monolith (Window Hide Only, No Power Management).**
2. **Option 2 (Accepted): Lifecycle Orchestrator with PowerMonitor Sleep/Wake State Machine, Tray Daemon & Renderer Suspension.**
3. **Option 3: Separate OS Background System Service (launchd / Windows Service).**

---

## 2. Decision

We choose **Option 2: Lifecycle Orchestrator with PowerMonitor Sleep/Wake State Machine, Tray Daemon & Renderer Suspension**:

```
                       [ Operating System Events ]
                                    |
          +-------------------------+-------------------------+
          | (Window Close / Show)   | (powerMonitor Events)   | (App Quit / OS Shutdown)
          v                         v                         v
  [ Window Manager ]        [ Power Lifecycle ]       [ Two-Phase Shutdown ]
  - Close: Hide window      - Suspend:                - Phase 1: Drain in-flight
    & destroy renderer        * Pause outbox workers    batches (max 3s)
    (drops RAM to ~50 MB)     * Pause keepalives      - Phase 2: Flush WAL
  - Tray Click:             - Resume:                   (wal_checkpoint(TRUNCATE))
    Re-instantiate            * Network probe (3s)    - Close SQLite DBs
    renderer window           * Staggered reconnect   - Exit code 0
                              * Resume outbox
                                    |
                                    v
                         [ Native System Tray ]
                         - Dynamic status badge (Green / Amber / Red)
                         - Action menu: Dashboard, Status, Pause, Quit
```

### Technical Specification

#### 1. System Tray Integration & Renderer Memory Reclamation
- **Tray Daemon:** The desktop application initializes a native system tray icon on macOS (menu bar) and Windows (system notification area) upon startup.
- **Window Lifecycle (`window-all-closed`):**
  - Overriding default Electron behavior: closing the main window (`close` event) does not terminate the app; instead, it prevents default and hides the window (`window.hide()`).
  - **Memory Reclamation:** Upon window hide, the Chromium web contents heap is destroyed/unloaded (`window.destroy()` or navigating to `about:blank` and clearing browser view cache). This drops the memory footprint of the running process from ~180 MB down to **40–60 MB RSS**, well below the 250 MB budget.
  - When the user clicks the tray icon or application dock icon, a lightweight window is re-created and connected to the running local HTTP/SSE server ([ADR 0004](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0004-web-ui-transport-local-api.md)).
- **Dynamic Tray Badging:** The tray icon reflects the tri-state health classification from [ADR 0013](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md):
  - `OK` (All active connectors & sinks healthy): Default monochrome icon.
  - `WARNING` (14-day WhatsApp warning, Zalo takeover, sink degraded): Amber dot badge + native OS notification ([Feature C-7](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L176)).
  - `DOWN` (Connector disconnected or outbox stalled): Red alert icon.

#### 2. Sleep/Wake Resiliency State Machine
The `DesktopLifecycleService` binds directly to Electron's `powerMonitor` API:
1. **`powerMonitor.on('suspend')`:**
   - Transitions engine state to `STATE_SUSPENDED`.
   - Pauses all outbox queue workers ([ADR 0005](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0005-outbox-multi-queue-worker-pacing.md)), preventing outbound network requests while the network stack is shutting down.
   - Instructs WhatsApp (`baileys`) and Zalo (`zca-js`) watchdogs to pause heartbeat timers.
2. **`powerMonitor.on('resume')`:**
   - Transitions engine state to `STATE_RESUMING`.
   - **Network Stabilization Delay:** Waits 3 seconds for the operating system to re-acquire DHCP leases and re-establish Wi-Fi/Ethernet connectivity.
   - **Network Verification Probe:** Performs a lightweight DNS query (`dns.resolve('margince.com')` or public DNS) before attempting connector reconnects.
   - **Staggered Connector Reconnection:** Reconnects WhatsApp and Zalo with a jittered 2–5 second offset to prevent simultaneous connection spikes that could trigger automated spam/bot detection.
   - Resumes outbox queue workers to flush pending messages.

#### 3. Two-Phase Graceful Shutdown Protocol
When the application receives a termination signal (`app.on('before-quit')` in Electron, or `SIGINT`/`SIGTERM` in standalone CLI mode):
1. **Phase 1: Ingestion Freeze & In-Flight Batch Drain:**
   - Stops accepting new inbound chat events from connectors.
   - Sets a strict deadline timer of **3,000 ms** for currently executing HTTP/Sink `deliver()` calls to resolve and acknowledge.
2. **Phase 2: Database Flush & Clean Teardown:**
   - Halts all queue worker loops.
   - Issues `PRAGMA wal_checkpoint(TRUNCATE)` on `outbox.db`, `analytics.db`, and `sessions.db`, safely committing all uncheckpointed WAL pages to the primary database files.
   - Closes all `better-sqlite3` database connections.
   - Unregisters the system tray icon and terminates the process with exit code 0.

---

## 3. Rationale and Comparison

| Evaluation Dimension | Option 1: Standard Window Hide Only | Option 2: Lifecycle Orchestrator (Accepted) | Option 3: OS System Service (launchd/WinService) |
| :--- | :--- | :--- | :--- |
| **Idle Memory Budget (< 250 MB)** | **Poor (~160–200 MB).** Chromium renderer stays in memory indefinitely while closed to tray. | **Excellent (~45–65 MB).** Chromium renderer is suspended/unloaded while closed to tray; headless engine stays lean. | Low memory, but heavy multi-process IPC overhead. |
| **Sleep/Wake Resilience & Account Safety** | **High Risk.** Broken TCP sockets hang; wake triggers simultaneous reconnect storms flagging accounts. | **Protected.** State machine handles suspend/resume cleanly with network probes and jittered reconnects. | Still requires custom network/sleep event handling in daemon. |
| **Install Friction (15-min Non-Tech Rep)** | **Zero Friction.** Standard single-app installer. | **Zero Friction.** Installs seamlessly with standard double-click; runs entirely in user-space. | **Fails Usability.** Requires administrator privileges, UAC prompts, and service registration. |
| **Data Durability on Power Down** | Potential WAL corruption or partial batch loss on sudden OS restart. | **Guaranteed.** Two-phase shutdown drains in-flight batches and flushes WAL checkpoints (`TRUNCATE`). | Vulnerable if OS sends abrupt SIGKILL before service finishes. |

---

## 4. Consequences and Mitigations

* **Slight Delay on Re-opening Window:** Recreating or reloading the web contents view when clicking the tray icon introduces a ~200–300 ms UI rendering delay.  
  * *Mitigation:* The local HTTP/SSE backend is already warm and running; the React bundle loads from local loopback cache instantaneously, providing a smooth user experience.
* **macOS Dock vs Tray Convention:** On macOS, closing an app window typically leaves the dock icon active without quitting.  
  * *Mitigation:* On macOS, the app keeps both the dock icon and menu bar tray icon synchronized; clicking either restores the window.

