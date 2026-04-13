import { describe, it, expect, beforeEach } from 'vitest';
import { computeAnalytics, injectLocalRecords, handler } from '../../../src/lambdas/analytics-api';
import { CallRecord } from '../../../src/types/models';
import { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    correlationId: 'corr-001',
    callSid: 'CA001',
    callerPhone: '+15551234567',
    locationId: 'loc-001',
    startTime: '2025-01-15T14:30:00Z',
    endTime: '2025-01-15T14:35:00Z',
    durationSeconds: 300,
    terminationReason: 'caller_hangup',
    inquiryTopics: [],
    reservationActions: [],
    feedbackStatus: 'disabled',
    ...overrides,
  };
}

function makeEvent(params: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    queryStringParameters: params,
    httpMethod: 'GET',
    path: '/api/analytics',
    headers: {},
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
    body: null,
    isBase64Encoded: false,
  };
}

// ─── computeAnalytics unit tests ──────────────────────────────────────────────

describe('computeAnalytics', () => {
  it('returns zero totals for empty records', () => {
    const report = computeAnalytics([]);
    expect(report.totalCalls).toBe(0);
    expect(report.reservations.created).toBe(0);
    expect(report.reservations.conversionRate).toBe(0);
    expect(report.peakHours).toHaveLength(0);
  });

  it('counts total calls', () => {
    const records = [makeRecord({ correlationId: 'c1' }), makeRecord({ correlationId: 'c2' })];
    expect(computeAnalytics(records).totalCalls).toBe(2);
  });

  it('aggregates calls by hour', () => {
    const records = [
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T14:00:00Z' }),
      makeRecord({ correlationId: 'c2', startTime: '2025-01-15T14:30:00Z' }),
      makeRecord({ correlationId: 'c3', startTime: '2025-01-15T15:00:00Z' }),
    ];
    const report = computeAnalytics(records);
    expect(report.callsByPeriod.hour['2025-01-15T14']).toBe(2);
    expect(report.callsByPeriod.hour['2025-01-15T15']).toBe(1);
  });

  it('aggregates calls by day', () => {
    const records = [
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T10:00:00Z' }),
      makeRecord({ correlationId: 'c2', startTime: '2025-01-15T14:00:00Z' }),
      makeRecord({ correlationId: 'c3', startTime: '2025-01-16T10:00:00Z' }),
    ];
    const report = computeAnalytics(records);
    expect(report.callsByPeriod.day['2025-01-15']).toBe(2);
    expect(report.callsByPeriod.day['2025-01-16']).toBe(1);
  });

  it('counts inquiry topics', () => {
    const records = [
      makeRecord({ correlationId: 'c1', inquiryTopics: ['hours', 'menu'] }),
      makeRecord({ correlationId: 'c2', inquiryTopics: ['hours'] }),
    ];
    const report = computeAnalytics(records);
    expect(report.inquiryTopics['hours']).toBe(2);
    expect(report.inquiryTopics['menu']).toBe(1);
  });

  it('counts reservation actions', () => {
    const ts = '2025-01-15T14:00:00Z';
    const records = [
      makeRecord({
        correlationId: 'c1',
        reservationActions: [
          { type: 'create', reservationId: 'r1', timestamp: ts },
          { type: 'modify', reservationId: 'r1', timestamp: ts },
        ],
      }),
      makeRecord({
        correlationId: 'c2',
        reservationActions: [{ type: 'cancel', reservationId: 'r2', timestamp: ts }],
      }),
    ];
    const report = computeAnalytics(records);
    expect(report.reservations.created).toBe(1);
    expect(report.reservations.modified).toBe(1);
    expect(report.reservations.canceled).toBe(1);
  });

  it('computes reservation conversion rate', () => {
    const ts = '2025-01-15T14:00:00Z';
    const records = [
      makeRecord({ correlationId: 'c1', reservationActions: [{ type: 'create', reservationId: 'r1', timestamp: ts }] }),
      makeRecord({ correlationId: 'c2', reservationActions: [{ type: 'create', reservationId: 'r2', timestamp: ts }] }),
      makeRecord({ correlationId: 'c3', reservationActions: [{ type: 'cancel', reservationId: 'r3', timestamp: ts }] }),
    ];
    // 3 calls with reservation inquiry, 2 created
    const report = computeAnalytics(records);
    expect(report.reservations.conversionRate).toBeCloseTo(2 / 3);
  });

  it('computes average CSAT by day', () => {
    const records = [
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T10:00:00Z', csatScore: 4, feedbackStatus: 'answered' }),
      makeRecord({ correlationId: 'c2', startTime: '2025-01-15T14:00:00Z', csatScore: 2, feedbackStatus: 'answered' }),
    ];
    const report = computeAnalytics(records);
    expect(report.averageCsat.daily['2025-01-15']).toBeCloseTo(3);
  });

  it('excludes unanswered feedback from CSAT', () => {
    const records = [
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T10:00:00Z', csatScore: 5, feedbackStatus: 'unanswered' }),
    ];
    const report = computeAnalytics(records);
    expect(report.averageCsat.daily['2025-01-15']).toBeUndefined();
  });

  it('returns top 3 peak hours', () => {
    const records = [
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T10:00:00Z' }),
      makeRecord({ correlationId: 'c2', startTime: '2025-01-15T10:30:00Z' }),
      makeRecord({ correlationId: 'c3', startTime: '2025-01-15T10:45:00Z' }),
      makeRecord({ correlationId: 'c4', startTime: '2025-01-15T14:00:00Z' }),
      makeRecord({ correlationId: 'c5', startTime: '2025-01-15T14:30:00Z' }),
      makeRecord({ correlationId: 'c6', startTime: '2025-01-15T09:00:00Z' }),
    ];
    const report = computeAnalytics(records);
    expect(report.peakHours).toHaveLength(3);
    expect(report.peakHours[0]!.hour).toBe('2025-01-15T10');
    expect(report.peakHours[0]!.count).toBe(3);
  });
});

