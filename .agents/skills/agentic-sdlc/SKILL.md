---
name: agentic-sdlc
description: Principles, mental models, harness engineering procedures, and context engineering rules from 'The New SDLC With Vibe Coding' (Google, May 2026).
---

# Agentic SDLC & Factory Model Skill

Use this skill whenever structuring AI agent workflows, designing harness scaffolding, balancing static vs. dynamic context, selecting Conductor vs. Orchestrator modes, or evaluating the economics and quality gates of AI-generated software.

Full whitepaper reference: [`docs/the-new-sdlc.md`](../../docs/the-new-sdlc.md)

---

## 1. Core Mental Models

1. **The Core Formula:**
   $$\text{Agent} = \text{Model} + \text{Harness}$$
   * The model is ~10% (raw reasoning engine). The harness is ~90% (prompts, tools, sandboxes, guardrails, evals, memory).
   * Most agent failures are **harness configuration failures**, not model failures.

2. **The Factory Model:**
   * **The developer's primary output is NOT code — it is the system that produces code.**
   * A developer designs specifications, guardrails, and quality gates; the agents implement the code; automated tests and evals verify the output.

3. **Verification Differentiates the Spectrum:**
   * **Vibe Coding:** Casual prompts, *"does it seem to work?"*, high OpEx (token burn, context collapse, maintenance debt).
   * **Agentic Engineering:** Formal specs (ADRs, BDD user stories), automated tests (TDD) + evals (trajectory & output), low marginal feature cost.

---

## 2. Context Engineering Protocol

Balance context across the static/dynamic boundary to optimize signal quality and token economics:

| Context Class | Definition | Repository Location | Loading Pattern |
| :--- | :--- | :--- | :--- |
| **Static Context** | System identity, core rules, hard constraints. | `.agents/rules/AGENTS.md` | Always loaded; high token cost; zero forgetting. |
| **Dynamic Context** | Specialized procedural knowledge, references. | `.agents/skills/*/SKILL.md` | Loaded on demand when task matches; high leverage. |
| **Deterministic Guards**| AST boundary checks, cycle linters, secret scanners. | `guards/*.ts` | Executed deterministically pre-commit or in CI. |

---

## 3. Operational Modes: Conductor vs. Orchestrator

* **Conductor Mode (Synchronous / In-IDE):**
  - Use when exploring unfamiliar APIs, diagnosing tricky bugs, or designing initial interfaces.
  - Characteristics: Keystroke/diff-level control, immediate inline feedback.
* **Orchestrator Mode (Asynchronous / Goal-Driven):**
  - Use when implementing well-specified stories (`docs/user-stories.md`), running contract test suites, or performing migrations.
  - Characteristics: Goal-level instruction, multi-file execution, sandbox test runs, review PR/diff outcomes rather than typing.

---

## 4. Tackling the 80% Problem

Agents generate ~80% of routine logic rapidly, but stumble on the remaining 20% (edge cases, security boundaries, rate-limiting, error recovery).
* **Rule:** Human expertise must focus on the 20% (system architecture, edge cases, verification) rather than hand-typing the 80% boilerplate.

