# ADR 0029: Media Parsing & Standardized Attachment Placeholder Synthesis

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 3, 5, 7 [Feature S-3], 11, 14), `docs/decisions/0002-outbox-storage-envelope-encryption.md`, `docs/decisions/0010-message-normalization-filtering-pipeline-feed.md`

---

## 1. Context and Problem Statement

The Chat Bridge specification explicitly places binary file storage and media synchronization out of scope ([Section 3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L76), [Section 5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L119), [Feature S-3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L185)):
- *"Out of scope: Files and images (we send a text line instead, for example `[image: invoice.jpg, 1.2 MB]`)"*
- Unified message schema includes `placeholder?: text` (*"For media, for example `[image: invoice.jpg, 1.2 MB]`"*).
- *"Media becomes a text line."*

### Architectural Challenges & Non-Functional Constraints
1. **Strict Resource Budgets Under High Ingestion Load:**
   - Memory budget: `< 250 MB` idle RSS, `< 400 MB` peak during a 500-message import ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L305-L307)).
   - In WhatsApp (`baileys`), media messages (images, videos, documents, audio) do not contain raw binary files inline; they contain encrypted CDN pointers and cryptographic keys.
   - Downloading, decrypting, and storing binary files (often 10 MB to 50 MB each) would rapidly exhaust system RAM, exceed disk quotas, consume mobile tethered data, and stall event-loop processing.
2. **Preserving Sales Rep Context Without Bloat:**
   - Sales conversations rely heavily on media context (e.g., a customer sending an invoice PDF, bank transfer screenshot, or voice memo).
   - If media is stripped entirely or replaced with a generic `[media]` token, sales reps and CRM operators lose crucial context (e.g., distinguishing between an invoice, a photo of a damaged item, or a 3-minute voice explanation).
3. **Multi-Type Heterogeneity Across Networks:**
   - Both WhatsApp and Zalo support diverse rich media types: photos, voice notes (push-to-talk), general audio files, documents/PDFs, video clips, animated stickers, location pins, and contact cards (vCards).
   - Messages frequently combine binary media with text captions (e.g. an image accompanied by "Here is the payment confirmation").
4. **Data Privacy & Zero Leakage:**
   - Chat Bridge must never store unencrypted thumbnails or leaked media blobs in temporary disk caches ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L346)).

We evaluated three architectural options:
1. **Option 1 (Accepted): Zero-Download Protocol Envelope Metadata Extraction & Canonical Placeholder Grammar.**
2. **Option 2: Low-Resolution Thumbnail Ingestion & Base64 Data URIs.**
3. **Option 3: Generic Static Type Tokens (`[image]`, `[audio]`, `[file]`).**

---

## 2. Decision

We choose **Option 1: Zero-Download Protocol Envelope Metadata Extraction & Canonical Placeholder Grammar**:

```
                       [ Incoming Raw Chat Event ]
                                    |
                    Is media event or contains attachment?
                                    |
                   +----------------+----------------+
                   | Yes                             | No
                   v                                 v
   [ Protocol Envelope Header Inspection ]   [ Standard Text Normalizer ]
   - Baileys: imageMessage, audioMessage,
     documentMessage, videoMessage, etc.
   - Zalo: msgType 2 (photo), 19 (file),
     3 (voice), etc.
   - ZERO binary payload download initiated!
                   |
                   v
   [ Canonical Metadata Synthesizer ]
   - Extract: filename, sizeBytes, durationSec,
     mimeType, coordinates, contact name
   - Format human-readable byte string (KB, MB)
                   |
                   v
   [ Synthesize Canonical Placeholder Token ]
   - e.g.: "[document: invoice_2026.pdf, 1.4 MB]"
   - e.g.: "[voice: 42s]"
   - e.g.: "[location: 10.7769, 106.7009, Ben Thanh Market]"
                   |
                   v
   [ Assemble Unified Message Shape (Section 5) ]
   - Message.text = raw caption text (if present)
   - Message.placeholder = synthesized token
                   |
                   v
   [ Sink Delivery Adaptation ]
   - Margince / Webhook: pass both text and placeholder
   - Google Sheets / Local DB: concatenate "${text} ${placeholder}".trim()
```

### Technical Specification & Implementation Details

1. **Zero-Download Envelope Metadata Extraction:**
   - **WhatsApp (`@whiskeysockets/baileys`):** Inbound messages are inspected for protobuf message sub-types:
     - `imageMessage`: read `mimetype`, `fileLength` (bytes), and caption `caption`.
     - `documentMessage`: read `fileName`, `mimetype`, `fileLength`, and `caption`.
     - `audioMessage`: read `seconds` (duration), `mimetype`, `ptt` (push-to-talk voice note flag).
     - `videoMessage`: read `seconds`, `fileLength`, `mimetype`, and `caption`.
     - `stickerMessage`: read `isAnimated`, `mimetype`.
     - `locationMessage`: read `degreesLatitude`, `degreesLongitude`, `name`, `address`.
     - `contactMessage` / `contactsArrayMessage`: parse vCard text to extract `displayName` and primary `vcard` phone.
     - Under no circumstances is `downloadMediaMessage()` invoked.
   - **Zalo (`zca-js`):** Inbound message JSON payloads are inspected:
     - Photo (`msgType: 2` / `photo`): read `fileSize`, `title` or original filename, and `description`.
     - File (`msgType: 19` / `file`): read `title` (filename), `fileSize`, and `extension`.
     - Voice (`msgType: 3` / `voice`): read `duration` (milliseconds).
     - Location (`msgType: 14` / `location`): read `lat`, `lon`, and `address`.

