import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCsatFromBody,
  handler,
  injectLocalFeedbackSurvey,
  injectLocalCallRecord,
  getLocalCallRecord,
  clearLocalStores,
} from '../../../src/lambdas/sms-webhook';
import { FeedbackRecord } from '../../../src/types/models';
import { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(body: string, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    body,
    httpMethod: 'POST',
    path: '/sms/inbound',
    headers,
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
    isBase64Encoded: false,
  };
}

function makeFeedbackRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    correlationId: 'corr-001',
    callerPhone: '+15551234567',
    sentAt: new Date().toISOString(),
    status: 'sent',
    timeoutAt: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  };
}

function encodeBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── parseCsatFromBody tests ──────────────────────────────────────────────────

describe('parseCsatFromBody', () => {
  it('parses a valid score of 1', () => {
    expect(parseCsatFromBody('1')).toEqual({ score: 1, comment: undefined });
  });

  it('parses a valid score of 5', () => {
    expect(parseCsatFromBody('5')).toEqual({ score: 5, comment: undefined });
  });

  it('parses score with comment', () => {
    expect(parseCsatFromBody('4 Great service!')).toEqual({ score: 4, comment: 'Great service!' });
  });

  it('returns null score for out-of-range value', () => {
    expect(parseCsatFromBody('6').score).toBeNull();
    expect(parseCsatFromBody('0').score).toBeNull();
  });

  it('returns null score for non-numeric input', () => {
    expect(parseCsatFromBody('hello').score).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseCsatFromBody('  3  ').score).toBe(3);
  });
});

// ─── handler tests ────────────────────────────────────────────────────────────

describe('sms-webhook handler', () => {
  beforeEach(() => {
    process.env['USE_LOCAL_DB'] = 'true';
    process.env['SKIP_TWILIO_VALIDATION'] = 'true';
    clearLocalStores();
  });

  it('returns 200 with empty TwiML response', async () => {
    const body = encodeBody({ From: '+15551234567', Body: '5' });
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('<Response>');
  });

  it('records CSAT feedback when matching survey found', async () => {
    const survey = makeFeedbackRecord({ correlationId: 'corr-test', callerPhone: '+15551234567' });
    injectLocalFeedbackSurvey(survey);
    injectLocalCallRecord('corr-test', { feedbackStatus: 'sent' });

    const body = encodeBody({ From: '+15551234567', Body: '4 Very good' });
    const result = await handler(makeEvent(body));

    expect(result.statusCode).toBe(200);
    const record = getLocalCallRecord('corr-test');
    expect(record?.feedbackStatus).toBe('answered');
    expect((record as { csatScore?: number })?.csatScore).toBe(4);
  });

  it('deletes feedback survey after recording', async () => {
    const survey = makeFeedbackRecord({ correlationId: 'corr-del', callerPhone: '+15559999999' });
    injectLocalFeedbackSurvey(survey);
    injectLocalCallRecord('corr-del', { feedbackStatus: 'sent' });

    const body = encodeBody({ From: '+15559999999', Body: '3' });
    await handler(makeEvent(body));

    // Survey should be deleted — a second call should not find it
    const body2 = encodeBody({ From: '+15559999999', Body: '5' });
    await handler(makeEvent(body2));
    // Second call should not overwrite (no survey found)
    const record = getLocalCallRecord('corr-del');
    expect((record as { csatScore?: number })?.csatScore).toBe(3); // unchanged
  });

  it('returns 200 without recording when no survey found', async () => {
    const body = encodeBody({ From: '+15550000001', Body: '5' });
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
  });

  it('returns 200 without recording when CSAT score is invalid', async () => {
    const survey = makeFeedbackRecord({ correlationId: 'corr-invalid', callerPhone: '+15550000002' });
    injectLocalFeedbackSurvey(survey);
    injectLocalCallRecord('corr-invalid', { feedbackStatus: 'sent' });

    const body = encodeBody({ From: '+15550000002', Body: 'thanks' });
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(200);
    // feedbackStatus should remain 'sent'
    expect(getLocalCallRecord('corr-invalid')?.feedbackStatus).toBe('sent');
  });

  it('returns 400 when From is missing', async () => {
    const body = encodeBody({ Body: '5' });
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(400);
  });
});
