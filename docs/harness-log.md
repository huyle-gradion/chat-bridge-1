# Harness log

One entry per harness change, agreed at the Wednesday harness review. A harness change is anything around the model: a rule, a hook, a skill, a template, a gate, a guard, a permission, or a loop setting. Numbers come from the run ledger (`agentic-loop report --ledger <dir>`), never typed from memory; anything a script produced is labelled as generated.

## How to write an entry
- **Problem:** the worst failure from last week's metrics, with the run or PR that shows it.
- **Prediction:** what the change should move, and by how much.
- **Change:** what was changed, with the PR link.
- **Before and after:** the same metrics for comparable runs, before and after the change.
- **Verdict:** kept, adjusted, or reverted.

## Metrics tracked
Tokens and model requests per issue; attempts per phase; first-pass rate; which check caught each failure (gate name, `scope`, `locked-tests`, `red-not-failing`, `review:<kind>`); human interventions; plan rejections; escaped defects.

## Entries

### 2026-11-07: baseline, first real run (no change yet)
- **Runs:** issue #14 (mistyped-command suggestion), plan stage then build stage, on the trial branch `chore/agent-loop-config`. Result: PR #15, all gates pass. Model `gemini-4-argon-high`, Antigravity CLI 1.5.3.
- **Requests per issue:** 33 model calls (plan 15, build 18).
- **Tokens:** plan about 684k input (89% cached) and 12k output; build about 847k input (90% cached) and 12k output.
- **List-price cost:** about $0.69 per issue (plan about $0.33, build about $0.36). Estimate only: the seat is fixed price, so the real limit is about 1,500 model calls per day.
- **Time:** about 10 minutes of loop time (plan 4.7 min, build 5.2 min), plus the wait for plan approval.
- **Attempts (red, green):** 1 and 1. First pass.
- **Caught by:** nothing; no gate failed and nothing was reverted.
- **Human interventions:** 0 hand edits. One plan approval, which is a lifecycle gate, not an intervention.
- **Correction:** the plan-stage ledger record shows 1 request and $0.18, because it was written before the fixes below. The figures above are the corrected ones.

