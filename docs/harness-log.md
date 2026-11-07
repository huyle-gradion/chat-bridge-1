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
