export interface AuthenticatedUser {
  id: string;
  phone: string;
  name: string;
  isBusiness: boolean;
}

export interface RawInboundMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string | undefined;
  };
  messageTimestamp: number;
  pushName?: string | undefined;
  message?: {
    conversation?: string | undefined;
    extendedTextMessage?: { text: string } | undefined;
    imageMessage?: { caption?: string | undefined; mimetype?: string | undefined; fileLength?: number | string | undefined } | undefined;
    productMessage?: {
      product?: {
        productId: string;
        title: string;
        priceAmount1000: number;
        currencyCode: string;
      } | undefined;
      businessOwnerJid?: string | undefined;
    } | undefined;
    buttonsResponseMessage?: {
      selectedButtonId: string;
      selectedDisplayText: string;
    } | undefined;
  } | undefined;
}

export type QrListener = (qrData: string, message: string) => void;
export type PairingCodeListener = (code: string, ttlSeconds: number) => void;
export type ConnectionListener = (user: AuthenticatedUser) => void;
export type DisconnectionListener = (reason: string) => void;
export type RawMessageListener = (message: RawInboundMessage) => void;

export interface WhatsAppSocketAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  onQr(listener: QrListener): void;
  onPairingCode(listener: PairingCodeListener): void;
  onConnected(listener: ConnectionListener): void;
  onDisconnected(listener: DisconnectionListener): void;
  onMessage(listener: RawMessageListener): void;
  sendMessage(toJid: string, text: string): Promise<string>;
  close(): void;
}