// ─── handler tests ────────────────────────────────────────────────────────────

describe('analytics-api handler', () => {
  beforeEach(() => {
    process.env['USE_LOCAL_DB'] = 'true';
    injectLocalRecords([]);
  });

  it('returns 400 when startDate is missing', async () => {
    const result = await handler(makeEvent({ endDate: '2025-01-31' }));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when endDate is missing', async () => {
    const result = await handler(makeEvent({ startDate: '2025-01-01' }));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for invalid date format', async () => {
    const result = await handler(makeEvent({ startDate: '01/01/2025', endDate: '2025-01-31' }));
    expect(result.statusCode).toBe(400);
  });

  it('returns 200 with AnalyticsReport for valid params', async () => {
    injectLocalRecords([
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T10:00:00Z', locationId: 'loc-001' }),
    ]);
    const result = await handler(makeEvent({ startDate: '2025-01-01', endDate: '2025-01-31' }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { totalCalls: number };
    expect(body.totalCalls).toBe(1);
  });

  it('filters by locationId when provided', async () => {
    injectLocalRecords([
      makeRecord({ correlationId: 'c1', startTime: '2025-01-15T10:00:00Z', locationId: 'loc-001' }),
      makeRecord({ correlationId: 'c2', startTime: '2025-01-15T11:00:00Z', locationId: 'loc-002' }),
    ]);
    const result = await handler(makeEvent({ startDate: '2025-01-01', endDate: '2025-01-31', locationId: 'loc-001' }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { totalCalls: number };
    expect(body.totalCalls).toBe(1);
  });

  it('filters records outside date range', async () => {
    injectLocalRecords([
      makeRecord({ correlationId: 'c1', startTime: '2025-02-01T10:00:00Z' }),
    ]);
    const result = await handler(makeEvent({ startDate: '2025-01-01', endDate: '2025-01-31' }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { totalCalls: number };
    expect(body.totalCalls).toBe(0);
  });
});
