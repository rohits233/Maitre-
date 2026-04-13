/**
 * Call Analytics Service
 *
 * Records call data to DynamoDB CallRecords table.
 * Subscribes to Session Manager events for automatic recording.
 *
 * Uses in-memory Map as fallback when USE_LOCAL_DB=true.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AppConfig } from '../config';
import { CallSession } from '../types/index';
import { CallRecord, FeedbackRecord, ReservationAction } from '../types/models';

export class AnalyticsService {
  private config: AppConfig;
  private ddb?: DynamoDBDocumentClient;
  private localStore = new Map<string, CallRecord>();
  private useLocalDb: boolean;

  constructor(config: AppConfig) {
    this.config = config;
    this.useLocalDb = process.env['USE_LOCAL_DB'] === 'true';

    if (!this.useLocalDb) {
      const client = new DynamoDBClient({ region: config.awsRegion });
      this.ddb = DynamoDBDocumentClient.from(client);
    }
  }

  async recordCallStart(callSession: CallSession): Promise<void> {
    const record: CallRecord = {
      correlationId: callSession.correlationId,
      callSid: callSession.callSid,
      callerPhone: callSession.callerPhone,
      locationId: callSession.locationId,
      startTime: callSession.startTime.toISOString(),
      endTime: '',
      durationSeconds: 0,
      terminationReason: '',
      inquiryTopics: [],
      reservationActions: [],
      feedbackStatus: 'disabled',
    };

    if (this.useLocalDb) {
      this.localStore.set(callSession.correlationId, record);
      return;
    }

    await this.ddb!.send(
      new PutCommand({
        TableName: this.config.callRecordsTable,
        Item: record,
      })
    );
  }

  async recordCallEnd(callSession: CallSession): Promise<void> {
    const endTime = callSession.endTime ?? new Date();
    const durationSeconds = Math.round(
      (endTime.getTime() - callSession.startTime.getTime()) / 1000
    );

    if (this.useLocalDb) {
      const record = this.localStore.get(callSession.correlationId);
      if (record) {
        record.endTime = endTime.toISOString();
        record.durationSeconds = durationSeconds;
        record.terminationReason = callSession.terminationReason ?? '';
      }
      return;
    }

    await this.ddb!.send(
      new UpdateCommand({
        TableName: this.config.callRecordsTable,
        Key: { correlationId: callSession.correlationId },
        UpdateExpression:
          'SET endTime = :endTime, durationSeconds = :dur, terminationReason = :reason',
        ExpressionAttributeValues: {
          ':endTime': endTime.toISOString(),
          ':dur': durationSeconds,
          ':reason': callSession.terminationReason ?? '',
        },
      })
    );
  }

  async recordReservationAction(correlationId: string, action: ReservationAction): Promise<void> {
    if (this.useLocalDb) {
      const record = this.localStore.get(correlationId);
      if (record) {
        record.reservationActions.push(action);
      }
      return;
    }

    await this.ddb!.send(
      new UpdateCommand({
        TableName: this.config.callRecordsTable,
        Key: { correlationId },
        UpdateExpression:
          'SET reservationActions = list_append(if_not_exists(reservationActions, :empty), :action)',
        ExpressionAttributeValues: {
          ':action': [action],
          ':empty': [],
        },
      })
    );
  }

  async recordInquiryTopic(correlationId: string, topic: string): Promise<void> {
    if (this.useLocalDb) {
      const record = this.localStore.get(correlationId);
      if (record) {
        record.inquiryTopics.push(topic);
      }
      return;
    }

    await this.ddb!.send(
      new UpdateCommand({
        TableName: this.config.callRecordsTable,
        Key: { correlationId },
        UpdateExpression:
          'SET inquiryTopics = list_append(if_not_exists(inquiryTopics, :empty), :topic)',
        ExpressionAttributeValues: {
          ':topic': [topic],
          ':empty': [],
        },
      })
    );
  }

  async recordFeedback(
    correlationId: string,
    csatScore: number,
    comment?: string
  ): Promise<void>;
  async recordFeedback(
    correlationId: string,
    feedback: FeedbackRecord
  ): Promise<void>;
  async recordFeedback(
    correlationId: string,
    csatScoreOrFeedback: number | FeedbackRecord,
    comment?: string
  ): Promise<void> {
    let csatScore: number | undefined;
    let csatComment: string | undefined;

    if (typeof csatScoreOrFeedback === 'number') {
      csatScore = csatScoreOrFeedback;
      csatComment = comment;
    } else {
      csatScore = csatScoreOrFeedback.csatScore;
      csatComment = csatScoreOrFeedback.comment;
    }

    if (this.useLocalDb) {
      const record = this.localStore.get(correlationId);
      if (record) {
        record.csatScore = csatScore;
        record.csatComment = csatComment;
        record.feedbackStatus = 'answered';
      }
      return;
    }

    await this.ddb!.send(
      new UpdateCommand({
        TableName: this.config.callRecordsTable,
        Key: { correlationId },
        UpdateExpression:
          'SET csatScore = :score, csatComment = :comment, feedbackStatus = :status',
        ExpressionAttributeValues: {
          ':score': csatScore,
          ':comment': csatComment ?? '',
          ':status': 'answered',
        },
      })
    );
  }

  subscribeToSessionManager(sessionManager: {
    on(event: string, handler: (...args: unknown[]) => void): void;
  }): void {
    sessionManager.on('session:created', (session: unknown) => {
      const s = session as CallSession;
      this.recordCallStart(s).catch((err) => {
        console.error(
          `[analytics-service] Failed to record call start for correlationId=${s.correlationId}`,
          err
        );
      });
    });

    sessionManager.on('session:terminated', (session: unknown) => {
      const s = session as CallSession;
      this.recordCallEnd(s).catch((err) => {
        console.error(
          `[analytics-service] Failed to record call end for correlationId=${s.correlationId}`,
          err
        );
      });
    });
  }

  /** Exposed for testing */
  getLocalRecord(correlationId: string): CallRecord | undefined {
    return this.localStore.get(correlationId);
  }
}
