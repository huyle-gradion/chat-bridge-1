# ADR 0012: Desktop Packaging, Native Module Toolchain & Cross-Platform Keystore Fallback

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 1, 3, 7 [C-3, I-5], 9, 11, 14), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Feature **I-5** and **C-3** in `docs/spec.md` require delivering an installable desktop application alongside a standalone developer CLI:
1. **Zero-Terminal Installation ([Feature I-5](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L201), [Section 11](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L294)):** Non-technical sales reps must install the app on macOS and Windows via a simple double-click installer without touching a terminal, package manager, or build tool. The first release is an unsigned beta with a one-page installation guide for the "unknown developer" OS warning.
2. **OS Keystore Integration ([Feature C-3](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L153)):** Master encryption keys must be sourced from native OS credential stores: Apple Keychain on macOS, DPAPI on Windows, and a `0600` permission keyfile on Linux for headless CI.
3. **Dual Runtime Execution ([ADR 0001](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0001-desktop-shell-architecture.md)):** The exact same engine code must execute inside the Electron Desktop Shell and in the standalone Node.js CLI binary.
4. **The Native Addon Fragility Trap:**
   - The engine relies on `better-sqlite3` for high-throughput WAL-mode encrypted outbox storage ([ADR 0002](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0002-outbox-storage-envelope-encryption.md)).
   - Native C++ Node addons frequently suffer ABI version mismatches between Node and Electron, fail during cross-compilation across architectures (Apple Silicon `arm64` vs Intel `x64`), and require Microsoft Visual C++ Redistributable or Xcode command line tools if compiled from source.
   - Popular keystore libraries like `keytar` are deprecated/unmaintained and introduce native build failures in modern Electron environments.

We evaluated three packaging and keystore architectures:
1. **Option 1 (Electron Builder + `keytar` Native Addon):** Standard desktop packaging bundling `keytar` and `better-sqlite3` via `node-gyp`.
2. **Option 2 (Prebuilt SQLite + Electron `safeStorage` Desktop & Subprocess CLI Fallback):** Precompiled C++ SQLite binaries combined with zero-native-addon keystore bridges (Electron `safeStorage` in desktop, native OS CLI subprocesses in standalone CLI).
3. **Option 3 (Pure WebAssembly / WASM Stack):** Replace native SQLite with `sql.js` (Wasm) and use browser Web Crypto API.

---

## 2. Decision

We choose **Option 2: Prebuilt SQLite + Electron `safeStorage` Desktop & Subprocess CLI Fallback with `electron-builder` Universal Packaging**:

```
+---------------------------------------------------------------------------------+
|                                 CHAT BRIDGE APP                                 |
+---------------------------------------------------------------------------------+
       |                                                         |
       v (Desktop Mode)                                          v (CLI Mode)
 [ Electron Main Process ]                               [ Node.js CLI Process ]
       |                                                         |
       +----------------------------+----------------------------+
                                    |
                                    v
                     [ Unified Keystore Bridge ]
                                    |
        +---------------------------+---------------------------+
        | (Desktop Mode)                                        | (CLI Mode)
        v                                                       v
 Electron `safeStorage`                         Platform-Specific Subprocess Bridge:
 - macOS: Apple Keychain                        - macOS: `/usr/bin/security`
 - Windows: Windows DPAPI                       - Windows: PowerShell DPAPI
                                                - Linux / CI: `0600` Key File
                                    |
                                    v
                   [ Master Key: 32-Byte Secret ]
                                    |
                                    v
            [ `better-sqlite3` WAL Outbox & Session Store ]
             (Prebuilt native binaries: arm64, x64, win-x64)
```

### 1. Zero-Native-Addon Keystore Strategy

To eliminate the fragility of unmaintained third-party native keystore addons (`keytar`):

1. **In Desktop Mode (Electron Shell):**
   - Use Electron's official, built-in [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) API:
     - `safeStorage.isEncryptionAvailable()`: Verifies OS store availability.
     - `safeStorage.encryptString(masterKey)` / `safeStorage.decryptString(encryptedBuffer)`.
   - On macOS, this delegates directly to the user's Apple Keychain.
   - On Windows, this delegates directly to Windows Data Protection API (DPAPI).
   - Zero third-party C++ dependencies; 100% ABI compatibility guaranteed by Electron.
