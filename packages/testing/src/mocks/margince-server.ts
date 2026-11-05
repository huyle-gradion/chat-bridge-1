import http from 'node:http';
import crypto from 'node:crypto';
import type {
  Message,
  DeliveryOutcome,
  MarginceInboundArrival,
} from '@chat-bridge/types';

export interface MarginceServerOptions {
  sharedSecret?: string | undefined;
  ref?: string | undefined;
  port?: number | undefined;
}

export interface ReceivedRequest {
  ref: string;
  timestamp: number;
  nonce: string;
  signature: string;
  messages: Message[];
  arrival?: MarginceInboundArrival | undefined;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class MockMarginceServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private readonly sharedSecret: string;
  private readonly ref: string;

  // In-memory state
  private receivedMessages: Message[] = [];
  private receivedArrivals: MarginceInboundArrival[] = [];
  private receivedRequests: ReceivedRequest[] = [];
  private seenNonces = new Set<string>();
  private messageIdsSeen = new Set<string>();

  // Fault simulation
  private simulatedRateLimitCount: number = 0;
  private simulatedRetryAfterSec: number = 1;
  private simulatedErrorCount: number = 0;
  private simulatedErrorCode: number = 500;

  constructor(options: MarginceServerOptions = {}) {
    this.sharedSecret = options.sharedSecret ?? 'test-secret-key-42';
    this.ref = options.ref ?? 'oc_test_ref';
  }