Harness defects the run exposed, all fixed in `@agentic-factory/loop` the same day (generated numbers above come from the ledger and agy's own traces):
1. Token counts: agy reports cached tokens separately from `input_tokens`; the loop had assumed they were included, which halved the cost estimate.
2. Request counts: `num_turns` counts conversation turns (1), not model calls (15). Model calls are now counted from the session trace.
3. Local paths in a public PR: the agent linked files as `file:///Users/...`. Replies are now rewritten to repository-relative paths, and the prompt asks for them.
4. Approval in the wrong place: the approver labelled the plan PR instead of the issue. The loop now accepts approval on either.
5. Exit code: a ready plan exited with code 2. It now exits 0.
6. No visibility during a session: sessions now write agy's stream-json trace, readable with `agentic-loop trace <file> --follow`.

Guardrail tested and found missing: with `--dangerously-skip-permissions`, agy ignored a `--settings` deny rule (`git push` ran) and `allowNonWorkspaceAccess: false` (a file outside the workspace was read). Agent permissions therefore cannot be narrowed through agy. The loop's own checks (protected paths, locked tests, replaced commits, gates, an environment without credentials) remain the guardrails.

Next prediction to test: a defect issue filed with its failing test attached should skip most of the red phase's exploration, so it should need fewer model calls than this baseline.

### 2026-11-07: security fixes from an independent review of the loop
- **Problem:** a review of `@agentic-factory/loop` found 12 issues. The worst: the agent could plant git hooks or config in its clone, which the loop's own git commands would then run with the user's login.
- **Change:** loop git commands ignore system and global config and switch off hooks, fsmonitor and credential helpers; `.git/config`, `hooks/` and `info/` are reset to a pre-agent snapshot before each one; pushes use a header token, never stored. Also: trusted authors and comments only, fork PRs ignored, process-group kill, scope re-check before each commit, `package.json` scripts locked in green, claim settle, crash records, large prompts in a file. PR: https://github.com/vantrangradion/agentic-factory/pull/4
- **Before and after:** before, a planted `post-commit` hook ran during the loop's commit. After, a test planting hooks, fsmonitor and a `textconv` driver ran none of them. A real `agy` session still works inside the new process group.
- **Prediction:** no change to model calls or cost per issue; the next run should match the baseline within noise.
- **Open:** gates run in the working folder (an ignored file could make them pass); helpers that tests import are not locked; one watcher per GitHub login; the CI workflow needs container isolation.
- **Verdict:** kept, pending the next run.

### 2026-11-07: e2e gate, so the loop runs the built binary
- **Problem:** the built `chat-bridge` binary crashes on every command, `--version` included: `source-fake` imports the `@chat-bridge/testing` index, which loads the vitest contract suites. All three loop gates (build, guard, 140 unit tests) pass, because unit tests run inside vitest. The loop could ship a green PR for an app that does not start. Found by the first test in `e2e/`.
- **Change:** a fourth gate, `e2e` (`pnpm e2e:cli`), after `test`. It runs `e2e/` in Playwright against the built binary in a separate process. `e2e/**` is already protected, so the agent cannot edit these tests. PR: https://github.com/vantrangradion/chat-bridge/pull/20, defect #19
- **Before:** on main at 70100a1, gates build, guard and test pass; `pnpm e2e:cli` fails 3 of 3 with the vitest error.
- **Prediction:** the loop's fix for the defect issue passes `e2e` only when the binary starts. Expect fewer model calls than the 33-call baseline, because the failing test is attached to the issue. Gate cost: about 2 s per green attempt.
- **After:** defect #19 fixed by the loop (PR #21): plan 50 calls ($1.36), build 28 calls ($0.63), first pass on both, 0 hand edits. `pnpm e2e:cli` went from 3 of 3 failing to passing, in the loop and in CI.
- **Verdict:** kept. The gate works. The call prediction was wrong: 78 calls, not fewer than 33, because the plan stage spent most of its calls tracing the import chain.

### 2026-11-07: issue #17 (app health, C-9), first issue that needed review round-trips (no change yet)
- **Runs:** clean clone of main, published packages. Plan, build, re-plan, re-plan, build: 5 stages, 139 calls, about $4.79 at list price (#14 was $0.69). Merged as PR #18.
- **Slop that passed every gate (first build):** CPU figure always about 0; sink health read from a `health` config key only the tests set; one old failure marked a sink down forever; raw SQL from the CLI around the outbox. Caught by human review only.
- **Reviewer error:** the first review comment wrongly dropped ADR 0013's memory thresholds, and the next plan obeyed. A second comment restored them.
- **Plan deviation:** the approved plan said the outbox stays read-only; the build added an `updated_at` column, a migration and writes. Accepted (additive, fixes a risk the plan listed), but nothing in the loop noticed.
- **Hand edit:** one merge conflict in `cli.test.ts` (both #17 and #19 appended tests), resolved by hand when rebasing `agent/issue-17` onto main after #21.
- **Plans:** "Risks: None" in 3 of 4 plans until a comment asked for real risks; one plan leaked agent narration.

Candidate harness changes for the Wednesday review:
1. Build stage reads PR comments, so a code fix does not cost a full re-plan (about $1.1 each here).
2. Prompt ranks `docs/decisions/` above review comments.
3. Plan conformance check after the build: diff against the approved plan, flag unapproved changes.
4. Build stage rebases onto main first and stops for a person only on a conflict.
5. Guard for config keys read only by tests.
6. Rewrite local paths in gate output too (PR #21's body shows `/Users/...`).

### 2026-11-11: setup, gates and agent sessions run in Docker
- **Problem:** two gaps listed open since 2026-11-07. Gates ran in the working folder, so an ignored file could make them pass. The agent session ran as the user with every permission auto-approved, so it could read the home folder (SSH keys, other repos, the agy login) and reach Docker.
- **Change:** `agent.sandbox` with `agent: true`, image `chat-bridge-agent:1` from `docker/agent-sandbox/`. Setup runs in a container with network; each gate runs on a clean copy of the commit's files with no network. Each agent session runs in its own container: the clone with `.git` read-only, a fresh home folder holding only the agy login, no Docker socket, no capabilities. `docker/**` is protected. Needs `@agentic-factory/loop` 0.2.0. Factory PRs: https://github.com/vantrangradion/agentic-factory/pull/6, https://github.com/vantrangradion/agentic-factory/pull/7
- **Before:** setup and all four gates ran on the host.
- **Prediction:** no change to model calls per issue (same prompts, same model). Each gate ladder takes longer: setup plus four gates took 83 s in the sandbox on a clean copy of main (generated by a script; not yet compared with a host run). First-pass rate unchanged unless the agent relied on files outside the commit.
- **Open:** the agent container has open network and can read its login token, so it could still send repository contents out; helpers that tests import are not locked; one watcher per GitHub login.
- **Verdict:** pending the next run.
