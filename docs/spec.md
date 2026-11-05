# Chat Bridge: Product Specification

**Owner:** Tam Vu (stakeholder) · **Version:** 0.5, 1 Nov 2026
**Based on:** [*Chat Bridge PoC: Zalo & WhatsApp into Margince*](./Approved-Proposal-Chat%20Bridge%20PoC%20-%20Zalo%20&%20WhatsApp%20into%20Margince.md), **approved by the Margince team** as the scope of work.
**Stakeholder and spec owner:** Tam Vu (also builds the Margince openchannel PR) · **Beta tester:** Charlotte Nguyen

This is the **source of truth** for the Month 2 product.
It goes into the product repo as `docs/spec.md`.
Every GitHub issue names the feature ID it builds (for example `K-4`).
Questions go to Tam Vu. Answers are added to this file.

**What changed in 0.5:** sinks are plug-ins behind one **sink interface**, and the rep can turn on **several at once**. Margince is one sink; **Google Sheets** and a **local database** are Must too. The webhook stays "if time allows". Tam Vu owns the spec.

**What changed in 0.4:** the proposal is approved. The goal is now a **sales rep** who is **not technical**.
Margince is the main sink and arrives early, not last. An installable desktop app and a setup wizard are in scope.
Webhook, Google Sheet, replies and the MCP server move to "if time allows".

---

## 1. What is Chat Bridge?

Chat Bridge is an **open-source app (MIT licence, public GitHub repo)** that a sales rep installs **on their own computer**.

1. The rep connects their personal **WhatsApp** and **Zalo** by scanning a QR code with their phone.
2. The rep **chooses** which chats may leave the computer, and sets simple **filters**.
3. Chat Bridge **sends** the chosen messages to **Margince CRM**, where they appear on the customer's timeline, and to any other sink the rep turns on (Google Sheets, a local database).

Zalo and WhatsApp have no official API for personal accounts.
So the app uses unofficial libraries: **zca-js** (Zalo) and **Baileys** (WhatsApp).
This risky code stays in Chat Bridge, never inside Margince.

**Who builds what:**

```
  MARGINCE (Tam Vu)                      CHAT BRIDGE (the 6 interns)
  -----------------                      ---------------------------
  one PR: openchannel extension          the app on the rep's computer
  push, pull, ack edges                  sources, filters, outbox
  phone as a merge key (suggest only)    sinks (Margince, Sheets, DB), wizard,
  default rights for reps                installer, CLI, local web UI
              ^                                      |
              +------------- push (signed) ----------+
```

Until Tam's PR is merged, the interns test against a **mock Margince server** that speaks the same protocol (section 8).

## 2. Who uses it

| User | Wants | Success |
| --- | --- | --- |
| **A sales rep (main user, not technical)** who chats with customers on Zalo or WhatsApp | Customer chats in Margince with no copy-paste, set up alone | Installs and connects both apps in **under 15 minutes, with no help** and no terminal. Every chosen message reaches Margince once |
| The same rep, careful about privacy | Only work chats leave the computer | Nothing is sent until they pick chats. Family and private chats never leave |
| A developer or tester | Script and test the app | The same engine through the CLI, with `--json` output |

**Design rule for the main user:** no terminal, no config files, no jargon.
Every screen says what to do next in one plain sentence. Every error says what happened and what to click.

## 3. Scope

**Must (the final check on Fri 27 Nov):**
the engine; sources Fake, Zalo and WhatsApp (personal and the Business app); the chat picker and filters;
the encrypted outbox; the **sink interface with several sinks at once**: local archive, **local database**, **Google Sheets** and **Margince (push)**; the **setup wizard**;
an **installable desktop app** for macOS and Windows (unsigned beta); the CLI.

**Should (if time allows, in this order):**

1. Replies from Margince, sent with one human click (pull + ack).
2. Vietnamese UI text next to English.
3. A read-only MCP server.
4. Webhook sink.

**Out of scope:**

- The Margince server change (the openchannel PR). **Tam Vu** builds it. The interns do not change Margince.
- Code signing of the desktop app (comes before a public release).
- Files and images (we send a text line instead, for example `[image: invoice.jpg, 1.2 MB]`).
- The official WhatsApp Business API.
- Automatic or bulk sending. **Never.**

## 4. How it fits together

