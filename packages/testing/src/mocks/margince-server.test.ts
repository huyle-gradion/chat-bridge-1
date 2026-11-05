import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockMarginceServer,
  signMargincePayload,
} from './margince-server.js';
import type { MarginceInboundArrival } from '@chat-bridge/types';

describe('MockMarginceServer', () => {
  let server: MockMarginceServer;
  const testRef = 'oc_test_ref_123';
  const testSecret = 'test_secret_key_abc';

  beforeEach(() => {
    server = new MockMarginceServer({
      ref: testRef,
      sharedSecret: testSecret,
    });
  });

  it('responds with 200 on health check endpoint', async () => {
    const res = await server.dispatch('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('accepts valid Margince arrival with X-Margince headers and returns 202 Accepted', async () => {
    const arrival: MarginceInboundArrival = {
      message_id: 'whatsapp:rep-01:msg-001',
      thread_id: 'thread-customer-99',
      occurred_at: new Date().toISOString(),
      subject: 'Order inquiry',
      body: 'Can I get a quotation for 5 licenses?',
      from: {
        account: 'cust-99',
        name: 'Jordan Customer',
        email: 'jordan@example.com',
      },
      to: {
        account: 'rep-01',
        name: 'Dylan Rep',
        email: 'dylan@company.com',
      },
    };

    const rawBody = JSON.stringify(arrival);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'a1b2c3d4e5f60718';
    const signature = signMargincePayload(testSecret, testRef, ts, nonce, rawBody);

    const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${testRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Margince-Timestamp': String(ts),
        'X-Margince-Nonce': nonce,
        'X-Margince-Signature': signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    expect(server.getReceivedArrivals().length).toBe(1);
    expect(server.getReceivedArrivals()[0]?.message_id).toBe(arrival.message_id);
    expect(server.getReceivedMessages().length).toBe(1);
    expect(server.getReceivedMessages()[0]?.id).toBe(arrival.message_id);
  });

  it('refuses request with invalid signature with opaque 401 Unauthorized', async () => {
    const rawBody = JSON.stringify({ message_id: 'msg-002', body: 'Tampered' });
    const ts = Math.floor(Date.now() / 1000);
    const nonce = '0011223344556677';
    const badSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${testRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Margince-Timestamp': String(ts),
        'X-Margince-Nonce': nonce,
        'X-Margince-Signature': badSignature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
  });

  it('refuses replayed nonces with 401 Unauthorized', async () => {
    const rawBody = JSON.stringify({ message_id: 'msg-003', body: 'First send' });
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'feedface12345678';
    const signature = signMargincePayload(testSecret, testRef, ts, nonce, rawBody);

    const headers = {
      'Content-Type': 'application/json',
      'X-Margince-Timestamp': String(ts),
      'X-Margince-Nonce': nonce,
      'X-Margince-Signature': signature,
    };

    const firstRes = await server.dispatch(`/webhooks/ext/openchannel/receive/${testRef}`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
    expect(firstRes.status).toBe(202);

    const secondRes = await server.dispatch(`/webhooks/ext/openchannel/receive/${testRef}`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
    expect(secondRes.status).toBe(401);
  });

  it('refuses timestamp outside skew window with 401 Unauthorized', async () => {
    const rawBody = JSON.stringify({ message_id: 'msg-004', body: 'Stale' });
    const staleTs = Math.floor(Date.now() / 1000) - 1000; // > 15 minutes skew
    const nonce = 'deadbeef87654321';
    const signature = signMargincePayload(testSecret, testRef, staleTs, nonce, rawBody);

    const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${testRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Margince-Timestamp': String(staleTs),
        'X-Margince-Nonce': nonce,
        'X-Margince-Signature': signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limit is simulated', async () => {
    server.simulateRateLimit(1, 2);
    const rawBody = JSON.stringify({ message_id: 'msg-005', body: 'Rate limit test' });
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'cafebabe99887766';
    const signature = signMargincePayload(testSecret, testRef, ts, nonce, rawBody);

    const res = await server.dispatch(`/webhooks/ext/openchannel/receive/${testRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Margince-Timestamp': String(ts),
        'X-Margince-Nonce': nonce,
        'X-Margince-Signature': signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(429);
  });
});

