import type {
  ZaloAdapter,
  ZaloUserSession,
  ZaloRawMessage,
  ZaloQrCallback,
  ZaloConnectedCallback,
  ZaloTakeoverCallback,
  ZaloMessageCallback,
} from './zalo-adapter.js';

export class MockZaloAdapter implements ZaloAdapter {
  public getUserInfoCallCount: number = 0;
  public currentUser: ZaloUserSession | null = null;
  public isConnected: boolean = false;

  private qrCallbacks: ZaloQrCallback[] = [];
  private connectedCallbacks: ZaloConnectedCallback[] = [];
  private takeoverCallbacks: ZaloTakeoverCallback[] = [];
  private messageCallbacks: ZaloMessageCallback[] = [];
  private qrCounter: number = 0;

  public async connect(): Promise<void> {
    if (this.currentUser) {
      this.isConnected = true;
      for (const cb of this.connectedCallbacks) {
        cb(this.currentUser);
      }
      return;
    }

    this.qrCounter++;
    const qrData = `mock-zalo-qr-code-${this.qrCounter}`;
    const message = 'Open Zalo on your phone -> Scan QR Code to connect';
    for (const cb of this.qrCallbacks) {
      cb(qrData, message);
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  public async getUserInfo(uid: string): Promise<{ uid: string; displayName: string; phone?: string }> {
    this.getUserInfoCallCount++;
    return {
      uid,
      displayName: 'Viet Tran (Cached Profile)',
      phone: '84901234567',
    };
  }

  public onQr(cb: ZaloQrCallback): void {
    this.qrCallbacks.push(cb);
  }

  public onConnected(cb: ZaloConnectedCallback): void {
    this.connectedCallbacks.push(cb);
  }

  public onTakeover(cb: ZaloTakeoverCallback): void {
    this.takeoverCallbacks.push(cb);
  }

  public onMessage(cb: ZaloMessageCallback): void {
    this.messageCallbacks.push(cb);
  }

  public async sendMessage(_thread: string, _text: string): Promise<string> {
    return `mock-zalo-msg-${Date.now()}`;
  }

  public close(): void {
    this.isConnected = false;
    this.qrCallbacks = [];
    this.connectedCallbacks = [];
    this.takeoverCallbacks = [];
    this.messageCallbacks = [];
  }

  // Simulation helpers

  public simulateScanSuccess(session: ZaloUserSession): void {
    this.isConnected = true;
    this.currentUser = session;
    for (const cb of this.connectedCallbacks) {
      cb(session);
    }
  }

  public simulateTakeoverConflict(): void {
    this.isConnected = false;
    for (const cb of this.takeoverCallbacks) {
      cb();
    }
  }

  public simulateInboundMessage(message: ZaloRawMessage): void {
    for (const cb of this.messageCallbacks) {
      cb(message);
    }
  }
}