```
 SOURCES               ENGINE                              SINKS (one interface, many targets)
 -------               ------                              -----------------------------------
 Fake (test data) --+                                    +--> Local archive (file)
 Zalo (zca-js)    --+--> normalise --> drop noise -->    +--> Local database (SQLite)
 WhatsApp         --+    + one id      --> chat picker   +--> Google Sheets
 (Baileys)               per person        + filters --> +--> Margince (push; pull + ack: "should")
                                           --> outbox    +--> Webhook ("should")
                                              (encrypted,     ... any new sink: same interface,
                                               one queue         no engine change
                                               per sink)

 The rep uses:     desktop app = setup wizard + local web UI
 Developers use:   CLI (same engine)
```

The rep turns on **one or more** sinks. Each message goes to **every** sink that is on.
Each sink has its own queue and status, so a sink that is down never blocks the others.

## 5. The message

Every source turns a chat event into **one message** with this shape.
Every sink receives this shape.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | text | `<network>:<account>:<native id>`. Unique. Used to remove duplicates |
| `network` | `zalo`, `whatsapp`, `whatsapp-biz` or `fake` | |
| `account` | text | The rep's own account on that network |
| `thread` | text | The chat id (a group or a 1:1 chat) |
| `threadKind` | `dm` or `group` | |
| `direction` | `inbound` or `outbound` | `outbound` = the rep sent it |
| `time` | date-time with timezone (ISO 8601) | When the network says it was sent |
| `from` | person | `{ accountId, displayName, phone? }`. `phone` only if the network gave it, never guessed |
| `to` | list of persons | For a 1:1 chat |
| `participants` | list of persons | For a group, max 50. More than 50: leave it out |
| `text` | text | Max 32,768 characters. Longer: cut it and set `truncated: true` |
| `placeholder` | text, optional | For media, for example `[image: invoice.jpg, 1.2 MB]` |

## 6. Plug-in contracts

A **provider** is a source or a sink.
Each provider is its own module and follows one contract.
So a new provider **never changes the engine**.

```
                  +------------------+
  Source A  ----> |                  | ----> Sink 1
  Source B  ----> |      ENGINE      | ----> Sink 2
  Source C  ----> |                  | ----> Sink 3
                  +------------------+
       ^ source contract        ^ sink contract
```

**Source contract:**

| Function | What it does |
| --- | --- |
| `login()` | Shows a QR code or pairing code in the wizard, the web UI and the CLI. Saves the session, encrypted |
| `start(onMessage)` / `stop()` | Starts and stops reading messages |
| `status()` | `connected`, `needs-login`, `taken-over` or `error`, with a plain-language reason |
| `chats()` | Lists the rep's chats (name, DM or group, last message time) for the chat picker |
| `history(since)` | Gives older messages with a progress count (if the network allows) |
| `send(thread, text)` | Sends a reply. **Only after a human clicked Send** ("should" scope) |

**Sink contract:**

| Function | What it does |
| --- | --- |
| `configure(settings)` | Checks its settings. Gives a clear error for each wrong field |
| `test()` | One safe call that proves the settings work. The wizard shows the answer in plain words |
| `deliver(batch)` | Returns one result per message: `accepted`, `duplicate`, or `refused` + reason |
| `health()` | `ok`, `degraded` or `down`. Shown in the UI |
| `pullReplies(max)`, `ack(results)` | Optional. Only for sinks that send replies back (Margince, "should" scope) |
| limits | Each sink says its batch size and requests per minute. The engine stays under them. On HTTP 429 ("slow down") it waits |

**Several sinks at once:** the engine keeps **one outbox queue per sink**. A message counts as done only when every active sink has answered `accepted` or `duplicate`. Retries, pacing and health are per sink. A new sink is a new module behind this contract, plus contract tests; the engine does not change.

## 7. Features

Each feature has an **ID** and **acceptance criteria** (how we know it works). The PM interns put the features into sprints.
Every feature ships in the **web UI** (what the rep sees) and the **CLI** (what tests and developers use) at the same time.

### Core (C)

