export interface MarginceInboundParty {
  account?: string | undefined;
  email?: string | undefined;
  name?: string | undefined;
}

export interface MarginceInboundArrival {
  message_id: string;
  thread_id?: string | undefined;
  occurred_at?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  from?: MarginceInboundParty | undefined;
  to?: MarginceInboundParty | undefined;
  participants?: MarginceInboundParty[] | undefined;
}

export interface MargincePushHeaders {
  'X-Margince-Timestamp': string;
  'X-Margince-Nonce': string;
  'X-Margince-Signature': string;
}

