/**
 * SMS Webhook Lambda
 *
 * Handles POST /sms/inbound from Twilio SMS webhooks.
 * Validates Twilio signature, parses CSAT score, records feedback.
 *
 * Uses in-memory fallback when USE_LOCAL_DB=true.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
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

// ─── In-memory stores for local dev ──────────────────────────────────────────

const localFeedbackSurveys = new Map<string, FeedbackRecord>(); // correlationId -> record
const localCallRecords = new Map<string, { csatScore?: number; csatComment?: string; feedbackStatus: string }>();

/** Exposed for testing */
export function injectLocalFeedbackSurvey(record: FeedbackRecord): void {
  localFeedbackSurveys.set(record.correlationId, record);
}

/** Exposed for testing */
export function injectLocalCallRecord(correlationId: string, record: { feedbackStatus: string }): void {
  localCallRecords.set(correlationId, record);
}

/** Exposed for testing */
export function getLocalCallRecord(correlationId: string) {
  return localCallRecords.get(correlationId);
}

/** Exposed for testing */
export function clearLocalStores(): void {
  localFeedbackSurveys.clear();
  localCallRecords.clear();
}

// ─── Twilio auth token loading ────────────────────────────────────────────────

let cachedAuthToken: string | null = null;

async function getTwilioAuthToken(): Promise<string> {
  if (cachedAuthToken) return cachedAuthToken;

  // In local dev, use env var directly
  if (process.env['USE_LOCAL_DB'] === 'true' || process.env['NODE_ENV'] !== 'production') {
    const token = process.env['TWILIO_AUTH_TOKEN'];
    if (!token) throw new Error('TWILIO_AUTH_TOKEN env var is required in local dev');
    cachedAuthToken = token;
    return cachedAuthToken;
  }

  // In production, load from Secrets Manager
  const secretArn = process.env['SECRET_ARN'];
  if (!secretArn) throw new Error('SECRET_ARN env var is required in production');

  const client = new SecretsManagerClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Secret has no SecretString');

  const parsed = JSON.parse(response.SecretString) as Record<string, string>;
  if (!parsed.authToken) throw new Error('Secret missing authToken field');

  cachedAuthToken = parsed.authToken;
  return cachedAuthToken;
}

// ─── Twilio signature validation ──────────────────────────────────────────────

export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  // Twilio signature: HMAC-SHA1 of url + sorted params, base64-encoded
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const twilio = require('twilio') as { validateRequest: (token: string, sig: string, url: string, params: Record<string, string>) => boolean };
  return twilio.validateRequest(authToken, signature, url, params);
}

// ─── CSAT parsing ─────────────────────────────────────────────────────────────

export function parseCsatFromBody(body: string): { score: number | null; comment: string | undefined } {
  const trimmed = body.trim();
  // First token is the score, rest is optional comment
  const parts = trimmed.split(/\s+/);
  const scoreStr = parts[0] ?? '';
  const score = parseInt(scoreStr, 10);

  if (isNaN(score) || score < 1 || score > 5) {
    return { score: null, comment: undefined };
  }

  const comment = parts.slice(1).join(' ') || undefined;
  return { score, comment };
}

// ─── Feedback lookup and recording ───────────────────────────────────────────

async function findFeedbackByPhone(callerPhone: string): Promise<FeedbackRecord | null> {
  const useLocalDb = process.env['USE_LOCAL_DB'] === 'true';
  const tableName = process.env['FEEDBACK_SURVEYS_TABLE'] ?? 'FeedbackSurveys';

  if (useLocalDb) {
    for (const record of localFeedbackSurveys.values()) {
      if (record.callerPhone === callerPhone && record.status === 'sent') {
        return record;
      }
    }
    return null;
  }

  // Query by callerPhone GSI
  const result = await getDdb().send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'callerPhone-index',
      KeyConditionExpression: 'callerPhone = :phone',
      FilterExpression: '#s = :sent',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':phone': callerPhone, ':sent': 'sent' },
      Limit: 1,
    })
  );

  const items = result.Items ?? [];
  return items.length > 0 ? (items[0] as FeedbackRecord) : null;
}

async function recordFeedbackInCallRecords(
  correlationId: string,
  csatScore: number,
  comment: string | undefined
): Promise<void> {
  const useLocalDb = process.env['USE_LOCAL_DB'] === 'true';
  const tableName = process.env['CALL_RECORDS_TABLE'] ?? 'CallRecords';

  if (useLocalDb) {
    const existing = localCallRecords.get(correlationId) ?? { feedbackStatus: 'sent' };
    existing.csatScore = csatScore;
    existing.csatComment = comment;
    existing.feedbackStatus = 'answered';
    localCallRecords.set(correlationId, existing);
    return;
  }

  await getDdb().send(
    new UpdateCommand({
      TableName: tableName,
      Key: { correlationId },
      UpdateExpression: 'SET csatScore = :score, csatComment = :comment, feedbackStatus = :status',
      ExpressionAttributeValues: {
        ':score': csatScore,
        ':comment': comment ?? '',
        ':status': 'answered',
      },
    })
  );
}

async function deleteFeedbackSurvey(correlationId: string): Promise<void> {
  const useLocalDb = process.env['USE_LOCAL_DB'] === 'true';
  const tableName = process.env['FEEDBACK_SURVEYS_TABLE'] ?? 'FeedbackSurveys';

  if (useLocalDb) {
    localFeedbackSurveys.delete(correlationId);
    return;
  }

  await getDdb().send(
    new DeleteCommand({
      TableName: tableName,
      Key: { correlationId },
    })
  );
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Parse URL-encoded body from Twilio
    const rawBody = event.body ?? '';
    const params: Record<string, string> = {};
    for (const pair of rawBody.split('&')) {
      const [k, v] = pair.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }

    const twilioSignature = event.headers['X-Twilio-Signature'] ?? event.headers['x-twilio-signature'] ?? '';
    const callerPhone = params['From'] ?? '';
    const messageBody = params['Body'] ?? '';

    // Validate Twilio signature (skip in local dev)
    const skipValidation = process.env['USE_LOCAL_DB'] === 'true' || process.env['SKIP_TWILIO_VALIDATION'] === 'true';
    if (!skipValidation) {
      const authToken = await getTwilioAuthToken();
      const webhookUrl = process.env['WEBHOOK_URL'] ?? `https://${event.requestContext?.domainName ?? 'localhost'}/sms/inbound`;
      const isValid = validateTwilioSignature(authToken, twilioSignature, webhookUrl, params);
      if (!isValid) {
        console.warn('[sms-webhook] Invalid Twilio signature');
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'text/xml' },
          body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        };
      }
    }

    if (!callerPhone) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/xml' },
        body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      };
    }

    // Parse CSAT score from message body
    const { score, comment } = parseCsatFromBody(messageBody);
    if (score === null) {
      console.info(`[sms-webhook] Could not parse CSAT score from message: "${messageBody}"`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/xml' },
        body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      };
    }

    // Find matching feedback survey by caller phone
    const feedbackRecord = await findFeedbackByPhone(callerPhone);
    if (!feedbackRecord) {
      console.info(`[sms-webhook] No pending feedback survey found for ${callerPhone}`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/xml' },
        body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      };
    }

    // Record feedback and clean up survey
    await recordFeedbackInCallRecords(feedbackRecord.correlationId, score, comment);
    await deleteFeedbackSurvey(feedbackRecord.correlationId);

    console.info(`[sms-webhook] Recorded CSAT ${score} for correlationId=${feedbackRecord.correlationId}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    };
  } catch (err) {
    console.error('[sms-webhook] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/xml' },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    };
  }
}
