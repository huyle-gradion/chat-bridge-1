import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DesktopBootstrap } from './bootstrap.js';
import { getInstallGuideMarkdown } from './install-guide.js';

describe('US-I5-01: Zero-Terminal Desktop App Shell & Installation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-desktop-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Scenario 1: First-time launch on macOS/Windows opens setup wizard', () => {
    it('initializes background services in under 5 seconds on a clean machine', async () => {
      const bootstrap = new DesktopBootstrap({ dataDir: tempDir });
      const startTime = performance.now();

      const initResult = await bootstrap.initialize();
      const elapsedMs = performance.now() - startTime;

      expect(initResult.ok).toBe(true);
      expect(initResult.startupTimeMs).toBeLessThan(5000);
      expect(elapsedMs).toBeLessThan(5000);

      // Clean machine with no prior config displays Step 1 of the Setup Wizard
      expect(initResult.isFirstLaunch).toBe(true);
      expect(initResult.initialRoute).toBe('setup-wizard');
      expect(initResult.currentStep).toBe('connect-whatsapp');

      // Local loopback server is running on 127.0.0.1
      expect(initResult.loopbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // Verify health check over local loopback
      const res = await fetch(`${initResult.loopbackUrl}/health`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');

      // Verify wizard state endpoint
      const wizardRes = await fetch(`${initResult.loopbackUrl}/api/v1/wizard/state`);
      expect(wizardRes.ok).toBe(true);
      const wizardBody = (await wizardRes.json()) as {
        isFirstLaunch: boolean;
        initialRoute: string;
        currentStep: string;
      };
      expect(wizardBody.isFirstLaunch).toBe(true);
      expect(wizardBody.initialRoute).toBe('setup-wizard');
      expect(wizardBody.currentStep).toBe('connect-whatsapp');

      // Verify status endpoint
      const statusRes = await fetch(`${initResult.loopbackUrl}/api/v1/status`);
      expect(statusRes.ok).toBe(true);
      const statusBody = (await statusRes.json()) as { status: string };
      expect(statusBody.status).toBe('running');

      // Verify unknown endpoint returns 404
      const unknownRes = await fetch(`${initResult.loopbackUrl}/api/v1/unknown`);
      expect(unknownRes.status).toBe(404);

      await bootstrap.shutdown();
    });

    it('requires zero terminal windows and zero elevated permissions', async () => {
      const bootstrap = new DesktopBootstrap({ dataDir: tempDir });
      const initResult = await bootstrap.initialize();

      // Confirms user-space isolation: zero administrative elevation required
      expect(initResult.requiresElevation).toBe(false);
      expect(initResult.hasTerminalRequirement).toBe(false);

      await bootstrap.shutdown();
    });

    it('routes directly to main view if onboarding is already completed', async () => {
      // Pre-seed settings.json with onboarding.completed = true
      const settingsPath = path.join(tempDir, 'settings.json');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          schemaVersion: 1,
          onboarding: { completed: true, currentStep: 'complete' },
        })
      );

      const bootstrap = new DesktopBootstrap({ dataDir: tempDir });
      const initResult = await bootstrap.initialize();

      expect(initResult.isFirstLaunch).toBe(false);
      expect(initResult.initialRoute).toBe('main');

      const wizardRes = await fetch(`${initResult.loopbackUrl}/api/v1/wizard/state`);
      const wizardBody = (await wizardRes.json()) as {
        isFirstLaunch: boolean;
        initialRoute: string;
      };
      expect(wizardBody.isFirstLaunch).toBe(false);
      expect(wizardBody.initialRoute).toBe('main');

      await bootstrap.shutdown();
    });

    it('recovers gracefully when settings.json contains malformed JSON', async () => {
      // Write corrupted JSON
      const settingsPath = path.join(tempDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{ malformed: json }}}');

      const bootstrap = new DesktopBootstrap({ dataDir: tempDir });
      const initResult = await bootstrap.initialize();

      // Gracefully defaults to onboarding setup wizard instead of crashing
      expect(initResult.ok).toBe(true);
      expect(initResult.isFirstLaunch).toBe(true);
      expect(initResult.initialRoute).toBe('setup-wizard');

      await bootstrap.shutdown();
    });

    it('handles idempotent shutdown cleanly without crashing', async () => {
      const bootstrap = new DesktopBootstrap({ dataDir: tempDir });
      await bootstrap.initialize();

      await bootstrap.shutdown();
      // Second shutdown should not throw
      await expect(bootstrap.shutdown()).resolves.not.toThrow();
    });
  });

  describe('Scenario 2: Unsigned beta warning guidance', () => {
    it('provides clear single-page visual installation guidance for macOS and Windows', () => {
      const guide = getInstallGuideMarkdown();
      expect(guide).toBeDefined();
      expect(guide.length).toBeGreaterThan(100);

      // Plain language instructions for macOS Gatekeeper
      expect(guide).toContain('macOS');
      expect(guide).toContain('Open Anyway');

      // Plain language instructions for Windows SmartScreen
      expect(guide).toContain('Windows');
      expect(guide).toContain('More info');
      expect(guide).toContain('Run anyway');

      // Zero technical terminal requirements in user guidance
      expect(guide).not.toContain('sudo');
      expect(guide).not.toContain('chmod');
      expect(guide).not.toContain('npm install');
    });

    it('serves install guide over loopback API for in-app help display', async () => {
      const bootstrap = new DesktopBootstrap({ dataDir: tempDir });
      const initResult = await bootstrap.initialize();

      const res = await fetch(`${initResult.loopbackUrl}/api/v1/install-guide`);
      expect(res.ok).toBe(true);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      const text = await res.text();
      expect(text).toContain('Chat Bridge Installation Guide');

      await bootstrap.shutdown();
    });
  });
});