| ID | Feature | Done when |
| --- | --- | --- |
| C-1 | Status | The UI home screen and `chat-bridge status` show each source, each sink, how many messages wait per sink, and the last problem in plain words |
| C-2 | Filters | Groups off by default; block a contact; drop by text pattern (OTP codes are on by default); hide phone numbers. **Given** a blocked contact, **when** they write, **then** nothing reaches any sink and the feed marks it "filtered" |
| C-3 | Outbox | Encrypted SQLite. Key from the OS key store (Keychain on macOS, DPAPI on Windows, a key file with 0600 rights on Linux for CI). One queue per sink. **Given** a sink is down, **when** messages arrive, **then** they wait for that sink, and each is delivered to it **exactly once** when it is back |
| C-4 | Drop noise | Stories (`status@broadcast`), newsletters, reactions, edits and typing events never reach a sink |
| C-8 | Chat picker | The rep sees a list of their chats and ticks the ones to send. **Nothing leaves the computer until at least one chat is ticked.** New chats start unticked. The feed has "send these messages" for a one-off push of selected messages |
| C-5 | Pacing and retries | Stays under Margince's limits. On 429 or a network error: wait, then retry. A refused message is not retried; its reason is shown |
| C-6 | One id per person | WhatsApp: keep a local LID-to-phone map, so one person seen by phone and by LID is sent with **one** id |
| C-7 | Warnings | Warn before the WhatsApp 14-day logout, and when Zalo Web takes over the session. A banner in the UI and a desktop notification, each with the one thing to do |
| C-9 | App health | The engine measures its own CPU, memory, queue size per sink, messages per minute and errors. `chat-bridge status --json` returns them; the UI shows a plain "App health: good / slow / problem" line, with the numbers one click away |

### Sources (S)

| ID | Feature | Done when |
| --- | --- | --- |
| S-1 | Fake source | Replays fake test chats (DMs, a group, noise, an OTP message, a 40,000-character message) at a set speed. **All automated tests use it** |
| S-2 | Zalo | QR login in the UI. A new message shows in the feed within 5 seconds. Sender id = `uidFrom`. `getUserInfo` is called once per new sender, then cached |
| S-3 | WhatsApp and WhatsApp Business app | QR or pairing-code login. Messages show in the feed. History import of the ticked chats, with a progress bar. Media becomes a text line. A phone number is sent only if WhatsApp gave it |

### Sinks (K)

| ID | Feature | Done when |
| --- | --- | --- |
| K-0 | Sink interface, several at once | One contract for every sink (section 6). The rep turns sinks on and off in Settings. Each message reaches every active sink once; one sink down never blocks the others; each sink shows its own status and counts |
| K-1 | Archive (local file) | One JSONL file per day. Each message once. The UI archive page searches by text, contact and date. Works with no other sink |
| K-5 | Local database | Messages in a local SQLite database file, one row per message, with a documented table layout so other tools can read it. Each message once (by `id`) |
| K-3 | Google Sheets | The rep signs in with Google and picks a sheet. One row per message; stays under the Sheets API limit. No write access: a plain error and what to click |
| K-4 | Margince (push) | The rep pastes the connection string from Margince once. Batched, signed push (section 8). First against the **mock Margince server**, then against a real Margince with Tam's PR (local or staging), once it is merged |

### Interfaces (I)

| ID | Feature | Done when |
| --- | --- | --- |
| I-1 | CLI | The commands in section 9. `--json` output. Exit code 0 = OK; not 0 = error with a message |
| I-2 | Local web UI | Runs on `localhost` only. New screens as features ship (section 10). Works on a 375 px wide screen |
| I-4 | Setup wizard | First start opens a wizard: **1** connect WhatsApp, **2** connect Zalo (each can be skipped), **3** tick chats, **4** check filters, **5** choose where to send (Margince, Google Sheets, local database; one or more), fill in each one (for Margince, paste the connection string) and press "Test". Each step can be redone later from Settings |
| I-5 | Desktop app | A download for macOS and Windows. Double-click installs it; it starts the engine and opens the wizard. No terminal. Unsigned beta, with a one-page install guide (with screenshots) for the "unknown developer" warning |

### Should (if time allows)

| ID | Feature | Done when |
| --- | --- | --- |
| R-1 | Replies inbox | Replies from Margince show in a UI inbox (pull) |
| R-2 | One-click send | A reply is sent only after **one human click**. Acked as `sent`, or `failed` + reason. Never retried automatically |
| L-1 | Vietnamese UI | Every screen in English and Vietnamese, switchable |
| I-3 | MCP server | stdio or HTTP on localhost. Tools: list threads, search messages, read a thread. Send is **off by default** and asks every time |
| K-2 | Webhook | Sends signed batches of messages as JSON to a URL the rep gives |

## 8. Talking to Margince

Chat Bridge always **calls out** to Margince. Margince never calls Chat Bridge.
So the rep needs no public address and no tunnel, and it works behind any home router.

```
  Chat Bridge                                   Margince
      |                                             |
      |--- PUSH: new messages -------------------->|  accepted / duplicate / refused
      |                                             |
      |--- PULL: "any replies for me?" ----------->|  (should)
      |<-- replies waiting -------------------------|
      |   (human clicks Send)                       |
      |--- ACK: sent / failed + reason ----------->|  (should)
```

