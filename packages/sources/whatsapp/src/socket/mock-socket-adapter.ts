import type {
  WhatsAppSocketAdapter,
  AuthenticatedUser,
  RawInboundMessage,
  QrListener,
  PairingCodeListener,
  ConnectionListener,
  DisconnectionListener,
  RawMessageListener,
} from './socket-adapter.js';
import { generatePairingCode } from '../auth/pairing-code.js';

export class MockWhatsAppSocket implements WhatsAppSocketAdapter {
  public connectionAttempts: number = 0;
  public isConnected: boolean = false;
  public currentUser: AuthenticatedUser | null = null;

  private qrListeners: QrListener[] = [];
  private pairingCodeListeners: PairingCodeListener[] = [];
  private connectedListeners: ConnectionListener[] = [];
  private disconnectedListeners: DisconnectionListener[] = [];
  private messageListeners: RawMessageListener[] = [];
  private qrCounter: number = 0;

  public async connect(): Promise<void> {
    this.connectionAttempts++;
    if (this.currentUser) {
      // Reconnection using saved user credentials
      this.isConnected = true;
      for (const cb of this.connectedListeners) {
        cb(this.currentUser);
      }
      return;
    }

    // Default behavior: Emit initial QR code event
    this.qrCounter++;
    const qrData = `mock-whatsapp-qr-payload-${this.qrCounter}`;
    const instruction = 'Open WhatsApp on your phone -> Linked Devices -> Link a Device';
    for (const cb of this.qrListeners) {
      cb(qrData, instruction);
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
    for (const cb of this.disconnectedListeners) {
      cb('Disconnected by client');
    }
  }

  public async requestPairingCode(_phoneNumber: string): Promise<string> {
    const code = generatePairingCode();
    for (const cb of this.pairingCodeListeners) {
      cb(code, 60);
    }
    return code;
  }

  public onQr(listener: QrListener): void {
    this.qrListeners.push(listener);
  }

  public onPairingCode(listener: PairingCodeListener): void {
    this.pairingCodeListeners.push(listener);
  }

  public onConnected(listener: ConnectionListener): void {
    this.connectedListeners.push(listener);
  }

  public onDisconnected(listener: DisconnectionListener): void {
    this.disconnectedListeners.push(listener);
  }

  public onMessage(listener: RawMessageListener): void {
    this.messageListeners.push(listener);
  }

  public async sendMessage(_toJid: string, _text: string): Promise<string> {
    return `mock-sent-wa-${Date.now()}`;
  }

  public close(): void {
    this.isConnected = false;
    this.qrListeners = [];
    this.pairingCodeListeners = [];
    this.connectedListeners = [];
    this.disconnectedListeners = [];
    this.messageListeners = [];
  }

  // Test simulation methods

  public simulateScanSuccess(user: AuthenticatedUser): void {
    this.isConnected = true;
    this.currentUser = user;
    for (const cb of this.connectedListeners) {
      cb(user);
    }
  }

  public simulatePairingSuccess(user: AuthenticatedUser): void {
    this.simulateScanSuccess(user);
  }

  public simulateQrTimeout(): void {
    this.qrCounter++;
    const refreshedQr = `mock-whatsapp-qr-payload-${this.qrCounter}`;
    const message = 'Click to refresh QR code';
    for (const cb of this.qrListeners) {
      cb(refreshedQr, message);
    }
  }

  public simulateInboundRawMessage(message: RawInboundMessage): void {
    for (const cb of this.messageListeners) {
      cb(message);
    }
  }
}
