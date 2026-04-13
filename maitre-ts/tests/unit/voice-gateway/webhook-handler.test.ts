/**
 * Unit tests for the webhook handler (POST /voice/inbound) and health check (GET /health).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { createWebhookHandler, setDraining } from '../../../src/voice-gateway/webhook-handler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(overrides?: { host?: string; authToken?: string }): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const router = createWebhookHandler(null, null, {
    twilioAuthToken: overrides?.authToken ?? 'test-auth-token',
    host: overrides?.host ?? 'example.ngrok.io',
  });
  app.use(router);
  return app;
}

// ─── Health check ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  afterEach(() => {
    setDraining(false);
  });

  it('returns 200 with { status: "ok" } when not draining', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 503 with { status: "draining" } when draining', async () => {
    setDraining(true);
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'draining' });
  });

  it('returns 200 again after draining is cleared', async () => {
    setDraining(true);
    setDraining(false);
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

// ─── POST /voice/inbound ──────────────────────────────────────────────────────

describe('POST /voice/inbound', () => {
  beforeEach(() => {
    // Run in non-production so signature validation is skipped
    vi.stubEnv('NODE_ENV', 'development');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 200 with XML content-type', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/voice/inbound')
      .send('CallSid=CA123&From=%2B15551234567&To=%2B15559876543&CallStatus=ringing');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
  });

  it('TwiML response contains <Connect> and <Stream> elements', async () => {
    const app = buildApp({ host: 'test.example.com' });
    const res = await request(app)
      .post('/voice/inbound')
      .send('CallSid=CA123&From=%2B15551234567&To=%2B15559876543&CallStatus=ringing');

    expect(res.text).toContain('<Connect>');
    expect(res.text).toContain('<Stream');
    expect(res.text).toContain('wss://test.example.com/media-stream');
  });

  it('TwiML response is wrapped in <Response> root element', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/voice/inbound')
      .send('CallSid=CA123&From=%2B15551234567&To=%2B15559876543&CallStatus=ringing');

    expect(res.text).toMatch(/^<\?xml/);
    expect(res.text).toContain('<Response>');
    expect(res.text).toContain('</Response>');
  });

  it('uses the configured host in the stream URL', async () => {
    const app = buildApp({ host: 'my-custom-host.io' });
    const res = await request(app)
      .post('/voice/inbound')
      .send('CallSid=CA123&From=%2B15551234567&To=%2B15559876543&CallStatus=ringing');

    expect(res.text).toContain('wss://my-custom-host.io/media-stream');
  });
});

// ─── Error TwiML ──────────────────────────────────────────────────────────────

describe('POST /voice/inbound error TwiML', () => {
  it('returns <Say> and <Hangup> TwiML when an error occurs', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    // Force an error by making the twiml.VoiceResponse constructor throw
    const twilioModule = await import('twilio');
    const originalVoiceResponse = twilioModule.default.twiml.VoiceResponse;

    let callCount = 0;
    vi.spyOn(twilioModule.default.twiml, 'VoiceResponse').mockImplementation(function (this: unknown) {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated error');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new (originalVoiceResponse as any)();
    } as unknown as typeof originalVoiceResponse);

    const app = buildApp();
    const res = await request(app)
      .post('/voice/inbound')
      .send('CallSid=CA123&From=%2B15551234567&To=%2B15559876543&CallStatus=ringing');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Say>');
    expect(res.text).toContain('An error occurred');
    expect(res.text).toContain('<Hangup');

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
});
