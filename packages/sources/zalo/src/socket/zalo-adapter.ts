export interface ZaloUserSession {
  uid: string;
  displayName: string;
  sessionToken: string;
}

export interface ZaloRawMessage {
  msgId: string;
  uidFrom: string;
  content: string;
  timestamp: number;
  groupId?: string | undefined;
}

export type ZaloQrCallback = (qrData: string, message: string) => void;
export type ZaloConnectedCallback = (session: ZaloUserSession) => void;
export type ZaloTakeoverCallback = () => void;
export type ZaloMessageCallback = (msg: ZaloRawMessage) => void;

export interface ZaloAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getUserInfo(uid: string): Promise<{ uid: string; displayName: string; phone?: string }>;
  onQr(cb: ZaloQrCallback): void;
  onConnected(cb: ZaloConnectedCallback): void;
  onTakeover(cb: ZaloTakeoverCallback): void;
  onMessage(cb: ZaloMessageCallback): void;
  sendMessage(thread: string, text: string): Promise<string>;
  close(): void;
}
