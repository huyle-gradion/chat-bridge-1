# ADR 0031: Plain-Language Desktop Notification Engine & Action Remediation Dispatcher

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 7 [Feature C-7, C-1], 10, 11, 14), `docs/decisions/0004-web-ui-transport-local-api.md`, `docs/decisions/0007-frontend-stack-plain-language-guard.md`, `docs/decisions/0013-health-engine-telemetry-sampler-watchdogs.md`, `docs/decisions/0021-desktop-process-lifecycle-sleep-wake-tray.md`, `docs/decisions/0025-zalo-session-takeover-detection-privacy-edge-cases.md`, `docs/decisions/0027-internationalization-plain-language-lexicon-bilingual-parity.md`

---

## 1. Context and Problem Statement

A core usability requirement for Chat Bridge is non-technical self-sufficiency ([Section 2](../spec.md#L47), [Section 11](../spec.md#L293)):
- *"Every screen says what to do next in one plain sentence. Every error says what happened and what to click."*
- Feature **C-7** mandates proactive warnings:  
  *"Warn before the WhatsApp 14-day logout, and when Zalo Web takes over the session. A banner in the UI and a desktop notification, each with the one thing to do."*
- Section 10 defines the **Warnings** UI screen: *"Banner for the 14-day rule and for a Zalo Web takeover."*

### Architectural Challenges
1. **Alert Fragmentation & Notification Fatigue:**
   - Multiple disparate subsystems independently encounter issues: connectors (WhatsApp 14-day inactivity watchdog, Zalo Web takeover), sink delivery workers (Google Sheets expired OAuth refresh token, Margince network unreachable), health engine (high memory/CPU), and auto-updater (new beta release ready).
   - If each subsystem fires ad-hoc OS notifications, a temporary network blip or reconnection backoff loop could spam the user's desktop with dozens of redundant alerts ("alert fatigue").
2. **Context Disruption vs Desktop Backgrounding:**
   - When the sales rep is actively working inside the Chat Bridge Web UI, displaying redundant native operating system popup notifications directly over the focused window is disruptive and irritating.
   - Conversely, when the app is minimized to the system tray or running in the background, native OS notifications are mandatory so the user does not miss critical session dropouts.
3. **UX Plain-Language Guard & Actionable Remediation:**
   - Error messages must never present technical jargon (no HTTP error codes, no stack traces, no "JID", "sink", "outbox", or "IPC failure").
   - Every alert must provide an explicit, single remediation click that immediately navigates to or triggers the resolution.

We evaluated three architectural options:
1. **Option 1 (Accepted): Centralized Alert Registry & Action Remediation Dispatcher with Window-Focus Suppression & 15-Minute Cooldown.**
2. **Option 2: Ad-Hoc Native OS Notifications in Individual Subsystems.**
3. **Option 3: Web-UI-Only In-App Banners (No Desktop OS Notifications).**

---

## 2. Decision

We choose **Option 1: Centralized Alert Registry & Action Remediation Dispatcher with Window-Focus Suppression & 15-Minute Cooldown**:

```
           [ Connector Watchdogs ]   [ Sink Workers ]   [ Health Engine ]   [ Auto-Update ]
                      |                     |                   |                  |
                      +---------------------+-------------------+------------------+
                                            |
                                            v
                             [ Central Notification Engine ]
                             - Maintains active Alert Map
                             - Deduplicates by unique alertKey
                             - Enforces 15-min spam cooldown
                             - Severity: CRITICAL | WARNING | INFO
                                            |
                         +------------------+------------------+
                         |                                     |
                         v                                     v
             [ Loopback SSE Channel ]               [ Electron Main Process ]
             - /api/v1/events                       - powerMonitor & window focus check
             - Pushes notification:update           - Is window visible and focused?
                         |                                     |
                         v                               +-----+-----+
               [ React Web UI ]                          |           |
             - Sticky Warning Banner                   (Yes)        (No)
             - Warnings Screen (/warnings)               |           |
             - Action button bound to                   Ignore       v
               remediation route                       OS popup  [ Native OS Notification ]
                                                                 - macOS Notification Center
                                                                 - Windows Toast Notification
                                                                 - Clicking notification
                                                                   focuses window & dispatches
                                                                   remediation route
```

### Technical Specification & Implementation Details

1. **Central Alert Registry Data Model:**
   ```typescript
   export type AlertSeverity = 'critical' | 'warning' | 'info';

   export interface SystemAlert {
     key: string;                    // Deterministic key: e.g. 'source:whatsapp:14day_expiring'
     severity: AlertSeverity;
     category: 'connector' | 'sink' | 'system' | 'update';
     titleKey: string;               // i18n lexicon key (ADR 0027)
     messageKey: string;             // i18n lexicon key
     params?: Record<string, string | number>;
     action: {
       labelKey: string;             // e.g. 'actions.reconnect'
       route: string;                // e.g. '/logins/zalo'
       actionId?: string;            // e.g. 'trigger_google_oauth'
     };
     firstRaisedAt: string;          // ISO 8601
     lastNotifiedAt: number;         // Unix timestamp (ms)
   }
   ```

2. **Standardized Alert Lexicon (Feature C-7 & Section 11 Compliance):**

| Alert Key | Plain-Language English Summary | Plain-Language Vietnamese Summary | One-Click Remediation Action |
| :--- | :--- | :--- | :--- |
| `source:whatsapp:14day_expiring` | *"Open WhatsApp on your phone in the next {days} days, or this computer will be logged out."* | *"Mở WhatsApp trên điện thoại của bạn trong {days} ngày tới để duy trì kết nối."* | Route: `/warnings` (opens *"How to keep connected"* guidance card) |
| `source:zalo:takeover` | *"Zalo Web was opened elsewhere and disconnected this computer."* | *"Zalo Web đã được mở ở nơi khác và ngắt kết nối máy tính này."* | Route: `/logins` (Action: *"Reconnect Zalo"*, opens QR login) |
| `source:whatsapp:disconnected` | *"WhatsApp lost connection to your phone."* | *"WhatsApp bị mất kết nối với điện thoại của bạn."* | Route: `/logins` (Action: *"Reconnect WhatsApp"*) |
| `sink:sheets:auth_expired` | *"Google disconnected your spreadsheet. Please sign in again."* | *"Google đã ngắt kết nối trang tính. Vui lòng đăng nhập lại."* | Route: `/settings/where-to-send` (Action: *"Sign in with Google"*) |
| `sink:margince:unreachable` | *"Cannot reach Margince. Messages are safely waiting on this computer."* | *"Không thể kết nối với Margince. Tin nhắn đang được lưu an toàn trên máy."* | Route: `/settings/where-to-send` (Action: *"Check Margince address"*) |

3. **Window Focus Suppression & Tray Integration:**
   - In the Electron main process, `BrowserWindow.isFocused()` is checked before invoking `new Notification()`:
     ```typescript
     ipcMain.on('notification:os', (event, alert: SystemAlert) => {
       const isAppVisible = mainWindow && mainWindow.isVisible() && mainWindow.isFocused();
       if (isAppVisible) {
         // User is already looking at the UI banner; suppress duplicate OS popup
         return;
       }
       const notification = new Notification({
         title: t(alert.titleKey),
         body: t(alert.messageKey, alert.params),
         icon: path.join(__dirname, 'assets/icon.png')
       });
       notification.on('click', () => {
         mainWindow.show();
         mainWindow.focus();
         mainWindow.webContents.send('navigate:remediation', alert.action);
       });
       notification.show();
     });
     ```
   - When active critical alerts exist, the System Tray icon displays an alert badge (amber dot or badge count) per [ADR 0021](0021-desktop-process-lifecycle-sleep-wake-tray.md).

4. **15-Minute Anti-Spam Debounce Window:**
   - A raised alert is published immediately on its first occurrence.
   - Subsequent triggers of the same `alertKey` (e.g. repeated reconnection failures or health ticks) update `lastSeenAt` but suppress OS notification popups until a **15-minute cooldown** expires ($t_{\text{cooldown}} = 900,000 \text{ ms}$).
   - Resolving the condition (e.g. WhatsApp reconnects) immediately clears the alert from the registry and broadcasts `notification:clear` over SSE, dismissing the web banner.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Central Registry with Focus Suppression (Accepted) | Option 2: Ad-Hoc Subsystem Notifications | Option 3: Web-UI-Only Banners |
| :--- | :--- | :--- | :--- |
| **Alert Spam & Cooldown** | **Zero spam**: 15-minute cooldown and centralized deduplication per alert key. | High spam risk: Retry loops fire dozen notifications on network disconnect. | Zero spam, but completely silent when app is minimized. |
| **Desktop User Experience** | Native OS popup appears only when app is minimized/blurred; clicking it deep-links to resolution. | Constant jarring popups even while typing inside the app window. | **Fails Spec C-7**: Misses desktop notifications when running in system tray. |
| **UX Plain-Language Compliance** | Enforces strict type-safe lexicon; guaranteed plain sentence + single click action. | Ad-hoc strings frequently leak technical jargon and stack error codes. | Compliant within UI, but absent on OS desktop. |
| **Architectural Separation** | Clean SSE event stream for UI; decoupled IPC message for desktop shell. | Tight coupling between low-level connector sockets and Electron window APIs. | Decoupled, but incomplete functionality. |

---

## 4. Consequences and Mitigations

* **Trade-off 1: Operating system notification permissions.**
  * *Mitigation:* On macOS, notification permissions must be granted by the user. If the user denies system notification permissions, the app degrades gracefully: the sticky UI banner and system tray badge remain fully functional.
* **Trade-off 2: Headless CLI parity.**
  * *Mitigation:* In standalone CLI mode (`chat-bridge run`), OS desktop popups are skipped; alerts are logged to stderr using plain-language red/yellow terminal badges (`[WARN] Open WhatsApp on your phone in the next 2 days`).
* **Trade-off 3: Deep-link race conditions upon app startup.**
  * *Mitigation:* If the user clicks an OS notification while the renderer is initializing, the remediation action payload is queued in the Electron main process and dispatched immediately after the `dom-ready` event.

