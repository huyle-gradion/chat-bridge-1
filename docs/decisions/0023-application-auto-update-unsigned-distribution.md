# ADR 0023: Application Auto-Update Architecture & Unsigned Beta Distribution

* **Status:** Accepted
* **Date:** 2026-11-05
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 2, 7 [Feature I-5], 11, 13, 14), `docs/decisions/0001-desktop-shell-architecture.md`, `docs/decisions/0012-desktop-packaging-native-toolchain-keystore.md`, `docs/decisions/0021-desktop-process-lifecycle-sleep-wake-tray.md`

---

## 1. Context and Problem Statement

Chat Bridge targets non-technical sales representatives installing an installable desktop application on macOS and Windows ([Section 2](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L47), [Feature I-5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L204)):
- *"A download for macOS and Windows. Double-click installs it; it starts the engine and opens the wizard. No terminal. Unsigned beta, with a one-page install guide (with screenshots) for the 'unknown developer' warning."*
- Fast startup budget (< 5s), idle RAM budget (< 250 MB), and strict privacy rules: zero telemetry, zero analytics to third parties, local-first ([Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L309)).

### Architectural Challenges of Unsigned Distribution
1. **Operating System Quarantine & Code Signing Enforcement:**
   - **macOS Gatekeeper:** macOS flags downloaded files with `com.apple.quarantine`. For unsigned binaries, default `electron-updater` (Squirrel.Mac) fails with fatal error `OSStatus -67062: code signature invalid` because macOS refuses to dynamically replace app bundles in `/Applications` without an Apple Developer ID signature.
   - **Windows SmartScreen:** Windows Defender SmartScreen blocks unrecognized unsigned executables with an *"Unknown Publisher"* warning dialogue requiring the user to click *"More info -> Run anyway"*.
2. **Supply-Chain Integrity Without Commercial Code Signing:**
   - Because the initial beta releases do not have paid Apple (\$99/yr) or Microsoft Authenticode (\$300–\$500/yr) certificates, update manifests downloaded over HTTPS could theoretically be vulnerable to DNS spoofing or repository tampering if not cryptographically signed.
3. **Zero Telemetry & User Disruption Constraints:**
   - Update checks must never send device fingerprinting, IP telemetry, or user metrics to third-party servers.
   - Background engine processing (delivering queued messages from the outbox) must never be abruptly killed mid-flight by an auto-updater.

We evaluated three architectural approaches:
1. **Option 1: Standard Electron-Updater with GitHub Provider.**
2. **Option 2 (Accepted): Native In-App Download with GitHub Releases Manifest, Ed25519 Cryptographic Verification & Platform-Adaptive Installers.**
3. **Option 3: External Browser Download Redirect Only.**

---

## 2. Decision

We choose **Option 2: Native In-App Download with GitHub Releases Manifest, Ed25519 Cryptographic Verification & Platform-Adaptive Installers**:

```
                       [ Background Update Timer (6 Hours) ]
                                         |
                                         v
                    [ GET api.github.com/repos/.../latest ]
                    - Anonymous HTTPS request (no telemetry)
                    - Fetches update-manifest.json + signature
                                         |
                                         v
                    [ Cryptographic Signature Verification ]
                    - Verify manifest using public Ed25519 key
                    - Compare semver against current app version
                                         |
                       +-----------------+-----------------+
                       | (Current)                         | (Newer Version Available)
                       v                                   v
                   [ Sleep ]                   [ Download Artifact to Temp ]
                                               - Check SHA-256 matches manifest
                                                           |
                                 +-------------------------+-------------------------+
                                 |                                                   |
                                 v                                                   v
                         [ Windows (NSIS) ]                                   [ macOS (.dmg) ]
             - Download Chat-Bridge-Setup.exe                    - Download Chat-Bridge.dmg
             - Prompt user: "Update ready"                       - Open DMG via shell.openPath()
             - On user confirm: launch NSIS                      - Display visual instructions:
               with /S silent flag & exit                          "Drag icon to Applications"
```

### Technical Specification

#### 1. Update Manifest & Ed25519 Cryptographic Verification
Located in `packages/desktop/src/updater/`:
- Releases on GitHub publish an `update-manifest.json` alongside `.dmg`, `.exe`, and `.zip` binaries:
  ```json
  {
    "version": "1.2.0",
    "releaseDate": "2026-11-20T10:00:00Z",
    "notes": "Fixed Zalo reconnect backoff and added Sheets sync optimizations.",
    "assets": {
      "darwin-arm64": {
        "url": "https://github.com/chat-bridge/chat-bridge/releases/download/v1.2.0/Chat-Bridge-1.2.0-arm64.dmg",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      "darwin-x64": {
        "url": "https://github.com/chat-bridge/chat-bridge/releases/download/v1.2.0/Chat-Bridge-1.2.0-x64.dmg",
        "sha256": "f4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149a"
      },
      "win32-x64": {
        "url": "https://github.com/chat-bridge/chat-bridge/releases/download/v1.2.0/Chat-Bridge-Setup-1.2.0.exe",
        "sha256": "4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149ae3"
      }
    }
  }
  ```
