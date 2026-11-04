# ADR 0003: Google Sheets Sink — Native Desktop OAuth 2.0 & REST API v4

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 3, 6, 7 [K-3, I-4], 11, 13)

---

## 1. Context and Problem Statement

Feature **K-3** in `docs/spec.md` mandates:
> *"The rep signs in with Google and picks a sheet. One row per message; stays under the Sheets API limit. No write access: a plain error and what to click."*

Additionally, the setup wizard (**Feature I-4**) requires a frictionless setup for non-technical sales reps (*"under 15 minutes, with no help, no terminal, no config files"*).

We evaluated four possible integration architectures:
1. **Desktop OAuth 2.0 Loopback + Google Sheets REST API v4:** Direct user authentication with official REST endpoints.
2. **Google Apps Script Webhook:** Target sheet runs a custom Apps Script web app endpoint (`doPost`).
3. **OAuth 2.0 Device Authorization Flow (RFC 8628):** Manual 8-character code verification on `google.com/device`.
4. **Shared Service Account:** Centrally managed Google Cloud Service Account shared with the rep's sheet.

---

## 2. Decision

We choose **Option 1: Desktop OAuth 2.0 with PKCE (Loopback Flow) directly targeting the Google Sheets REST API v4**:

1. **Authentication Flow:**
   * When the rep clicks *"Sign in with Google"* in the Wizard or Settings, the app spins up an ephemeral HTTP loopback listener on `http://127.0.0.1:<random_port>/oauth2callback`.
   * The app opens the system browser to Google's OAuth consent screen with PKCE (`code_challenge`).
   * Upon authorization, Google redirects to the local loopback listener.
   * The app exchanges the authorization code for an `access_token` and `refresh_token`, terminates the loopback listener, and securely stores the `refresh_token` encrypted inside the **SQLCipher** database.
2. **Sheet Target Selection:**
   * The rep pastes their Google Sheet URL (e.g. `https://docs.google.com/spreadsheets/d/<spreadsheetId>/edit`), and the app extracts the ID.
   * The app calls `test()` by querying `spreadsheets.get` to verify metadata and write permissions.
   * *Plain-Language Guard:* If permission fails, the UI displays a clear next-step message:  
     *"You don't have permission to edit this sheet. Open the spreadsheet, click 'Share' in the top right, and ensure your account has Editor access."*
3. **Delivery & Batching:**
   * Messages are formatted into standard row arrays:  
     `[Message ID, ISO Timestamp, Network, Chat/Thread, Sender Name, Sender Phone, Direction, Text, Truncated Flag]`
   * Messages are batched into `spreadsheets.values.append` requests (up to 50–100 messages per request, `valueInputOption: "USER_ENTERED"`).
   * Stays safely under the Google user quota (60 write requests per minute per user).
   * On HTTP 429 (`RESOURCE_EXHAUSTED`), the outbox applies exponential backoff with jitter without blocking other active sinks.
4. **Automated Testing & CI:**
   * In automated test suites and CI, the sink communicates with a **Mock Google Sheets Server** running locally, ensuring 100% offline determinism and zero dependency on live Google infrastructure.

---

## 3. Rationale and Scalability Comparison

* **Horizontal User Scalability:**  
  Google enforces a quota of 60 write requests per minute *per user*. By authenticating each sales rep with their own Google account, every rep gets an independent 60 writes/min quota pool. Scaling from 1 to 500 reps introduces zero contention.
* **Avoidance of Apps Script Bottlenecks:**  
  Google Apps Script has severe operational walls: a daily execution cap of only 90 minutes/day for standard Google accounts, a hard limit of 30 concurrent executions, and high latency (1.5–3.0 seconds per call). The official REST API has no daily runtime cap, handles high concurrency, and executes in ~200 ms.
* **Avoidance of Service Account Quota Contention:**  
  A shared Service Account bottlenecks all reps behind a single project quota and requires company IT administration.
* **Consumer-Grade UX:**  
  The browser loopback flow is the industry standard for desktop apps (Slack, VS Code, Spotify), providing a familiar 1-click authorization without manual code copy-pasting.

