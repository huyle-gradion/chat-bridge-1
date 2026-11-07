import fs from 'node:fs';
import type {
  SourceContract,
  SourceStatus,
  ThreadSummary,
  Message,
  SendResult,
  NetworkKind,
} from '@chat-bridge/types';
import {
  ScenarioBuilder,
  type SyntheticScenario,
} from '@chat-bridge/testing/scenarios/scenario-builder.js';

export interface FakeSourceOptions {
  account?: string | undefined;
  scenario?: SyntheticScenario | undefined;
  messages?: Message[] | undefined;
  fixturePath?: string | undefined;
  delayMs?: number | undefined;
  initialStatus?: SourceStatus | undefined;
}

export class FakeSource implements SourceContract {
  public readonly network: NetworkKind = 'fake';
  public readonly account: string;
  private currentStatus: SourceStatus;
  private isRunning: boolean = false;
  private messageList: Message[] = [];
  private readonly delayMs: number;
  private activeTimers: NodeJS.Timeout[] = [];
  private onMessageCallback: ((message: Message) => void | Promise<void>) | null = null;

  constructor(options: FakeSourceOptions = {}) {
    this.account = options.account ?? 'rep-sales-01';
    this.delayMs = options.delayMs ?? 10;

    this.currentStatus = options.initialStatus ?? {
      state: 'connected',
      reason: 'Fake source ready and connected',
      updatedAt: new Date().toISOString(),
    };

    if (options.messages) {
      this.messageList = [...options.messages];
    } else if (options.scenario) {
      this.messageList = [...options.scenario.messages];
    } else if (options.fixturePath) {
      this.loadFixture(options.fixturePath);
    } else {
      const defaultScenario = new ScenarioBuilder({
        seed: 42,
        repAccount: this.account,
      })
        .withContacts(3)
        .buildScenario();
      this.messageList = [...defaultScenario.messages];
    }
  }

  private loadFixture(filePath: string): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      this.messageList = parsed as Message[];
    } else if (parsed && Array.isArray(parsed.messages)) {
      this.messageList = parsed.messages as Message[];
    }
  }

  public async login(): Promise<SourceStatus> {
    this.currentStatus = {
      state: 'connected',
      reason: 'Logged in to fake source',
      updatedAt: new Date().toISOString(),
    };
    return this.currentStatus;
  }

  public async start(onMessage: (message: Message) => void | Promise<void>): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.onMessageCallback = onMessage;
    this.currentStatus = {
      state: 'connected',
      reason: 'Fake source message replay running',
      updatedAt: new Date().toISOString(),
    };

    if (this.delayMs === 0) {
      for (const msg of this.messageList) {
        if (!this.isRunning) break;
        await onMessage(msg);
      }
    } else {
      this.messageList.forEach((msg, idx) => {
        const timer = setTimeout(async () => {
          if (this.isRunning && this.onMessageCallback) {
            await this.onMessageCallback(msg);
          }
        }, idx * this.delayMs);
        this.activeTimers.push(timer);
      });
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    this.onMessageCallback = null;
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers = [];
    this.currentStatus = {
      state: 'connected',
      reason: 'Fake source stopped',
      updatedAt: new Date().toISOString(),
    };
  }

  public async status(): Promise<SourceStatus> {
    return this.currentStatus;
  }

  public async chats(): Promise<ThreadSummary[]> {
    const threadMap = new Map<string, { kind: 'dm' | 'group'; name: string; lastTime: string }>();

    for (const msg of this.messageList) {
      const existing = threadMap.get(msg.thread);
      const isLater = !existing || new Date(msg.time).getTime() > new Date(existing.lastTime).getTime();

      let threadName = existing?.name;
      if (!threadName) {
        if (msg.threadKind === 'group') {
          threadName = `Group ${msg.thread}`;
        } else {
          const other = msg.direction === 'inbound' ? msg.from : msg.to[0];
          threadName = other?.displayName ?? other?.accountId ?? msg.thread;
        }
      }

      if (isLater) {
        threadMap.set(msg.thread, {
          kind: msg.threadKind,
          name: threadName,
          lastTime: msg.time,
        });
      }
    }

    // Default chat if empty
    if (threadMap.size === 0) {
      threadMap.set('chat-default', {
        kind: 'dm',
        name: 'Default Test Customer',
        lastTime: new Date().toISOString(),
      });
    }

    const summaries: ThreadSummary[] = [];
    for (const [id, info] of threadMap.entries()) {
      summaries.push({
        id,
        network: this.network,
        account: this.account,
        kind: info.kind,
        name: info.name,
        lastMessageTime: info.lastTime,
      });
    }

    return summaries;
  }

  public async history(since?: string): Promise<Message[]> {
    if (!since) {
      return [...this.messageList];
    }
    const sinceTime = new Date(since).getTime();
    return this.messageList.filter((m) => new Date(m.time).getTime() >= sinceTime);
  }

  public async send(thread: string, text: string): Promise<SendResult> {
    if (!thread || !text) {
      return { ok: false, error: 'Thread and text must not be empty' };
    }

    const outboundMsg: Message = {
      id: `fake:${this.account}:out-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      network: this.network,
      account: this.account,
      thread,
      threadKind: thread.startsWith('group') ? 'group' : 'dm',
      direction: 'outbound',
      time: new Date().toISOString(),
      from: { accountId: this.account, displayName: 'Dylan Rep' },
      to: [{ accountId: `dest-${thread}`, displayName: `Participant ${thread}` }],
      text,
    };

    this.messageList.push(outboundMsg);

    if (this.isRunning && this.onMessageCallback) {
      await this.onMessageCallback(outboundMsg);
    }

    return { ok: true, messageId: outboundMsg.id };
  }
}
