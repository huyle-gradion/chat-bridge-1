import { test, expect } from '@playwright/test';
import { runCli } from '../support/cli.js';

// US-I1-01: developer and QA command line.
test.describe('US-I1-01 CLI', () => {
  test('the installed binary starts and prints its version', () => {
    const run = runCli(['--version']);
    expect(run.stderr).not.toContain('Error');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  test('status --json on a fresh install returns valid JSON', () => {
    const run = runCli(['status', '--json']);
    expect(run.exitCode).toBe(0);
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });

  test('a mistyped command suggests the closest one', () => {
    const run = runCli(['stauts']);
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('status');
  });
});