  public async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => {
          rawBody += chunk.toString('utf-8');
        });
        req.on('end', async () => {
          const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
          }

          const response = await this.processRequest(req.method || 'GET', url.pathname, headers, rawBody);
          res.writeHead(response.status, response.headers);
          res.end(response.body);
        });
      });

      this.server.on('error', reject);

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.port = addr.port;
          resolve(this.getUrl());
        } else {
          reject(new Error('Failed to obtain loopback address for MockMarginceServer'));
        }
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public getConnectionString(): string {
    const host = this.port ? `127.0.0.1:${this.port}` : 'crm.example.com';
    return `margince://${host}/openchannel?ref=${this.ref}&key=${this.sharedSecret}`;
  }

  public getReceivedMessages(): Message[] {
    return [...this.receivedMessages];
  }

  public getReceivedArrivals(): MarginceInboundArrival[] {
    return [...this.receivedArrivals];
  }

  public getReceivedRequests(): ReceivedRequest[] {
    return [...this.receivedRequests];
  }

  public simulateRateLimit(count: number = 1, retryAfterSec: number = 1): void {
    this.simulatedRateLimitCount = count;
    this.simulatedRetryAfterSec = retryAfterSec;
  }

  public simulateFailure(count: number = 1, statusCode: number = 500): void {
    this.simulatedErrorCount = count;
    this.simulatedErrorCode = statusCode;
  }

  public reset(): void {
    this.receivedMessages = [];
    this.receivedArrivals = [];
    this.receivedRequests = [];
    this.seenNonces.clear();
    this.messageIdsSeen.clear();
    this.simulatedRateLimitCount = 0;
    this.simulatedErrorCount = 0;
  }

  /**
   * In-memory Fetch-compatible dispatcher.
   * Enables hermetic testing in secure, network-isolated sandboxes with zero port binding.
   */
  public async dispatch(urlOrPath: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(urlOrPath, 'http://127.0.0.1');
    const method = init.method || 'GET';
    const headers: Record<string, string | undefined> = {};

    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((val, key) => {
          headers[key.toLowerCase()] = val;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          if (k && v !== undefined) {
            headers[k.toLowerCase()] = v;
          }
        }
      } else {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    const rawBody = typeof init.body === 'string' ? init.body : '';
    const res = await this.processRequest(method, url.pathname, headers, rawBody);

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
  }

  /**
   * Core request processor enforcing Margince OpenChannel HMAC-SHA256,
   * anti-replay, and arrival ingestion.
   */
  public async processRequest(
    method: string,
    pathname: string,
    headers: Record<string, string | undefined>,
    rawBody: string
  ): Promise<MockResponse> {
    // Health check or test ping endpoint
    if (method === 'GET' && (pathname === '/health' || pathname === '/ping')) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, status: 'ready', provider: 'MockMargince' }),
      };
    }

    // Ingestion endpoint: POST /webhooks/ext/openchannel/receive/{ref}
    const expectedPathPrefix = '/webhooks/ext/openchannel/receive/';
    if (method !== 'POST' || !pathname.startsWith(expectedPathPrefix)) {
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Endpoint Not Found' }),
      };
    }

    const requestRef = pathname.slice(expectedPathPrefix.length);
    if (requestRef !== this.ref) {
      // Margince returns opaque 401 with empty body on unknown or unaccepted ref
      return {
        status: 401,
        headers: {},
        body: '',
      };
    }

    // Simulated Faults
    if (this.simulatedRateLimitCount > 0) {
      this.simulatedRateLimitCount--;
      return {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(this.simulatedRetryAfterSec),
        },
        body: JSON.stringify({ error: 'Rate limit exceeded. Slow down.' }),
      };
    }

    if (this.simulatedErrorCount > 0) {
      this.simulatedErrorCount--;
      return {
        status: this.simulatedErrorCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error' }),
      };
    }

    // Determine mode: Canonical Margince vs Legacy Bridge
    const hasMarginceHeaders = Boolean(
      headers['x-margince-timestamp'] ||
      headers['x-margince-nonce'] ||
      headers['x-margince-signature']
    );

    const tsHeader = headers['x-margince-timestamp'] ?? headers['x-bridge-timestamp'];
    const nonceHeader = headers['x-margince-nonce'] ?? headers['x-bridge-nonce'];
    const sigHeader = headers['x-margince-signature'] ?? headers['x-bridge-signature'];

    if (!tsHeader || !nonceHeader || !sigHeader) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing security headers (Timestamp, Nonce, or Signature)' }),
      };
    }

    // Grammar check for nonce
    const nonceRegex = hasMarginceHeaders ? /^[0-9a-fA-F]+$/ : /^[0-9a-fA-F-]+$/;
    if (!nonceRegex.test(nonceHeader) || nonceHeader.length > 64) {
      return {
        status: hasMarginceHeaders ? 401 : 400,
        headers: hasMarginceHeaders ? {} : { 'Content-Type': 'application/json' },
        body: hasMarginceHeaders ? '' : JSON.stringify({ error: 'Invalid nonce format' }),
      };
    }

    const ts = parseInt(tsHeader, 10);
    if (Number.isNaN(ts)) {
      return {
        status: hasMarginceHeaders ? 401 : 400,
        headers: hasMarginceHeaders ? {} : { 'Content-Type': 'application/json' },
        body: hasMarginceHeaders ? '' : JSON.stringify({ error: 'Invalid timestamp format' }),
      };
    }

    const nonce = nonceHeader;
    const signature = sigHeader;

    // 1. Anti-Replay Timestamp Tolerance: 15 minutes (900 seconds) max skew (legacy tests check 300s)
    const nowSec = Math.floor(Date.now() / 1000);
    const maxSkewSec = hasMarginceHeaders ? 900 : 300;
    if (Math.abs(nowSec - ts) > maxSkewSec) {
      return {
        status: 401,
        headers: hasMarginceHeaders ? {} : { 'Content-Type': 'application/json' },
        body: hasMarginceHeaders
          ? ''
          : JSON.stringify({ error: 'Request timestamp is outside the valid tolerance window' }),
      };
    }

    // 2. Anti-Replay Nonce Tracking
    if (this.seenNonces.has(nonce)) {
      return {
        status: hasMarginceHeaders ? 401 : 409,
        headers: hasMarginceHeaders ? {} : { 'Content-Type': 'application/json' },
        body: hasMarginceHeaders
          ? ''
          : JSON.stringify({ error: 'Replay detected: nonce has already been utilized' }),
      };
    }
    this.seenNonces.add(nonce);

    // 3. Cryptographic Signature Verification (HMAC-SHA256)
    // Primary: margince-inbound-v1 scope, slug 'receive'
    // Legacy fallback: openchannel:v1 / push
    const canonicalMargince = `margince-inbound-v1\nreceive\n${requestRef}\n${ts}\n${nonce}\n${rawBody}`;
    const digestMargince = crypto
      .createHmac('sha256', this.sharedSecret)
      .update(canonicalMargince)
      .digest('hex');

    const canonicalLegacy = `openchannel:v1\npush\n${requestRef}\n${ts}\n${nonce}\n${rawBody}`;
    const digestLegacy = crypto
      .createHmac('sha256', this.sharedSecret)
      .update(canonicalLegacy)
      .digest('hex');

    const expectedSignatures = [
      `sha256=${digestMargince}`,
      digestMargince,
      `sha256=${digestLegacy}`,
      digestLegacy,
    ];

    let verified = false;
    for (const candidate of expectedSignatures) {
      if (
        signature.length === candidate.length &&
        crypto.timingSafeEqual(Buffer.from(signature, 'utf-8'), Buffer.from(candidate, 'utf-8'))
      ) {
        verified = true;
        break;
      }
    }

    if (!verified) {
      return {
        status: 401,
        headers: hasMarginceHeaders ? {} : { 'Content-Type': 'application/json' },
        body: hasMarginceHeaders ? '' : JSON.stringify({ error: 'Invalid HMAC-SHA256 signature' }),
      };
    }

    // 4. Ingest and Process Message / Arrival
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Malformed JSON payload body' }),
      };
    }

    // Single arrival document (Margince OpenChannel contract)
    if (typeof parsed === 'object' && parsed !== null && 'message_id' in parsed) {
      const arrival = parsed as MarginceInboundArrival;
      this.receivedArrivals.push(arrival);

      const msg: Message = {
        id: arrival.message_id,
        network: 'fake',
        account: arrival.to?.account ?? 'unknown_account',
        thread: arrival.thread_id ?? arrival.message_id,
        threadKind: arrival.participants && arrival.participants.length > 0 ? 'group' : 'dm',
        direction: 'inbound',
        time: arrival.occurred_at ?? new Date(ts * 1000).toISOString(),
        from: {
          accountId: arrival.from?.account ?? 'unknown_from',
          displayName: arrival.from?.name ?? 'Unknown Sender',
        },
        to: arrival.to
          ? [
              {
                accountId: arrival.to.account ?? 'unknown_to',
                displayName: arrival.to.name ?? 'Sales Rep',
              },
            ]
          : [],
        participants: arrival.participants?.map((p) => ({
          accountId: p.account ?? 'unknown_participant',
          displayName: p.name ?? 'Participant',
        })),
        text: arrival.body ?? '',
      };

      this.receivedMessages.push(msg);
      this.receivedRequests.push({
        ref: requestRef,
        timestamp: ts,
        nonce,
        signature,
        messages: [msg],
        arrival,
      });

      // Margince returns 202 Accepted with empty body
      return {
        status: 202,
        headers: {},
        body: '',
      };
    }

    // Batch messages array (Legacy format fallback)
    if (Array.isArray(parsed)) {
      const messages = parsed as Message[];
      const outcomes: DeliveryOutcome[] = [];

      for (const msg of messages) {
        if (this.messageIdsSeen.has(msg.id)) {
          outcomes.push({
            messageId: msg.id,
            outcome: 'duplicate',
            reason: 'Message already ingested previously',
          });
        } else {
          this.messageIdsSeen.add(msg.id);
          this.receivedMessages.push(msg);
          outcomes.push({
            messageId: msg.id,
            outcome: 'accepted',
          });
        }
      }

      this.receivedRequests.push({
        ref: requestRef,
        timestamp: ts,
        nonce,
        signature,
        messages,
      });

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: outcomes }),
      };
    }

    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unrecognized payload format' }),
    };
  }
}

/**
 * Helper to generate a valid canonical HMAC-SHA256 signature for Margince OpenChannel.
 */
export function signMargincePayload(
  secretKey: string,
  ref: string,
  timestamp: number,
  nonce: string,
  rawBody: string,
  scope: string = 'margince-inbound-v1',
  slug: string = 'receive'
): string {
  const canonicalString = `${scope}\n${slug}\n${ref}\n${timestamp}\n${nonce}\n${rawBody}`;
  const digest = crypto.createHmac('sha256', secretKey).update(canonicalString).digest('hex');
  return `sha256=${digest}`;
}
