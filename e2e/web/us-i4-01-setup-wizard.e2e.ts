import { test } from '@playwright/test';

// US-I4-01: the whole setup wizard, from first launch to the first pushed chat.
// Skipped: the local web UI (I-2) and wizard (I-4) have no page to open yet.
// Write the real walk-through here when they do.
test.fixme('US-I4-01 setup wizard: first launch to first pushed chat', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
});