| Call | Address | Body | Answer |
| --- | --- | --- | --- |
| Push | `POST /webhooks/ext/openchannel/receive/{ref}` | A list of messages (section 5) | One result per message |
| Pull | `POST /webhooks/ext/openchannel/pull/{ref}` | How many replies you want | The waiting replies: delivery id, network, thread, recipient, text |
| Ack | `POST /webhooks/ext/openchannel/ack/{ref}` | Delivery id + `sent` or `failed` (with reason) | Recorded |

**Signature:** HMAC-SHA256 over a scope string, the slug, the ref, the time, a one-time number (nonce) and the body.
Each address has its own slug, so a push signature cannot be reused as a pull.

**Margince limits:** 60 requests/minute per IP · 120 per endpoint · 1,000 waiting per endpoint · 32,768 characters per text · 50 people per group.

**Contract with Tam's PR:** the envelope is published in the Chat Bridge repo (`docs/protocol.md`) as the bridge's own protocol.
The mock Margince server and the real one must pass the **same contract tests**. Any change to the envelope is agreed with Tam first and logged as a decision.

**What the rep sees in Margince:** after Tam's PR, a phone match makes a **review card**; a human confirms it, then the chat account is bound to the contact. So a first message from a new number may wait for that confirmation. The wizard says so.

## 9. CLI commands

```
chat-bridge status
chat-bridge chats [list | pick <id> | unpick <id>]
chat-bridge filters [show | set <key> <value> | block <id>]
chat-bridge login zalo | whatsapp | whatsapp-biz
chat-bridge sink add archive | database | sheet | margince "<paste string>"
chat-bridge sink test | list | remove <name>
chat-bridge run [--fake <test-data>]
chat-bridge history import <network> [--since <date>]
chat-bridge ui
```

## 10. Web UI screens

```
  +------------------------------------------------------------+
  | Chat Bridge      [Home] [Chats] [Feed] [Filters] [Settings] |
  +------------------------------------------------------------+
  | ! Open WhatsApp on your phone in the next 2 days,          |
  |   or this computer will be logged out.          [How?]     |
  +------------------------------------------------------------+
  |  WhatsApp   connected      Margince   sending ok           |
  |  Zalo       connected      Waiting    3 messages           |
  |                                                            |
  |  12 chats picked · 148 messages sent today                 |
  +------------------------------------------------------------+
```

| Screen | Shows |
| --- | --- |
| Home | Sources and each sink with status, messages waiting, last problem in plain words |
| Where to send | The sinks (called "where to send" on screen): turn each on or off, test it, see its counts |
| Feed | Messages as they arrive: sent, filtered, dropped or waiting. Select messages and "send these" |
| Filters | All filters, with a preview of what they block |
| Archive | Search by text, contact and date |
| Wizard | The five setup steps (I-4); step 5 picks where to send |
| Chats | All chats with a tick box, a search, and "last message" time |
| Logins | QR codes for Zalo and WhatsApp; session status |
| Import | Pick chats and a start date; progress bar, pause, resume |
| Warnings | Banner for the 14-day rule and for a Zalo Web takeover |

## 11. Quality rules (non-functional)

- **Easy for non-tech users:** set up alone in under 15 minutes (tested in section 13). No terminal. Plain words, no jargon (no "sink", "outbox" or "JID" on screen). Every error names the next click.
- **Privacy:** nothing leaves the computer until the rep ticks a chat. Only messages that pass the filters leave, and only to sinks the rep added. No tracking.
- **Security:** sessions, the outbox and the Margince secret are encrypted on disk. The UI listens on `localhost` only. Every call to Margince is signed.
- **Reliability:** a crash, a reboot or a closed laptop loses no message that reached the outbox. Delivery is "at least once"; Margince removes duplicates by `id`.
- **Account safety:** read first, send by hand. No automatic sending. Calls to Zalo and WhatsApp are slowed down so accounts are not flagged.
- **Speed:** importing 500 messages stays under Margince's limits, with no unhandled 429.
- **Performance and resources** (starting budgets for the engine process, measured in CI with the fake source and mock sinks; Group A (QC) sets the real baseline in the first week, and Tam Vu agrees any change):

  | What | Budget |
  | --- | --- |
  | Start, from launch to the wizard or home screen | under 5 s |
  | CPU when connected and idle (5-minute average) | under 2% of one core |
  | Memory (RSS) when idle | under 250 MB |
  | 500-message import: time from source to every active sink, 95th percentile | under 5 s per message |
  | 500-message import: peak memory | under 400 MB |
  | Long run, 2 hours of fake traffic: memory growth | under 10%, and no queue that keeps growing |
  | Any PR | no number more than 10% worse than `main` |
