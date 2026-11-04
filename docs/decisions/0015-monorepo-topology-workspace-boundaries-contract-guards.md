# ADR 0015: Monorepo Package Topology, Workspace Isolation & Architectural Contract Guards

* **Status:** Accepted
* **Date:** 2026-11-04
* **Deciders:** Team / Project Lead
* **Consulted:** `docs/spec.md` (Sections 4, 6, 11, 14), `.agents/rules/AGENTS.md`

---

## 1. Context and Problem Statement

Sections 4, 6, and 14 of `docs/spec.md` establish strict architectural boundaries and code hygiene rules:
1. **Decoupled Three-Tier Architecture ([Section 4](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L88-L100)):** Sources, Engine, and Sinks must be completely decoupled. Sources and Sinks must **never** communicate directly with each other or bypass the Engine contracts ([Section 6](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L116-L147)).
2. **Dual-Shell Consumption ([ADR 0001](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0001-desktop-shell-architecture.md)):** The exact same Engine and Provider modules must be imported by both the Electron Desktop Shell (`packages/desktop`) and the standalone CLI binary (`packages/cli`).
3. **Mandatory Quality Guards ([Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L351-L358)):**
   - **Zero import cycles** across the codebase.
   - **The Engine reaches sources and sinks ONLY through their contracts.**
   - **Zero dead code or unused exports.**
   - File and function size limits, and plain-language UI linting.
4. **The Monolithic Erosion Trap:** In multi-developer or agent-assisted projects, a flat codebase structure easily degenerates: developers accidentally import connector types into the engine, sinks leak internal database schemas, or circular dependencies cripple packaging and testing.

We evaluated three project topology architectures:
1. **Option 1 (Flat Monolithic `src/` Directory):** Single `package.json` with path aliases (`@/engine`, `@/sources`, `@/sinks`).
2. **Option 2 (Strict `pnpm` Monorepo Workspaces with Automated AST Boundary Linters):** Isolated workspace packages with unidirectional dependency graphs enforced by CI linters.
3. **Option 3 (Polyrepo Architecture):** Multiple separate GitHub repositories for engine, sources, sinks, and UI.

---

## 2. Decision

We choose **Option 2: Strict `pnpm` Workspaces with Contract-Isolating Package Boundaries & Automated CI Boundary Linters**:

```
                                  [ packages/types ]
                 (Pure TypeScript contracts: SourceContract, SinkContract, Message)
                                          ^
                     +--------------------+--------------------+
                     |                                         |
            [ packages/engine ]                                |
       (Pipeline, Outbox, Pacing,                              |
        Crypto, Keystore, Telemetry)                           |
                     ^                                         |
                     |                                         |
                     +--------------------+                    |
                     |                    |                    |
            [ packages/cli ]     [ packages/desktop ]          |
                     |                    |                    |
                     |                    v                    |
                     |            [ packages/ui ]              |
                     |            (React 19 Frontend)          |
                     |                    |                    |
                     +--------------------+--------------------+
                                          |
                     +--------------------+--------------------+
                     |                                         |
            [ packages/sources ]                      [ packages/sinks ]
            - sources/fake                            - sinks/archive
            - sources/zalo                            - sinks/local-db
            - sources/whatsapp                        - sinks/sheets
                                                      - sinks/margince
```

### 1. Workspace Package Topology

The repository is organized under `pnpm-workspace.yaml`:

| Package Path | Package Name | Responsibility | Allowed Dependencies |
| :--- | :--- | :--- | :--- |
| `packages/types` | `@chat-bridge/types` | Core domain interfaces: `Message`, `SourceContract`, `SinkContract`, status enums. | **None** (zero dependencies). |
| `packages/engine` | `@chat-bridge/engine` | Pipeline stages, filtering, SQLite envelope encryption, Token Bucket outbox workers, keystore bridge, telemetry. | `@chat-bridge/types` only. |
| `packages/sources/*` | `@chat-bridge/source-*` | Connectors for Fake, Zalo (`zca-js`), and WhatsApp (`baileys`). | `@chat-bridge/types`. |
| `packages/sinks/*` | `@chat-bridge/sink-*` | Sinks for Archive (JSONL), Local DB (SQLite), Sheets (OAuth/REST), and Margince (HMAC push). | `@chat-bridge/types`. |
| `packages/ui` | `@chat-bridge/ui` | React 19 + Vite + Tailwind frontend application. | Pure web dependencies. |
| `packages/cli` | `@chat-bridge/cli` | Standalone Node.js CLI executable (`bin/chat-bridge`). | `engine`, `sources/*`, `sinks/*`. |
| `packages/desktop` | `@chat-bridge/desktop` | Electron shell, system tray, loopback server launcher, packaging scripts. | `engine`, `sources/*`, `sinks/*`. |