2. **In CLI Mode (Standalone Node.js):**
   - A dedicated `CliKeystore` adapter manages the master key without native C++ compilation:
     - **macOS:** Invokes the native `/usr/bin/security` binary:
       - Read: `security find-generic-password -s "Chat Bridge" -a "$USER" -w`
       - Write: `security add-generic-password -s "Chat Bridge" -a "$USER" -w "$KEY" -U`
     - **Windows:** Invokes PowerShell built-in DPAPI via subprocess:
       - `[System.Security.Cryptography.ProtectedData]::Protect(...)`
     - **Linux / CI Environment:** Stores the derived 256-bit key in a local keyfile at `~/.chat-bridge/master.key` strictly enforced with POSIX `0600` permissions (read/write by owner only).

### 2. Native SQLite Toolchain & Prebuild Strategy

1. **Prebuilt Binary Pinning:**
   - Utilize `better-sqlite3` prebuilt binaries fetched via `@electron/rebuild` and `prebuild-install` during CI packaging.
   - Forbid compiling from source on target user machines.
2. **Target Architectures:**
   - **macOS:** Bundled as an `electron-builder` Universal Binary supporting both Apple Silicon (`arm64`) and Intel (`x64`) in a single package.
   - **Windows:** 64-bit (`x64`) package with embedded SQLite binaries statically linked against the C++ runtime, eliminating missing DLL errors.

### 3. Installer Packaging & Distribution Artifacts

1. **macOS Distribution:**
   - Packaged as a standard `.dmg` drag-and-drop installer and `.zip` archive.
   - Accompanied by a screenshot-illustrated one-page install guide explaining how to right-click -> "Open" to bypass macOS Gatekeeper's "unidentified developer" prompt.
2. **Windows Distribution:**
   - Packaged as an NSIS installer (`.exe`) configured for per-user installation (`oneClick: true`, `perMachine: false`).
   - Installs directly to `%LOCALAPPDATA%\Programs\chat-bridge` without requiring Windows Administrator elevation.
   - Accompanied by instructions for clicking "More info" -> "Run anyway" on the Windows SmartScreen warning.
3. **Application Startup Optimization:**
   - Fast startup budget (< 5s): Electron main process starts the background engine within 1.2s, renders the splash/wizard window within 2.5s, satisfying the non-functional performance target.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Electron Builder + `keytar` | Option 2: Prebuilt SQLite + `safeStorage` (Selected) | Option 3: Pure Wasm / WebCrypto |
| :--- | :--- | :--- | :--- |
| **Packaging & CI Reliability** | **Poor.** High failure rate in GitHub Actions; `keytar` native build errors across Node/Electron ABIs. | **High & Robust.** Zero third-party native keystore addons; prebuilt SQLite binaries pinned in CI. | High (pure JavaScript/Wasm), but lacks native desktop capabilities. |
| **Keystore Security** | High (Keychain/DPAPI). | **Identical High Security.** Direct OS Keychain and DPAPI via Electron built-ins and OS CLI. | **Weak.** Browser localStorage / IndexedDB keys stored in plaintext. |
| **Desktop Installation (Rep UX)** | Moderate. Frequent crashes on missing Windows C++ redistributables. | **Seamless.** One-click NSIS and Universal DMG; zero external prerequisites. | High, but poor integration with local desktop backgrounding. |
| **Outbox Disk I/O Performance** | Native SQLite speed (WAL mode). | **Native SQLite Speed (WAL mode).** Sub-millisecond queue operations. | **Violated.** Wasm SQLite does not support true WAL multi-process concurrency; high memory footprint. |

---

## 4. Consequences and Mitigations

* **macOS Gatekeeper & Windows SmartScreen Friction:** Unsigned beta packages trigger warning dialogs on first launch.
  * *Mitigation:* The onboarding documentation provides a plain-language, visual one-page install guide with screenshots demonstrating the exact two clicks needed to open the app on macOS and Windows.
* **CLI Subprocess Overhead for Key Retrieval:** Invoking `/usr/bin/security` or PowerShell incurs a ~100ms subprocess execution time.
  * *Mitigation:* The master key is retrieved only once at CLI process startup and cached securely in process memory for the duration of the CLI command execution.