- **Platforms:** macOS and Windows for reps. Linux for CI.

## 12. Sprint plan

The **PM interns** design the sprints, their goals and the Friday demos, from the Must list in section 3, with both teams.

Fixed dates:

| Date | What happens |
| --- | --- |
| Mon 2 Nov | Kickoff; the spec and the sprint plan handed over |
| Fri 13 Nov | Half-way: joint live demo |
| Fri 27 Nov | Final: the acceptance list in section 13, starting with the usability test |

Two rules for any plan: Margince comes early (on the mock server first), and the desktop installer and a usability dry run come before the final.

## 13. Final acceptance list (checked live on Fri 27 Nov)

- [ ] **Usability test:** Charlotte Nguyen (beta tester), who has not seen the app, installs it from the download page, connects their WhatsApp and Zalo, picks one chat, and sees its messages in Margince, **alone, in under 15 minutes**. Recorded on video.
- [ ] The desktop app installs on macOS and on Windows by double-click, and opens the wizard.
- [ ] A Zalo message in a picked chat reaches Margince once. A message in an unpicked chat never leaves the computer.
- [ ] With Margince, Google Sheets and the local database all on, one message reaches each of them once. With one of them down, the others still get it, and the down one catches up when it is back.
- [ ] A WhatsApp message does the same. One person seen by phone and by LID stays one account.
- [ ] Filters work: a blocked contact, a group (off by default) and an OTP message never leave the computer.
- [ ] Noise (a reaction, an edit, a story) never leaves the computer.
- [ ] With Margince unreachable, messages wait and arrive exactly once when it is back, also after a restart.
- [ ] A 500-message import of picked chats stays under the limits and shows a progress bar.
- [ ] A replayed (old) Margince call is refused. The mock and the real Margince pass the same contract tests.
- [ ] Sessions, the outbox and the Margince secret are encrypted on disk.
- [ ] Every screen has plain-language text, and every error tells the user what to click.

## 14. Rules for the people building it

**Accounts and data:**

- Chat Bridge is built for personal accounts, so **feel free to test with your own Zalo and WhatsApp**. Keep what you capture clean: no real names, phone numbers or messages in the repo, issues or screenshots. Never use a customer's account.
- **No real chat data in the repo:** no real phone numbers, names or messages in test data, screenshots, issues or logs.
- The AI agent **never** holds a chat login or a password. It works only with the fake source and the mock Margince server.
- The interns do not change Margince. A problem with the protocol goes to Tam as an issue.

**Quality bar** (CI checks these on every change):

- **Test first.** Group B's agent writes unit and integration tests before the code (TDD). Each feature PR shows a red run, then a green run.
- **Guards** (Group A, in `guards/`): no import cycles · the engine reaches sources and sinks only through their contracts · no dead code or unused exports · size limits per file and per function · a comment budget, no commented-out code, no `TODO` without an issue link.
- **Design system** (web UI): colours, spacing and fonts only from the tokens file · only shared components · every screen passes an accessibility check · a word list guard: no jargon on screen.
- **User stories are tested end to end.** Each feature in section 7 has a Playwright test from the user's point of view, including the full wizard (Group A).

## 15. Open questions

- Does Zalo's `getUserInfo` give a phone number for a stranger, or only for friends? Test it early.
- Is a Zalo user id the same when seen from two different accounts? Also test zca-js `globalId`.
- When will Tam's PR be merged, and on which Margince (local, staging)? If it is not merged in time, K-4 is accepted with the mock server.
- Attachments: in Tam's PR or a second one? (Open in the approved proposal.) Out of scope for the interns either way.
- Which repo owner: a maintainer's personal GitHub account (proposal decision 3). Tam Vu confirms before Mon 2 Nov.

## 16. Words we use

| Word | Meaning |
| --- | --- |
| Source | A chat network the app reads: fake, Zalo, WhatsApp |
| Sink | A place the app sends messages to, behind one interface: local archive, local database, Google Sheets, Margince, webhook. Called "where to send" on screen |
| Provider | A source or a sink |
| Chat picker | The list where the rep ticks which chats may leave the computer |
| Outbox | The encrypted local queue between the filters and the sinks |
| LID | WhatsApp's linked id. Some people show a LID instead of a phone number |
| Push / Pull / Ack | Send messages to Margince / ask for replies / report if a reply was sent |
| Nonce | A one-time random number, so an old request cannot be sent again |
| openchannel | The Margince extension that receives the bridge's calls. Tam Vu's PR |
