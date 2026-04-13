/**
 * Feedback Service
 *
 * Sends post-call CSAT surveys and writes FeedbackRecord to DynamoDB.
 * Triggered on session end via Session Manager EventEmitter.
 *
 * Uses in-memory Map as fallback when USE_LOCAL_DB=true.
 * Respects the `feedbackEnabled` config flag.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AppConfig } from '../config';
import { CallSession } from '../types/index';
import { FeedbackRecord } from '../types/models';
import { SMSService } from './sms-service';

const TTL_24H_SECONDS = 24 * 60 * 60;

export class FeedbackService {
  private config: AppConfig;
  private smsService: SMSService;
  private ddb?: DynamoDBDocumentClient;
  private localStore = new Map<string, FeedbackRecord>();
  private useLocalDb: boolean;

  constructor(config: AppConfig, smsService: SMSService) {
    this.config = config;
    this.smsService = smsService;
    this.useLocalDb = process.env['USE_LOCAL_DB'] === 'true';

    if (!this.useLocalDb) {
      const client = new DynamoDBClient({ region: config.awsRegion });
      this.ddb = DynamoDBDocumentClient.from(client);
    }
  }

  isEnabled(): boolean {
    return this.config.feedbackEnabled;
  }

  async sendSurvey(callSession: CallSession): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const now = new Date();
    const record: FeedbackRecord = {
      correlationId: callSession.correlationId,
      callerPhone: callSession.callerPhone,
      sentAt: now.toISOString(),
      status: 'sent',
      timeoutAt: Math.floor(now.getTime() / 1000) + TTL_24H_SECONDS,
    };

    // Send SMS survey (fire-and-forget)
    this.smsService.sendFeedbackSurvey(callSession.callerPhone, callSession.correlationId).catch(() => {
      // SMS failures are already logged inside SMSService
    });

    // Persist feedback record
    await this.writeFeedbackRecord(record);
  }

  subscribeToSessionManager(sessionManager: {
    on(event: string, handler: (...args: unknown[]) => void): void;
  }): void {
    sessionManager.on('session:terminated', (session: unknown) => {
      const s = session as CallSession;
      this.sendSurvey(s).catch((err) => {
        console.error(
          `[feedback-service] Failed to send survey for correlationId=${s.correlationId}`,
          err
        );
      });
    });
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async writeFeedbackRecord(record: FeedbackRecord): Promise<void> {
    if (this.useLocalDb) {
      this.localStore.set(record.correlationId, record);
      return;
    }

    await this.ddb!.send(
      new PutCommand({
        TableName: this.config.feedbackSurveysTable,
        Item: record,
      })
    );
  }

  /** Exposed for testing */
  getLocalRecord(correlationId: string): FeedbackRecord | undefined {
    return this.localStore.get(correlationId);
  }
}
