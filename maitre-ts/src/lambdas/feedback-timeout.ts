/**
 * Feedback Timeout Lambda
 *
 * Triggered by DynamoDB Streams REMOVE events on FeedbackSurveys table (TTL expiry).
 * Filters for TTL-deleted records (userIdentity.type === 'Service').
 * Marks unanswered feedback in CallRecords table.
 *
 * Uses in-memory fallback when USE_LOCAL_DB=true.
 */

import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AttributeValue } from '@aws-sdk/client-dynamodb';
import { FeedbackRecord } from '../types/models';

// ─── DynamoDB client (lazy-initialized) ──────────────────────────────────────

let ddb: DynamoDBDocumentClient | null = null;

function getDdb(): DynamoDBDocumentClient {
  if (!ddb) {
    const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
    ddb = DynamoDBDocumentClient.from(client);
  }
  return ddb;
}

// ─── In-memory store for local dev ───────────────────────────────────────────

const localCallRecords = new Map<string, { feedbackStatus: string }>();

/** Exposed for testing */
export function injectLocalCallRecord(correlationId: string, record: { feedbackStatus: string }): void {
  localCallRecords.set(correlationId, record);
}

/** Exposed for testing */
export function getLocalCallRecord(correlationId: string) {
  return localCallRecords.get(correlationId);
}

/** Exposed for testing */
export function clearLocalStore(): void {
  localCallRecords.clear();
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Only process REMOVE events
  if (record.eventName !== 'REMOVE') return;

  // Only process TTL-expired records (userIdentity.type === 'Service')
  const userIdentity = (record as unknown as { userIdentity?: { type?: string } }).userIdentity;
  if (userIdentity?.type !== 'Service') return;

  const oldImage = record.dynamodb?.OldImage;
  if (!oldImage) return;

  const feedbackRecord = unmarshall(oldImage as Record<string, AttributeValue>) as FeedbackRecord;
  const correlationId = feedbackRecord.correlationId;
  if (!correlationId) return;

  const useLocalDb = process.env['USE_LOCAL_DB'] === 'true';
  const callRecordsTable = process.env['CALL_RECORDS_TABLE'] ?? 'CallRecords';

  if (useLocalDb) {
    const existing = localCallRecords.get(correlationId);
    if (!existing) return;
    // Only mark unanswered if not already answered
    if (existing.feedbackStatus !== 'answered') {
      existing.feedbackStatus = 'unanswered';
    }
    return;
  }

  // Check if feedback was already answered
  const getResult = await getDdb().send(
    new GetCommand({
      TableName: callRecordsTable,
      Key: { correlationId },
      ProjectionExpression: 'feedbackStatus',
    })
  );

  const item = getResult.Item as { feedbackStatus?: string } | undefined;
  if (!item) return;
  if (item.feedbackStatus === 'answered') return;

  // Mark as unanswered
  await getDdb().send(
    new UpdateCommand({
      TableName: callRecordsTable,
      Key: { correlationId },
      UpdateExpression: 'SET feedbackStatus = :status',
      ExpressionAttributeValues: { ':status': 'unanswered' },
      ConditionExpression: 'feedbackStatus <> :answered',
      ExpressionAttributeNames: undefined,
    })
  );

  console.info(`[feedback-timeout] Marked correlationId=${correlationId} as unanswered`);
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error('[feedback-timeout] Error processing record:', err, record);
      // Don't rethrow — process remaining records
    }
  }
}
