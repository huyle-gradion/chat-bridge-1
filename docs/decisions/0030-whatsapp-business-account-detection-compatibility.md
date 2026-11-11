# ADR 0030: WhatsApp Business Account Detection, Compatibility & Interactive Message Normalization

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 3, 5, 7 [Feature S-3, C-4], 9, 14), `docs/decisions/0006-connector-session-persistence-identity.md`, `docs/decisions/0010-message-normalization-filtering-pipeline-feed.md`, `docs/decisions/0026-whatsapp-pairing-code-handshake-multi-device-login.md`

---

## 1. Context and Problem Statement

The Chat Bridge specification mandates support for both standard personal WhatsApp and the WhatsApp Business mobile application ([Section 3](../spec.md#L60), [Section 7 Feature S-3](../spec.md#L185)):
- *"WhatsApp and WhatsApp Business app: QR or pairing-code login. Messages show in the feed. History import of the ticked chats, with a progress bar."*
- Section 5 defines the unified message schema field:  
  `network: 'zalo' | 'whatsapp' | 'whatsapp-biz' | 'fake'`
- Section 9 lists CLI commands:  
  `chat-bridge login zalo | whatsapp | whatsapp-biz`

### Underlying Architectural Challenges
1. **Identical Underlying Wire Protocol:**
   - Both personal WhatsApp accounts and WhatsApp Business accounts connect using the identical WhatsApp Web multi-device WebSocket protocol (`@whiskeysockets/baileys`).
   - The cryptographic Noise handshake, session registration, QR codes, pairing codes, and end-to-end Signal cipher keys are identical across both account types.
2. **User Confusion & Accidental Misconfiguration:**
   - Sales reps frequently do not know or distinguish whether their phone number is registered under standard WhatsApp or the WhatsApp Business app.
   - If Chat Bridge requires users to select between two separate connector types upfront, a rep selecting `chat-bridge login whatsapp` with a Business phone would either trigger authentication failures or produce an incorrect `network: 'whatsapp'` tag instead of `whatsapp-biz`.
3. **Business-Specific Interactive Payloads:**
   - WhatsApp Business accounts receive distinct, rich protobuf message structures that standard personal accounts rarely encounter:
     - Product Catalog inquiries (`productMessage`).
     - Interactive button responses (`buttonsResponseMessage`, `templateButtonReplyMessage`).
     - List selection messages (`listResponseMessage`).
     - Order status notifications.
     - Broadcast distribution lists (`@broadcast`).
4. **Noise Rejection Mandate ([Feature C-4](../spec.md#L172)):**
   - Business broadcast lists and newsletters must be dropped immediately and must never reach any destination sink.

We evaluated three architectural options:
1. **Option 1 (Accepted): Unified Baileys Connector with Dynamic Handshake Auto-Detection & Interactive Message Flattener.**
2. **Option 2: Strict Connector Bifurcation (Independent Personal & Business Driver Classes).**
3. **Option 3: Single Undifferentiated `whatsapp` Network Classification (Omitting `whatsapp-biz`).**

---

## 2. Decision

We choose **Option 1: Unified Baileys Connector with Dynamic Handshake Auto-Detection & Interactive Message Flattener**:

```
                       [ QR Code / Pairing Code Login ]
                                       |
                       [ Baileys WebSocket Handshake ]
                                       |
                       [ Inspect Account Credentials ]
                         conn.authState.creds.me
                                       |
                      Does account have business flag?
                      (creds.me.isBusiness || biz_name)
                                       |
                      +----------------+----------------+
                      | Yes                             | No
                      v                                 v
          [ Set network = 'whatsapp-biz' ]     [ Set network = 'whatsapp' ]
                      \                                 /
                       \                               /
                        v                             v
                         [ Unified Inbound Event Stream ]
                                        |
                         [ Inbound Message Normalizer ]
                                        |
               Is Business Interactive Payload? (product, list, buttons)
                                        |
                      +-----------------+-----------------+
                      | Yes                               | No
                      v                                   v
          [ Business Payload Flattener ]          [ Standard Text / Media ]
          - productMessage -> [product: ...]
          - buttonReply -> extract button text
          - broadcastList -> Stage 2 Drop (C-4)
                                        |
                                        v
                       [ Unified Message Shape (Section 5) ]
```

### Technical Specification & Implementation Details

1. **Dynamic Account Tier Detection:**
   - A single connector implementation resides in `packages/sources/whatsapp`.
   - When the Baileys socket reaches the `creds.update` or `connection.update` event (`status: 'open'`), the connector inspects the authenticated user descriptor:
     ```typescript
     const me = sock.authState.creds.me;
     const isBusiness = Boolean(me?.isBusiness || (sock.user as any)?.biz_name);
     this.detectedNetwork = isBusiness ? 'whatsapp-biz' : 'whatsapp';
     ```
   - This value is persisted in the encrypted connector session storage ([ADR 0006](0006-connector-session-persistence-identity.md)).
   - Both CLI commands (`chat-bridge login whatsapp` and `chat-bridge login whatsapp-biz`) route to the same login procedure, setting an initial hint but allowing live protocol credentials to deterministically set the true `network` tag.

2. **Interactive Business Payload Normalization:**
   The inbound event normalizer transforms specialized WhatsApp Business protobufs into the unified `Message` structure:
   - **Catalog / Product Messages (`productMessage`):**
     - Extract product title, currency, price, and merchant JID:
       ```typescript
       const title = msg.productMessage?.product?.title ?? 'Product';
       const priceAmount = (msg.productMessage?.product?.priceAmount1000 ?? 0) / 1000;
       const currency = msg.productMessage?.product?.currencyCode ?? 'VND';
       message.placeholder = `[product: ${title}, ${priceAmount.toLocaleString()} ${currency}]`;
       message.text = msg.productMessage?.body ?? '';
       ```
   - **Interactive Button Replies (`buttonsResponseMessage`, `templateButtonReplyMessage`):**
     - Flatten to the selected button label text:
       ```typescript
       message.text = msg.buttonsResponseMessage?.selectedDisplayText 
         ?? msg.templateButtonReplyMessage?.selectedDisplayText 
         ?? '';
       ```
   - **List Selection Responses (`listResponseMessage`):**
     - Flatten to the selected row title and optional description:
       ```typescript
       const title = msg.listResponseMessage?.title ?? '';
       const desc = msg.listResponseMessage?.description ? ` - ${msg.listResponseMessage.description}` : '';
       message.text = `[selected: ${title}${desc}]`;
       ```

3. **Broadcast List & Newsletter Filtering ([Feature C-4](../spec.md#L172)):**
   - In WhatsApp Business, distribution lists are identified by JID suffix `@broadcast` or `status@broadcast`.
   - The Stage 2 Noise Dropper ([ADR 0010](0010-message-normalization-filtering-pipeline-feed.md)) rejects any message whose `thread` matches:
     ```typescript
     if (msg.thread.endsWith('@broadcast') || msg.thread.endsWith('@newsletter')) {
       return { drop: true, reason: 'noise_broadcast_channel' };
     }
     ```

---

## 3. Rationale and Comparison

| Dimension | Option 1: Dynamic Handshake Auto-Detection (Accepted) | Option 2: Strict Dual Connector Bifurcation | Option 3: Undifferentiated `whatsapp` Only |
| :--- | :--- | :--- | :--- |
| **Code Hygiene & Footprint** | **Single maintainable codebase**. Zero duplicated Baileys lifecycle and socket code. | High duplication: two parallel driver classes maintaining separate socket states. | Simplest code, but loses network granularity. |
| **User Experience (UX Guard)** | **Zero configuration friction**: User never gets blocked by picking the wrong login type. | High friction: Reps who don't know their account tier encounter errors. | Rep cannot configure different sink routing for business vs personal chats. |
| **Downstream Sink Compatibility** | Margince and analytical databases can accurately partition business vs personal customer interactions. | Accurate partitioning, but brittle authentication flow. | **Fails Spec Schema**: Downstream CRM cannot distinguish business channels. |
| **Interactive Payload Handling** | Cleanly normalizes product catalogs and button selections without data loss. | Supported, but requires duplicate normalization implementations. | Drops or mangles interactive business message payloads. |

---

## 4. Consequences and Mitigations

* **Trade-off 1: Account migration from personal WhatsApp to WhatsApp Business app.**
  * *Mitigation:* When a user converts their phone number from personal to Business in the WhatsApp mobile app, the multi-device session re-validates upon the next connection event. The connector updates `this.detectedNetwork` automatically and saves the new network tag to session metadata.
* **Trade-off 2: Margince or Sink identity collision if both apps share the same phone number.**
  * *Mitigation:* WhatsApp does not permit the same phone number to be simultaneously registered on both WhatsApp Personal and WhatsApp Business mobile apps on the same device. Therefore, a single physical phone number always maps to exactly one active account type at any given time.
* **Trade-off 3: CLI command user expectation.**
  * *Mitigation:* `chat-bridge login whatsapp-biz` is retained as a valid CLI command and alias to satisfy Section 9, but it logs an informational note: *"Connecting WhatsApp... auto-detecting Business account profile"*.

