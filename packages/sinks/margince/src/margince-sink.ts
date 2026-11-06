import crypto from 'node:crypto';
import type {
  SinkContract,
  SinkLimits,
  ConfigureResult,
  TestResult,
  DeliveryOutcome,
  SinkHealthStatus,
  Message,
  MarginceInboundArrival,
} from '@chat-bridge/types';

export interface MarginceSinkOptions {
  dispatcher?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}

export class MarginceSink implements SinkContract {
  public readonly sinkId = 'margince';
  public readonly name = 'Margince CRM';
  public readonly limits: SinkLimits = {
    batchSize: 20,
    requestsPerMinute: 60,
    defaultBackoffMs: 1000,
  };

  private configured = false;
  private baseUrl = '';
  private ref = '';
  private secret = '';
  private consecutiveFailures = 0;
  private lastDeliveryTime: string | undefined;
  private readonly dispatcher: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(options: MarginceSinkOptions = {}) {
    this.dispatcher = options.dispatcher ?? ((url, init) => fetch(url, init));
  }

  public async configure(settings: Record<string, unknown>): Promise<ConfigureResult> {
    const connStr = settings.connectionString;
    if (typeof connStr !== 'string' || !connStr.trim()) {
      return {
        valid: false,
        errors: {
          connectionString:
            'Please enter a valid Margince connection string (margince://<host>/openchannel?ref=<ref>&key=<secret>).',
        },
      };
    }

    try {
      let normalized = connStr.trim();
      if (normalized.startsWith('margince://')) {
        normalized = normalized.replace(/^margince:\/\//, 'http://');
      }

      const url = new URL(normalized);
      const parsedRef = url.searchParams.get('ref');
      const parsedKey = url.searchParams.get('key') ?? url.searchParams.get('secret');

      if (!parsedRef || !parsedKey) {
        return {
          valid: false,
          errors: {
            connectionString:
              'Margince connection string is missing required "ref" or "key" query parameter.',
          },
        };
      }

      const host = url.host;
      const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      const scheme = isLoopback ? 'http' : 'https';

      this.baseUrl = `${scheme}://${host}`;
      this.ref = parsedRef;
      this.secret = parsedKey;
      this.configured = true;
      this.consecutiveFailures = 0;

      return { valid: true };
    } catch {
      return {
        valid: false,
        errors: {
          connectionString:
            'Invalid connection string format. Please verify the URL structure.',
        },
      };
    }
  }

  public async test(): Promise<TestResult> {
    if (!this.configured) {
      return {
        ok: false,
        message: 'Margince connection is not configured. Please enter a connection string.',
      };
    }

    try {
      const probeUrl = `${this.baseUrl}/health`;
      const res = await this.dispatcher(probeUrl, {
        method: 'GET',
      });

      if (res.ok) {
        return {
          ok: true,
          message: 'Connection successful. Ready to send messages to Margince.',
        };
      }

      return {
        ok: false,
        message: 'Connection failed. Please check your connection string and ensure Margince is reachable.',
      };
    } catch {
      return {
        ok: false,
        message: 'Connection failed. Unable to reach Margince server at the specified address.',
      };
    }
  }

  public async deliver(batch: Message[]): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];

    for (const msg of batch) {
      let bodyText = msg.placeholder
        ? msg.text
          ? `${msg.placeholder}\n${msg.text}`
          : msg.placeholder
        : msg.text;

      if (bodyText.length > 32768) {
        bodyText = bodyText.slice(0, 32768);
      }

      const arrival: MarginceInboundArrival = {
        message_id: msg.id,
        thread_id: msg.thread,
        occurred_at: msg.time,
        body: bodyText,
        from: {
          account: msg.from.accountId,
          name: msg.from.displayName,
          email: msg.from.phone,
        },
        to: msg.to[0]
          ? {
              account: msg.to[0].accountId,
              name: msg.to[0].displayName,
              email: msg.to[0].phone,
            }
          : undefined,
        participants:
          msg.participants && msg.participants.length <= 50
            ? msg.participants.map((p) => ({
                account: p.accountId,
                name: p.displayName,
                email: p.phone,
              }))
            : undefined,
      };

      const rawBody = JSON.stringify(arrival);
      const ts = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomBytes(16).toString('hex');
      const canonicalString = `margince-inbound-v1\nreceive\n${this.ref}\n${ts}\n${nonce}\n${rawBody}`;
      const digest = crypto
        .createHmac('sha256', this.secret)
        .update(canonicalString)
        .digest('hex');
      const signature = `sha256=${digest}`;

      const targetUrl = `${this.baseUrl}/webhooks/ext/openchannel/receive/${this.ref}`;

      try {
        const res = await this.dispatcher(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Margince-Timestamp': String(ts),
            'X-Margince-Nonce': nonce,
            'X-Margince-Signature': signature,
            'X-Signature': signature,
          },
          body: rawBody,
        });

        if (res.status === 202 || res.status === 200) {
          this.consecutiveFailures = 0;
          this.lastDeliveryTime = new Date().toISOString();
          outcomes.push({
            messageId: msg.id,
            outcome: 'accepted',
          });
        } else if (res.status === 429) {
          this.consecutiveFailures++;
          const retryHeader = res.headers.get('retry-after');
          const retrySec = retryHeader ? parseInt(retryHeader, 10) : 1;
          const retryAfterMs = (Number.isNaN(retrySec) ? 1 : retrySec) * 1000;

          outcomes.push({
            messageId: msg.id,
            outcome: 'refused',
            statusCode: 429,
            retryAfterMs,
            reason: 'Margince rate limit reached. Backing off before retrying.',
          });
        } else {
          this.consecutiveFailures++;
          outcomes.push({
            messageId: msg.id,
            outcome: 'refused',
            statusCode: res.status,
            reason: `Message delivery refused by Margince (HTTP ${res.status}).`,
          });
        }
      } catch {
        this.consecutiveFailures++;
        outcomes.push({
          messageId: msg.id,
          outcome: 'refused',
          statusCode: 503,
          reason: 'Network error connecting to Margince server.',
        });
      }
    }

    return outcomes;
  }

  public async health(): Promise<SinkHealthStatus> {
    if (!this.configured) {
      return {
        health: 'down',
        reason: 'Margince sink is not configured.',
        consecutiveFailures: this.consecutiveFailures,
      };
    }

    if (this.consecutiveFailures === 0) {
      return {
        health: 'ok',
        reason: 'Margince connection is active and operational.',
        lastSuccessfulDelivery: this.lastDeliveryTime,
        consecutiveFailures: 0,
      };
    }

    if (this.consecutiveFailures < 5) {
      return {
        health: 'degraded',
        reason: 'Margince connection is experiencing transient delivery failures.',
        lastSuccessfulDelivery: this.lastDeliveryTime,
        consecutiveFailures: this.consecutiveFailures,
      };
    }

    return {
      health: 'down',
      reason: 'Margince connection is down after multiple consecutive failures.',
      lastSuccessfulDelivery: this.lastDeliveryTime,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