2. **Standardized Canonical Placeholder Grammar:**
   Placeholders follow a strict bracketed syntax `[<type>: <attributes>]`:
   - **Image:** `[image: <filename>, <human_size>]` (e.g. `[image: screenshot.png, 840 KB]`). If filename is absent, derive from mime-type: `[image: image/jpeg, 1.2 MB]`.
   - **Document:** `[document: <filename>, <human_size>]` (e.g. `[document: quotation_v2.pdf, 320 KB]`).
   - **Voice Memo:** `[voice: <seconds>s]` (e.g. `[voice: 45s]`).
   - **Audio File:** `[audio: <filename>, <seconds>s, <human_size>]` (e.g. `[audio: presentation.mp3, 120s, 3.8 MB]`).
   - **Video:** `[video: <seconds>s, <human_size>]` (e.g. `[video: 30s, 14.5 MB]`).
   - **Location:** `[location: <lat>, <lng>, <label>]` (e.g. `[location: 10.7769, 106.7009, District 1 Branch]`). If label is absent: `[location: 10.7769, 106.7009]`.
   - **Contact Card:** `[contact: <displayName>, <phone>]` (e.g. `[contact: Nguyen Van A, +84901234567]`).
   - **Sticker:** `[sticker]`.

3. **Human-Readable Size Formatter:**
   File sizes are formatted using standard binary units:
   $$\text{Bytes} < 1024 \implies \text{B}, \quad < 1024^2 \implies \text{KB}, \quad \ge 1024^2 \implies \text{MB}$$
   Rounded to one decimal place (e.g. `1,420,500` bytes $\to$ `1.4 MB`).

4. **Caption and Dual-Field Allocation:**
   - If the sender included a text caption alongside the media (e.g. WhatsApp image caption or Zalo file message text):
     - `Message.text` receives the caption text string.
     - `Message.placeholder` receives the bracketed placeholder token.
   - If no caption was provided:
     - `Message.text` is set to `""` (empty string).
     - `Message.placeholder` receives the bracketed token.
   - For sinks that do not support a dedicated placeholder column (such as Google Sheets single text cell or Local SQLite `text` column):
     - The output adapter evaluates:
       $$\text{renderedText} = \begin{cases} \text{placeholder} & \text{if } \text{text is empty} \\ \text{text} + \text{ " " } + \text{placeholder} & \text{otherwise} \end{cases}$$

---

## 3. Rationale and Comparison

| Dimension | Option 1: Zero-Download Envelope Inspection (Accepted) | Option 2: Thumbnail Ingestion & Data URIs | Option 3: Static Generic Tokens (`[image]`) |
| :--- | :--- | :--- | :--- |
| **Scalability & RAM Budget** | **Optimal**: Zero bytes downloaded over network. Envelope parsed in-memory with `< 1 KB` per message. Easily passes `< 250 MB` budget. | **Poor**: Consumes megabytes per burst. Causes GC pressure and risks exceeding `< 400 MB` import limit. | **Optimal**: Zero byte download, but throws away available metadata. |
| **Data Privacy & Leakage** | **Zero binary files** stored on disk or transferred to third-party endpoints. Zero PII media leaks. | **High Risk**: Thumbnail images of private bank slips or IDs cached locally unencrypted. | Zero file leak risk. |
| **Sales Rep Context (UX)** | **High Context**: Sales reps immediately see file names, document types, audio durations, and invoice sizes in Margince. | High context with visual thumbnail, but violates spec out-of-scope rule. | **Severely Degraded**: Rep cannot distinguish a 2-second cough from a 5-minute contract explanation. |
| **Network & Mobile Tethering** | **Zero additional network consumption**. Ideal for reps running on laptop hotspot or cellular data. | Heavy bandwidth consumption downloading media thumbnails. | Zero additional network consumption. |
| **Implementation Complexity** | **Low/Maintainable**: Pure metadata mapping from existing protobuf and JSON event schemas. | **High**: Requires image decoding, resizing, caching, disk garbage collection, and MIME encoding. | Minimal code, but poor user satisfaction. |

---

## 4. Consequences and Mitigations

* **Trade-off 1: Sales reps cannot open or download the original media file directly inside Margince or Google Sheets.**
  * *Mitigation:* This is an intended spec constraint ([Section 3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L76)). The placeholder clearly indicates the document name and timestamp so the sales rep can immediately locate the file directly in their native phone WhatsApp or Zalo app.
* **Trade-off 2: Missing or corrupt metadata in incoming network payloads (e.g. third-party clients stripping file names).**
  * *Mitigation:* Implement defensive fallbacks: if `fileName` is undefined, fallback to MIME-type (`[image: image/png, 450 KB]`); if `fileLength` is undefined or 0, omit size (`[image: image/png]`); if all metadata is missing, fallback to base token (`[image]`).
* **Trade-off 3: Location and Contact privacy concerns.**
  * *Mitigation:* Contact card phone numbers and location coordinates pass through Stage 4 Privacy Filters ([ADR 0010](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0010-message-normalization-filtering-pipeline-feed.md)). If phone number redaction is enabled, contact card phone numbers are redacted (`+8490****567`).

