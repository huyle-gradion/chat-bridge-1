# ADR 0027: Internationalization (i18n), Plain-Language Lexicon & Bilingual Parity

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 2, 7 [Features L-1, I-1, I-2, I-4], 10, 11, 14, 16), `.agents/rules/AGENTS.md` (Section 3), `docs/decisions/0007-frontend-stack-plain-language-guard.md`, `docs/decisions/0015-monorepo-topology-workspace-boundaries-contract-guards.md`, `docs/decisions/0019-application-configuration-store-secrets-segregation.md`

---

## 1. Context and Problem Statement

Chat Bridge serves Vietnamese sales representatives collaborating with international CRM teams ([Section 2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L47), [Feature L-1](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L212)):
- *"Every screen in English and Vietnamese, switchable."*
- Every error message must describe what happened in plain words and state the exact next click to fix it ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L310)).
- User-facing plain-language rules prohibit developer jargon (*"sink"*, *"outbox"*, *"JID"*, *"regex"*, *"SSRF"*) on UI screens and CLI outputs ([Section 16](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L365), [AGENTS.md Rule 3](file:///Users/van.tran/Documents/dev/chat-bridge/.agents/rules/AGENTS.md)).

### Architectural Challenges
1. **Zero-Drift Bilingual Parity:**
   - As new features, error conditions, and settings are introduced across sprints, localized strings in English and Vietnamese frequently diverge, leaving missing translation keys (`MISSING_TRANSLATION: ...`) or untranslated fallback English strings in Vietnamese production builds.
2. **Automated Enforcement of Plain-Language Constraints:**
   - Human developers inadvertently write technical terms into UI copies and error messages (e.g. *"Sink failed with network timeout"*, *"Outbox queue size: 45"*). This must be caught deterministically in CI before code merges.
3. **CLI and Web UI Shared Lexicon:**
   - The CLI (`chat-bridge status`, `chat-bridge setup`) and the Web UI must use identical plain-language terms (e.g. *"Where to send"* in English, *"Nơi gửi"* in Vietnamese).
4. **Performance & Offline Loading:**
   - The app runs locally and offline; translation dictionaries must load synchronously in < 1ms without async HTTP chunk waterfalls or flicker on startup.

We evaluated three architectural options:
1. **Option 1: Runtime React-i18next with Dynamic HTTP Fetching.**
2. **Option 2 (Accepted): Compile-Time Type-Safe Dictionaries in Shared `packages/i18n` with CI Jargon Linter and Synchronous Locale Switching.**
3. **Option 3: Hardcoded Component-Level Ternaries.**

---

## 2. Decision

We choose **Option 2: Compile-Time Type-Safe Dictionaries in Shared `packages/i18n` with CI Jargon Linter and Synchronous Locale Switching**:

```
                  [ packages/i18n ]
                          |
             +------------+------------+
             |                         |
             v                         v
       [ en.json ]               [ vi.json ]
      (Source of Truth)       (Exact 1:1 Parity)
             |                         |
             +------------+------------+
                          |
                          v
         [ TypeScript Type-Checking (CI) ]
         - type TranslationKey = keyof typeof en;
         - assertParity(en, vi) -> Compile Error if drift!
                          |
                          v
         [ Automated CI Jargon Linter ]
         - Scan en.json & vi.json against forbidden terms
         - Forbidden: "sink", "outbox", "regex", "jid", "payload"
         - Permitted: "where to send", "waiting messages", "pattern"
                          |
             +------------+------------+
             |                         |
             v                         v
     [ packages/ui ]            [ packages/cli ]
     - Instant Synchronous      - Terminal Output in
       React Context Hook         User's Chosen Language
     - Switchable in UI         - Env / Setting / --lang
```

### Technical Specification

#### 1. Plain-Language Canonical Lexicon
The shared lexicon defines standard translations for internal vs user-facing concepts across both languages ([Section 16](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L365)):

| Internal Concept | User-Facing English (UI & CLI) | User-Facing Vietnamese (UI & CLI) | Prohibited Jargon |
| :--- | :--- | :--- | :--- |
| **Sink** | Where to send | Nơi gửi | *sink, destination adapter* |
| **Outbox Queue** | Waiting messages | Tin nhắn đang chờ | *outbox, queue, buffer* |
| **Outbox (Delivered)** | Sent | Đã gửi | *dispatched, acked* |
| **Source** | Chat app | Ứng dụng chat | *connector, ingress* |
| **Regex Filter** | Message pattern | Mẫu tin nhắn | *regex, regexp, pattern match* |
| **JID / UID** | Contact ID / Phone | Số điện thoại / Mã liên hệ | *JID, UID, LID* |
| **Health: Degraded** | Slow | Chậm | *degraded, backoff* |

#### 2. Package Architecture (`packages/i18n`)
Located in `packages/i18n/`:
```
packages/i18n/
├── src/
│   ├── locales/
│   │   ├── en.json
│   │   └── vi.json
│   ├── index.ts
│   ├── types.ts
│   └── linter/
│       └── jargonLinter.ts
├── package.json
└── tsconfig.json
```
- **Type-Safe Contract Enforcement (`types.ts`):**
  ```typescript
  import en from './locales/en.json';
  import vi from './locales/vi.json';

  export type TranslationSchema = typeof en;
  export type TranslationKey = DeepKeys<TranslationSchema>;

  // Compile-time assertion that vi conforms strictly to en schema
  const _typeCheck: TranslationSchema = vi;
  ```
- **Translation Hook (`useTranslation` for React UI):**
  ```typescript
  export function useTranslation() {
    const { language, setLanguage } = useLanguageStore();
    const t = (key: TranslationKey, params?: Record<string, string | number>) => {
      return formatMessage(dictionaries[language], key, params);
    };
    return { t, language, setLanguage };
  }
  ```

#### 3. Automated CI Jargon Linter (`jargonLinter.ts`)
Run during `pnpm lint` and GitHub Actions:
- **Forbidden Patterns:**
  ```typescript
  const FORBIDDEN_WORDS = [
    /\bsink\b/i,
    /\boutbox\b/i,
    /\bregex\b/i,
    /\b(jid|lid)\b/i,
    /\bpayload\b/i,
    /\b(ssrf|ipc)\b/i
  ];
  ```
- Inspects `locales/en.json`, `locales/vi.json`, all UI components (`packages/ui/src/**/*.tsx`), and CLI error handlers.
- If a prohibited word is found in user-facing strings, CI fails with an explanatory error:
  `ERROR: Prohibited technical jargon "sink" found in "locales/en.json:home.sinksTitle". Use "where to send" instead.`

#### 4. Date, Time & Number Formatting
- Dates and timestamps are formatted using native `Intl.DateTimeFormat`:
  - `vi-VN`: `14:30 05/11/2026`
  - `en-US`: `Nov 5, 2026, 2:30 PM`
- Relative time (e.g. *"2 minutes ago"* / *"2 phút trước"*) uses `Intl.RelativeTimeFormat`.
- Formatting is purely local, zero third-party date library overhead.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Dynamic React-i18next | Option 2 (Accepted): Compile-Time Type-Safe Dictionaries | Option 3: Hardcoded Component Ternaries |
| :--- | :--- | :--- | :--- |
| **Parity Guarantee** | Runtime warning if key is missing. | **Zero Drift.** Build fails if `vi.json` lacks any key from `en.json`. | No parity guarantee. High drift. |
| **Jargon Guard Enforcement** | Manual code review. | **Automated CI Linter.** Scans all translation keys for forbidden jargon. | Impossible to audit reliably. |
| **CLI Sharing** | React-specific, CLI cannot reuse. | **100% Shared.** Both CLI and Web UI import the exact same package. | High duplication. |
| **Startup Overhead** | Async fetch adds layout shift. | **0ms Startup.** Bundled as pure JSON into local bundle. | 0ms, but unmaintainable. |

---

## 4. Consequences and Mitigations

* **Trade-off 1:** Adding a new UI string requires adding entries to both `en.json` and `vi.json` simultaneously or TypeScript will fail compilation.
  * *Mitigation:* This strict compile gate is intentional; it prevents shipping half-translated features to Vietnamese beta testers ([Charlotte Nguyen](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L6)).
* **Trade-off 2:** Pluralization rules differ between English (singular/plural) and Vietnamese (classifier words).
  * *Mitigation:* The `formatMessage` utility supports ICU-style pluralization tokens (`{count, plural, one {# message} other {# messages}}`), rendering smoothly in both languages.

