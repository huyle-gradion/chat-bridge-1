# ADR 0007: Frontend Stack, UI Architecture & Plain-Language UX Guards

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 4, 7 [I-2, I-4, I-5, L-1], 10, 11, 14), `.agents/rules/AGENTS.md` (Section 3)

---

## 1. Context and Problem Statement

The Chat Bridge frontend represents the primary interface for non-technical sales reps ([Section 2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L48-L56)). It must provide:
1. **Ten Dedicated Screens ([Section 10](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L263-L290)):** Home, Where to send, Feed, Filters, Archive, 5-Step Setup Wizard, Chats, Logins, Import, and Warnings.
2. **Strict Usability & Anti-Jargon Guard ([Section 2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L55), [Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L354), [.agents/rules/AGENTS.md](file:///Users/van.tran/Documents/dev/chat-bridge/.agents/rules/AGENTS.md#L47)):**  
   Under no circumstances may technical developer jargon appear on user-facing screens or dialogs (*no "sink", "outbox", "JID", "regex", "nonce", or "HMAC"*). Every error message must explain the situation in plain language and clearly state the exact next click to fix it.
3. **Design Tokens & Accessibility Compliance ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L353)):**  
   Colors, typography, and spacing must derive strictly from a central design tokens file. Screens must be accessible (WCAG AA) and responsive down to a 375 px mobile screen width.
4. **Performance Budgets ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L301-L309)):**  
   Launch to wizard or home screen in `< 5s`. Idle memory RSS `< 250 MB`.
5. **Bilingual Localization (Feature L-1):**  
   English and Vietnamese interface strings, switchable with zero reload lag.

We evaluated three architectural approaches:
1. **Option 1 (Vanilla HTML/JS + Custom CSS):** Zero framework overhead, but high manual boilerplate for state management across 10 screens and wizard steps.
2. **Option 2 (React 19 + Vite + Tailwind CSS with Token Constraint + CI Word-List Guard):** Component-based architecture with headless accessible primitives, central tokens, type-safe i18n, and an automated CI test checking for forbidden jargon.
3. **Option 3 (Svelte 5 + Tailwind CSS):** Minimal bundle size, but smaller component ecosystem and less mature custom AST linting tooling for jargon guards.

---

## 2. Decision

We choose **Option 2: React 19 + Vite + Tailwind CSS constrained by Design Tokens and an Automated Plain-Language CI Guard**:

1. **Build & Architecture:**
   - Single-page application built with **React 19** and **Vite** in `src/ui/`.
   - Emits a static bundle served by the embedded loopback HTTP server (ADR 0004) and loaded in the Electron desktop renderer (ADR 0001).
   - Bundle size stays under 200 KB gzipped, cold booting in `< 1.2s`.
2. **Strict Design Token Enforcement:**
   - All visual design properties (palette, spacing, radius, typography) are defined in `src/ui/theme/tokens.ts`.
   - `tailwind.config.ts` imports and maps these tokens directly, disallowing arbitrary CSS values (`class="p-[17px]"`).
   - Component primitives use headless, accessible libraries (`@radix-ui/react-*` or lightweight equivalents) styled via tokens.
3. **Automated Plain-Language CI Guard (`guards/word-list.test.ts`):**
   - An automated test runs on every pull request to enforce the UX guard rule.
   - It parses all JSX/TSX files and localization dictionaries (`src/ui/locales/en.json`, `vi.json`).
   - If any forbidden word appears in user-facing string literals, the build immediately fails:
     - **Forbidden Words:** `sink`, `sinks`, `outbox`, `jid`, `regex`, `nonce`, `hmac`, `payload`.
     - **Required Plain-Language Equivalents:**
       - *Sink* $\rightarrow$ **Where to send**
       - *Outbox queue* $\rightarrow$ **Waiting messages**
       - *JID* $\rightarrow$ **Chat / Contact ID**
       - *Regex pattern* $\rightarrow$ **Text pattern**
4. **Action-Oriented Error Handling Pattern:**
   - Every UI error dialog and banner must implement the `UserFacingError` schema:
     ```typescript
     interface UserFacingError {
       title: string;        // Plain description of what happened
       explanation: string;  // Non-technical context
       actionText: string;   // Exact next click (e.g., "Reconnect account", "Open sheet settings")
       onAction: () => void;
     }
     ```
   - Technical error details (stack traces, raw HTTP error codes) are hidden behind a collapsible *"Details for support"* toggle.
5. **Type-Safe i18n Store (Feature L-1):**
   - Translations organized in `src/ui/locales/{en,vi}.json` with compile-time TypeScript keys.
   - Language toggle seamlessly switches between English and Vietnamese without reloading the webview or losing form progress.
6. **Setup Wizard State Machine:**
   - Centralized step store (`src/ui/stores/wizardStore.ts`) tracking the 5 setup phases (WhatsApp, Zalo, Tick Chats, Filters, Choose Sinks).
   - Supports mid-flow pausing, step skipping, and opening individual steps directly from Settings later.

---

## 3. Rationale and Comparison

| Evaluation Metric | Option 1: Vanilla HTML/JS | Option 2: React 19 + Tailwind + Guard (Selected) | Option 3: Svelte 5 + Tailwind |
| :--- | :--- | :--- | :--- |
| **UX Guard Enforcement** | Manual code review only; jargon frequently slips in. | **Automated.** AST/Regex CI test scans every string against forbidden words on PR build. | Manual or custom parser required. |
| **Startup & Memory Budget** | Fastest start (<0.5s), lowest RAM (~25 MB). | **Compliant.** Cold boot <1.2s, renderer memory ~45 MB RSS, comfortably within the 250 MB budget. | Cold boot <0.8s, renderer memory ~35 MB RSS. |
| **Component Velocity (Nov 27 Deadline)** | Slow. Writing custom accessible modals, dropdowns, and tabs from scratch. | **High Velocity.** Headless Radix primitives provide battle-tested keyboard navigation and ARIA support. | Moderate. Accessible component ecosystem requires more custom glue code. |
| **Design Consistency** | Prone to CSS drift and inconsistent spacing. | **Enforced.** Tailwind constrained strictly to tokens defined in `tokens.ts`. | Enforced via Tailwind tokens. |
| **Bilingual Support (L-1)** | Manual DOM node text updates. | **Declarative.** React context re-renders translations instantly on language switch. | Declarative Svelte stores. |

---

## 4. Consequences and Mitigations

* **Memory Footprint in Long-Running Background Bridging:**
  * *Trade-off:* Keeping the Chromium renderer alive in Electron when the app is minimized to the system tray consumes unnecessary RAM.
  * *Mitigation:* As established in ADR 0001, when the window is closed to the system tray, the Electron main process hides/unloads the renderer window, allowing the OS to reclaim renderer memory while the background engine continues running at ~50 MB RSS.
* **Accidental Technical Jargon in Dynamic API Errors:**
  * *Trade-off:* Upstream errors from chat connectors or network sockets might contain technical strings.
  * *Mitigation:* An error translation dictionary in `src/engine/errors/` intercepts raw errors before they reach the UI and maps them to sanitized `UserFacingError` representations.