- **Cryptographic Signature (`update-manifest.json.sig`):**
  - Generated during GitHub Actions CI build using the project's private Ed25519 signing key stored in GitHub repository secrets.
  - The desktop client embeds the static public key:
    ```typescript
    const PUBLIC_UPDATE_KEY = Buffer.from('a7f98...c2e1', 'hex');
    ```
  - Before parsing or executing any update, `crypto.verify(null, manifestBuffer, PUBLIC_UPDATE_KEY, signatureBuffer)` is executed. If verification fails, the update is dropped immediately with an audit log.

#### 2. Platform-Adaptive Update Execution
- **Windows Architecture:**
  1. Installer binary (`Chat-Bridge-Setup-X.Y.Z.exe`) is downloaded to `%TEMP%\chat-bridge-update\`.
  2. SHA-256 hash is verified against the manifest.
  3. UI displays a non-blocking notification: *"Update ready to install. Restart now or on next launch"*.
  4. When the sales rep clicks *"Restart & update"*, the application initiates two-phase engine shutdown ([ADR 0021](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0021-desktop-process-lifecycle-sleep-wake-tray.md)), flushes databases, and spawns the installer:
     ```typescript
     spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
     app.quit();
     ```
- **macOS Architecture (Handling Unsigned Gatekeeper Restrictions):**
  1. In-place binary overwrites of `/Applications/Chat Bridge.app` fail on unsigned macOS bundles because macOS Gatekeeper revokes app launch permissions when bundle inodes change without a valid Apple Developer signature.
  2. When an update is verified and downloaded to `~/Downloads/Chat-Bridge-X.Y.Z.dmg`, the app invokes `shell.openPath(dmgPath)`.
  3. The mounted DMG opens a standard Finder window presenting the `Chat Bridge.app` icon with an arrow pointing to the `/Applications` folder shortcut.
  4. The UI displays an in-app banner explaining the 1-click action:
     - *"A new version is downloaded. Drag Chat Bridge to your Applications folder, then choose 'Replace'."*

#### 3. Zero-Telemetry & Offline Safety
- Periodic checks occur every 6 hours using standard `https.get` to `https://api.github.com`.
- No user identification, hardware identifiers, OS usernames, or session tokens are passed in request headers. Only standard User-Agent `ChatBridge/<version> (<platform>)`.
- If the computer is offline or in flight mode, network failures are silently caught with zero UI errors or log spam.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Standard `electron-updater` | Option 2 (Accepted): Native In-App Download + Ed25519 Manifest | Option 3: External Browser Redirect |
| :--- | :--- | :--- | :--- |
| **macOS Unsigned Support** | **Fails Completely.** Squirrel.Mac rejects unsigned apps (`OSStatus -67062`). | **Full.** Mounts DMG safely without breaking Gatekeeper permissions. | Manual burden on sales rep. |
| **Windows Support** | Full via NSIS. | **Full via verified silent NSIS execution.** | Manual download and install. |
| **Supply-Chain Integrity** | Relies solely on GitHub HTTPS TLS. | **Cryptographic Ed25519 public-key signature verification.** | Relies solely on HTTPS TLS. |
| **Non-Technical UX** | Crashes on macOS. | **Polished.** In-app notification, zero terminal, plain language. | Confusing GitHub asset list. |
| **Zero Telemetry** | Requires disabling default analytics. | **Strictly compliant.** Minimal anonymous manifest fetch. | Compliant. |

---

## 4. Consequences and Mitigations

* **Trade-off 1:** On macOS, the user must perform the drag-and-drop replacement in Finder rather than a 100% silent background binary swap.
  * *Mitigation:* This is a physical constraint of macOS Gatekeeper for all unsigned applications. The UI provides a clear one-page screenshot guide ([Feature I-5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L204)) making the replacement effortless. Once commercial developer certificates are acquired in post-beta, seamless background updates can be enabled without breaking changes.
* **Trade-off 2:** Ed25519 key management overhead during release automation.
  * *Mitigation:* The signing step is automated in the GitHub Actions release workflow via repository secrets. The client only stores the public key.