### 2. Dependency Injection & Provider Registry

To guarantee that `@chat-bridge/engine` has zero compile-time or runtime dependencies on concrete sources or sinks:
1. `Engine` defines a `ProviderRegistry` interface.
2. Concrete providers (`SourceZalo`, `SinkMargince`, etc.) are instantiated by the outer shell (`cli` or `desktop`) and registered into the engine via dependency injection:
   ```typescript
   const engine = new ChatBridgeEngine({ storage, keystore });
   engine.registerSource('whatsapp', new WhatsAppSource());
   engine.registerSink('margince', new MarginceSink(config));
   ```
3. The engine interacts with registered instances **exclusively** through the methods defined in `SourceContract` and `SinkContract`.

### 3. Automated Quality & Boundary Guards (`guards/`)

In compliance with [Section 14](file:///Users/van.tran/Documents/dev/chat-bridge/docs/spec.md#L351-L358), automated check scripts are located in `guards/` and executed on every commit and CI pull request:

1. **`guards/no-cycles.ts` (Import Cycle Guard):**
   - Uses `dependency-cruiser` to statically analyze module imports.
   - Any circular dependency fails the build immediately with exit code 1.
2. **`guards/contract-boundary.ts` (Boundary Guard):**
   - Scans AST imports inside `packages/engine`.
   - Asserts that `packages/engine` contains **zero** imports from `@chat-bridge/source-*` or `@chat-bridge/sink-*`.
   - Asserts that no source imports any sink, and no sink imports any source.
3. **`guards/plain-language.ts` (UX Guard):**
   - AST linter scanning JSX/TSX in `packages/ui` for banned internal jargon ([ADR 0007](file:///Users/van.tran/Documents/dev/chat-bridge/docs/decisions/0007-frontend-stack-plain-language-guard.md)).
4. **`guards/unused-exports.ts` (Dead Code Guard):**
   - Uses `knip` to assert zero dead code, zero unused exports, and zero unreferenced dependencies.

---

## 3. Rationale and Comparison

| Dimension | Option 1: Monolithic Flat Directory | Option 2: Strict `pnpm` Workspaces (Selected) | Option 3: Polyrepo |
| :--- | :--- | :--- | :--- |
| **Architectural Boundary Enforcement** | **Weak.** Requires strict manual discipline; path aliases easily leak across layers. | **Hard & Inviolable.** Enforced by package boundaries, `pnpm` symlinks, and automated AST linters. | High, but excessive development friction. |
| **Zero Import Cycles (Sec 14)** | Difficult to maintain; circular imports appear frequently. | **Guaranteed.** Package DAG prevents cross-package cycles; `dependency-cruiser` prevents intra-package cycles. | Guaranteed. |
| **Independent Testing & TDD** | Slow test execution; hard to isolate engine unit tests. | **Ultra-Fast & Modular.** Test engine against mock contracts in isolation; fast Vitest execution. | High, but cumbersome multi-repo test coordination. |
| **Packaging & Tree-Shaking** | CLI bundle risks pulling Electron dependencies. | **Clean Separation.** CLI package only bundles Node CLI; Desktop package bundles Electron. | High. |

---

## 4. Consequences and Mitigations

* **Workspace Setup Complexity:** Running builds and tests across multiple workspace packages requires orchestrating `pnpm --filter`.
  * *Mitigation:* The root `package.json` provides unified root scripts (`pnpm build`, `pnpm test`, `pnpm guard`, `pnpm dev:cli`, `pnpm dev:desktop`) so developers and CI execute single standard commands.
* **Type Declaration Synchronization:** When `packages/types` changes, downstream packages require type rebuilding.
  * *Mitigation:* TypeScript Project References with composite project flags (`tsconfig.json`) ensure instantaneous incremental type-checking across workspace boundaries during local development.

