import http from 'node:http';
import crypto from 'node:crypto';
import type { Message, DeliveryOutcome } from '@chat-bridge/types';

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
   * Core request processor enforcing HMAC-SHA256, anti-replay, and message ingestion.
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
      return {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid Endpoint Reference' }),
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

    // Validate Headers (ADR 0008)
    const tsHeader = headers['x-bridge-timestamp'];
    const nonceHeader = headers['x-bridge-nonce'];
    const sigHeader = headers['x-bridge-signature'];

    if (!tsHeader || !nonceHeader || !sigHeader) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing security headers (Timestamp, Nonce, or Signature)' }),
      };
    }

    const ts = parseInt(tsHeader, 10);
    const nonce = nonceHeader;
    const signature = sigHeader;

    // 1. Anti-Replay Timestamp Tolerance: 5 minutes (300 seconds)
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > 300) {
      return {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Request timestamp is outside the valid 5-minute tolerance window' }),
      };
    }

    // 2. Anti-Replay Nonce Tracking
    if (this.seenNonces.has(nonce)) {
      return {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Replay detected: nonce has already been utilized' }),
      };
    }
    this.seenNonces.add(nonce);

    // 3. Cryptographic Signature Verification (HMAC-SHA256)
    const canonicalString = `openchannel:v1\npush\n${requestRef}\n${ts}\n${nonce}\n${rawBody}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.sharedSecret)
      .update(canonicalString)
      .digest('hex');

    if (
      signature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(Buffer.from(signature, 'utf-8'), Buffer.from(expectedSignature, 'utf-8'))
    ) {
      return {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid HMAC-SHA256 signature' }),
      };
    }

    // 4. Ingest and Process Messages
    let messages: Message[] = [];
    try {
      messages = JSON.parse(rawBody);
    } catch {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Malformed JSON payload body' }),
      };
    }

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
}

/**
 * Helper to generate a valid canonical HMAC-SHA256 signature for testing or sink delivery.
 */
export function signMargincePayload(
  secretKey: string,
  ref: string,
  timestamp: number,
  nonce: string,
  rawBody: string
): string {
  const canonicalString = `openchannel:v1\npush\n${ref}\n${timestamp}\n${nonce}\n${rawBody}`;
  return crypto.createHmac('sha256', secretKey).update(canonicalString).digest('hex');
}
