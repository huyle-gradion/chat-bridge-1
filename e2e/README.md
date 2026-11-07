# End-to-end tests

These tests run the built app the way a user does: the real `chat-bridge` binary in its own process, and later the local web UI in a browser. Unit tests run inside vitest and cannot catch a binary that fails to start.

Run: `pnpm build && pnpm e2e:cli` (no browser needed). For the web project, run `pnpm exec playwright install chromium` once, then `pnpm e2e`.

## Rules

- One file per user story: `cli/us-<id>-<slug>.e2e.ts` or `web/us-<id>-<slug>.e2e.ts`. Put the story id in the `describe` title.
- Each test gets a fresh data folder (`freshDataDir()` in `support/cli.ts`). Never share state between tests.
- Synthetic data only.
- `web/us-i4-01-setup-wizard.e2e.ts` walks the whole setup wizard. It stays `fixme` until the wizard exists.
- This folder is protected: the agent loop reverts any change the agent makes here. People write these tests; the agent makes them pass.

## Defect flow

1. Write a failing test here that shows the bug.
2. File an issue that links the test, with `bug` and `agent:ready`.
3. The loop plans, then makes the test pass without editing it.
