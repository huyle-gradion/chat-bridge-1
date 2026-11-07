import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the built app (`pnpm build` first).
// `cli` needs no browser. `web` needs `pnpm exec playwright install chromium`.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  projects: [
    { name: 'cli', testDir: './cli' },
    { name: 'web', testDir: './web', use: { ...devices['Desktop Chrome'] } },
  ],
});
