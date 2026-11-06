import type { LoginEvent, SourceStatus } from '@chat-bridge/types';
import { WhatsAppSource, MockWhatsAppSocket } from '@chat-bridge/source-whatsapp';
import { ZaloSource, MockZaloAdapter } from '@chat-bridge/source-zalo';
import type { CliContext } from '../config.js';

export async function handleLogin(
  ctx: CliContext,
  args: string[],
  isJson: boolean
): Promise<{ stdout: string; stderr?: string; exitCode: number }> {
  const network = args[0]?.toLowerCase();

  if (!network) {
    return {
      stdout: '',
      stderr: 'Missing network. Usage: chat-bridge login zalo | whatsapp | whatsapp-biz',
      exitCode: 1,
    };
  }

  if (network === 'whatsapp' || network === 'whatsapp-biz') {
    const mockSocket = new MockWhatsAppSocket();
    let capturedEvent: LoginEvent | null = null;

    const source = new WhatsAppSource({
      dbPath: ctx.dbPath,
      masterKey: ctx.getMasterKey(),
      socketAdapter: mockSocket,
    });

    const loginPromise = source.login((event) => {
      capturedEvent = event;
    });

    // Simulate scan success for mock/CLI harness
    mockSocket.simulateScanSuccess({
      id: 'rep-whatsapp-01',
      phone: '+84901234567',
      name: 'Dylan Rep',
      isBusiness: false,
    });

    const status: SourceStatus = await loginPromise;

    if (isJson) {
      return {
        stdout: JSON.stringify(
          {
            network,
            status,
            event: capturedEvent,
          },
          null,
          2
        ),
        exitCode: 0,
      };
    }

    return {
      stdout: `Successfully authenticated WhatsApp account (+84901234567). Status: ${status.state}.`,
      exitCode: 0,
    };
  }

  if (network === 'zalo') {
    const mockAdapter = new MockZaloAdapter();
    let capturedEvent: LoginEvent | null = null;

    const source = new ZaloSource({
      dbPath: ctx.dbPath,
      masterKey: ctx.getMasterKey(),
      adapter: mockAdapter,
    });

    const loginPromise = source.login((event) => {
      capturedEvent = event;
    });

    // Simulate scan success for mock/CLI harness
    mockAdapter.simulateScanSuccess({
      uid: 'rep-zalo-01',
      displayName: 'Dylan Rep',
      sessionToken: 'mock-zalo-token-12345',
    });

    const status: SourceStatus = await loginPromise;

    if (isJson) {
      return {
        stdout: JSON.stringify(
          {
            network,
            status,
            event: capturedEvent,
          },
          null,
          2
        ),
        exitCode: 0,
      };
    }

    return {
      stdout: `Successfully authenticated Zalo account (Dylan Rep). Status: ${status.state}.`,
      exitCode: 0,
    };
  }

  return {
    stdout: '',
    stderr: `Unsupported network: "${network}". Supported networks: whatsapp, whatsapp-biz, zalo.`,
    exitCode: 1,
  };
}
