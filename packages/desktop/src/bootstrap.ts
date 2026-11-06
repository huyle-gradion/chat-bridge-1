import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { CliContext } from '@chat-bridge/cli';
import { LoopbackServer } from './loopback-server.js';

export interface DesktopBootstrapOptions {
  dataDir?: string;
  port?: number;
}

export interface DesktopInitResult {
  ok: boolean;
  startupTimeMs: number;
  isFirstLaunch: boolean;
  initialRoute: 'setup-wizard' | 'main';
  currentStep?: string;
  loopbackUrl: string;
  requiresElevation: boolean;
  hasTerminalRequirement: boolean;
  dataDir: string;
}

export class DesktopBootstrap {
  private readonly dataDir: string;
  private readonly port: number;
  private cliContext: CliContext | null = null;
  private loopbackServer: LoopbackServer | null = null;
  private isFirstLaunch: boolean = true;
  private initialRoute: 'setup-wizard' | 'main' = 'setup-wizard';
  private currentStep: string = 'connect-whatsapp';

  constructor(options: DesktopBootstrapOptions = {}) {
    this.dataDir =
      options.dataDir ??
      process.env['CHAT_BRIDGE_DATA_DIR'] ??
      path.join(os.homedir(), '.chat-bridge');
    this.port = options.port ?? 0;
  }

  public async initialize(): Promise<DesktopInitResult> {
    const startTime = performance.now();

    // Ensure user-space data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Initialize CLI Context for unified storage, config, and database
    this.cliContext = new CliContext(this.dataDir);

    // Read settings to check onboarding status
    const settingsPath = path.join(this.dataDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.onboarding?.completed === true) {
          this.isFirstLaunch = false;
          this.initialRoute = 'main';
          this.currentStep = parsed.onboarding.currentStep ?? 'complete';
        } else {
          this.isFirstLaunch = true;
          this.initialRoute = 'setup-wizard';
          this.currentStep = parsed.onboarding?.currentStep ?? 'connect-whatsapp';
        }
      } catch {
        this.isFirstLaunch = true;
        this.initialRoute = 'setup-wizard';
        this.currentStep = 'connect-whatsapp';
      }
    } else {
      this.isFirstLaunch = true;
      this.initialRoute = 'setup-wizard';
      this.currentStep = 'connect-whatsapp';
    }

    // Start local loopback server on 127.0.0.1
    this.loopbackServer = new LoopbackServer({
      port: this.port,
      getState: () => ({
        isFirstLaunch: this.isFirstLaunch,
        initialRoute: this.initialRoute,
        currentStep: this.currentStep,
      }),
    });

    const loopbackUrl = await this.loopbackServer.start();
    const startupTimeMs = performance.now() - startTime;

    return {
      ok: true,
      startupTimeMs,
      isFirstLaunch: this.isFirstLaunch,
      initialRoute: this.initialRoute,
      currentStep: this.currentStep,
      loopbackUrl,
      requiresElevation: false,
      hasTerminalRequirement: false,
      dataDir: this.dataDir,
    };
  }

  public async shutdown(): Promise<void> {
    if (this.loopbackServer) {
      await this.loopbackServer.stop();
      this.loopbackServer = null;
    }

    if (this.cliContext) {
      this.cliContext.close();
      this.cliContext = null;
    }
  }
}
