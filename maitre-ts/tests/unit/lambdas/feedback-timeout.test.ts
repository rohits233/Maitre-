import { describe, it, expect, beforeEach } from 'vitest';
import {
  processRecord,
  handler,
  injectLocalCallRecord,
  getLocalCallRecord,
  clearLocalStore,
} from '../../../src/lambdas/feedback-timeout';
import { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRemoveRecord(
  correlationId: string,
  userIdentityType: string = 'Service'
): DynamoDBRecord {
  const oldImage = marshall({
    correlationId,
    callerPhone: '+15551234567',
    sentAt: new Date().toISOString(),
    status: 'sent',
    timeoutAt: Math.floor(Date.now() / 1000),
  });

  return {
    eventName: 'REMOVE',
    dynamodb: {
      OldImage: oldImage as Record<string, import('aws-lambda').AttributeValue>,
    },
    userIdentity: { type: userIdentityType, principalId: 'dynamodb.amazonaws.com' },
    eventSource: 'aws:dynamodb',
    eventVersion: '1.1',
    eventID: 'test-event-id',
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/FeedbackSurveys/stream/2025-01-01T00:00:00.000',
    awsRegion: 'us-east-1',
  } as unknown as DynamoDBRecord;
}

// ─── processRecord tests ──────────────────────────────────────────────────────

describe('processRecord', () => {
  beforeEach(() => {
    process.env['USE_LOCAL_DB'] = 'true';
    clearLocalStore();
  });

  it('marks unanswered when TTL-expired and not yet answered', async () => {
    injectLocalCallRecord('corr-001', { feedbackStatus: 'sent' });
    await processRecord(makeRemoveRecord('corr-001'));
    expect(getLocalCallRecord('corr-001')?.feedbackStatus).toBe('unanswered');
  });

  it('does not overwrite answered feedback', async () => {
    injectLocalCallRecord('corr-answered', { feedbackStatus: 'answered' });
    await processRecord(makeRemoveRecord('corr-answered'));
    expect(getLocalCallRecord('corr-answered')?.feedbackStatus).toBe('answered');
  });

  it('ignores non-REMOVE events', async () => {
    injectLocalCallRecord('corr-insert', { feedbackStatus: 'sent' });
    const insertRecord = makeRemoveRecord('corr-insert');
    (insertRecord as { eventName: string }).eventName = 'INSERT';
    await processRecord(insertRecord);
    expect(getLocalCallRecord('corr-insert')?.feedbackStatus).toBe('sent');
  });

  it('ignores REMOVE events not from TTL (non-Service userIdentity)', async () => {
    injectLocalCallRecord('corr-manual', { feedbackStatus: 'sent' });
    await processRecord(makeRemoveRecord('corr-manual', 'User'));
    expect(getLocalCallRecord('corr-manual')?.feedbackStatus).toBe('sent');
  });

  it('does nothing when call record not found', async () => {
    // No record injected — should not throw
    await expect(processRecord(makeRemoveRecord('corr-missing'))).resolves.toBeUndefined();
  });
});

// ─── handler tests ────────────────────────────────────────────────────────────

describe('feedback-timeout handler', () => {
  beforeEach(() => {
    process.env['USE_LOCAL_DB'] = 'true';
    clearLocalStore();
  });

  it('processes all records in the event', async () => {
    injectLocalCallRecord('corr-a', { feedbackStatus: 'sent' });
    injectLocalCallRecord('corr-b', { feedbackStatus: 'sent' });

    const event: DynamoDBStreamEvent = {
      Records: [makeRemoveRecord('corr-a'), makeRemoveRecord('corr-b')],
    };

    await handler(event);

    expect(getLocalCallRecord('corr-a')?.feedbackStatus).toBe('unanswered');
    expect(getLocalCallRecord('corr-b')?.feedbackStatus).toBe('unanswered');
  });

  it('continues processing remaining records when one fails', async () => {
    injectLocalCallRecord('corr-ok', { feedbackStatus: 'sent' });

    // First record has no OldImage — will be skipped gracefully
    const badRecord: DynamoDBRecord = {
      eventName: 'REMOVE',
      dynamodb: {},
      userIdentity: { type: 'Service', principalId: 'dynamodb.amazonaws.com' },
      eventSource: 'aws:dynamodb',
      eventVersion: '1.1',
      eventID: 'bad-event',
      eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/FeedbackSurveys/stream/2025-01-01T00:00:00.000',
      awsRegion: 'us-east-1',
    } as unknown as DynamoDBRecord;

    const event: DynamoDBStreamEvent = {
      Records: [badRecord, makeRemoveRecord('corr-ok')],
    };

    await handler(event);
    expect(getLocalCallRecord('corr-ok')?.feedbackStatus).toBe('unanswered');
  });
});
