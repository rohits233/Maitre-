import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackService } from '../../../src/services/feedback-service';
import { SMSService } from '../../../src/services/sms-service';
import { AppConfig } from '../../../src/config';
import { CallSession } from '../../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    nodeEnv: 'test',
    twilioAuthToken: 'test-token',
    twilioAccountSid: 'ACtest',
    twilioPhoneNumber: '+15550000000',
    novaSonicEndpoint: 'wss://localhost',
    awsRegion: 'us-east-1',
    reservationsTable: 'Reservations',
    availabilitySlotsTable: 'AvailabilitySlots',
    locationsTable: 'Locations',
    vipListTable: 'VIPList',
    callFlowRulesTable: 'CallFlowRules',
    voicePersonasTable: 'VoicePersonas',
    callRecordsTable: 'CallRecords',
    idempotencyKeysTable: 'IdempotencyKeys',
    feedbackSurveysTable: 'FeedbackSurveys',
    feedbackEnabled: true,
    drainTimeoutMs: 120000,
    smsProvider: 'twilio',
    defaultLocationId: 'default',
    ...overrides,
  };
}

function makeSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callSid: 'CA001',
    streamSid: 'MZ001',
    callerPhone: '+15551234567',
    locationId: 'loc-001',
    startTime: new Date(),
    correlationId: 'corr-001',
    inquiryTopics: [],
    reservationActions: [],
    ...overrides,
  };
}

function makeMockSmsService(): SMSService {
  const mockProvider = {
    sendSMS: vi.fn(async () => {}),
  };
  return SMSService.withProvider(mockProvider);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FeedbackService', () => {
  beforeEach(() => {
    process.env['USE_LOCAL_DB'] = 'true';
  });

  describe('isEnabled', () => {
    it('returns true when feedbackEnabled is true', () => {
      const service = new FeedbackService(makeConfig({ feedbackEnabled: true }), makeMockSmsService());
      expect(service.isEnabled()).toBe(true);
    });

    it('returns false when feedbackEnabled is false', () => {
      const service = new FeedbackService(makeConfig({ feedbackEnabled: false }), makeMockSmsService());
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('sendSurvey', () => {
    it('writes a FeedbackRecord to local store', async () => {
      const service = new FeedbackService(makeConfig(), makeMockSmsService());
      const session = makeSession({ correlationId: 'corr-abc' });
      await service.sendSurvey(session);
      const record = service.getLocalRecord('corr-abc');
      expect(record).toBeDefined();
      expect(record!.correlationId).toBe('corr-abc');
      expect(record!.callerPhone).toBe('+15551234567');
      expect(record!.status).toBe('sent');
    });

    it('sets TTL to approximately 24 hours from now', async () => {
      const service = new FeedbackService(makeConfig(), makeMockSmsService());
      const session = makeSession({ correlationId: 'corr-ttl' });
      const before = Math.floor(Date.now() / 1000);
      await service.sendSurvey(session);
      const after = Math.floor(Date.now() / 1000);
      const record = service.getLocalRecord('corr-ttl')!;
      const expectedMin = before + 24 * 3600;
      const expectedMax = after + 24 * 3600;
      expect(record.timeoutAt).toBeGreaterThanOrEqual(expectedMin);
      expect(record.timeoutAt).toBeLessThanOrEqual(expectedMax);
    });

    it('does not write record when feedbackEnabled is false', async () => {
      const service = new FeedbackService(makeConfig({ feedbackEnabled: false }), makeMockSmsService());
      const session = makeSession({ correlationId: 'corr-disabled' });
      await service.sendSurvey(session);
      expect(service.getLocalRecord('corr-disabled')).toBeUndefined();
    });

    it('calls sendFeedbackSurvey on SMSService', async () => {
      const mockSms = makeMockSmsService();
      const spy = vi.spyOn(mockSms, 'sendFeedbackSurvey');
      const service = new FeedbackService(makeConfig(), mockSms);
      const session = makeSession({ correlationId: 'corr-sms' });
      await service.sendSurvey(session);
      // Give the fire-and-forget a tick to run
      await new Promise(r => setTimeout(r, 10));
      expect(spy).toHaveBeenCalledWith('+15551234567', 'corr-sms');
    });
  });

  describe('subscribeToSessionManager', () => {
    it('sends survey on session:terminated event', async () => {
      const service = new FeedbackService(makeConfig(), makeMockSmsService());
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const mockSessionManager = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] ?? [];
          handlers[event]!.push(handler);
        },
      };

      service.subscribeToSessionManager(mockSessionManager);

      const session = makeSession({ correlationId: 'corr-event' });
      handlers['session:terminated']![0]!(session);
      // Wait for async sendSurvey
      await new Promise(r => setTimeout(r, 20));

      expect(service.getLocalRecord('corr-event')).toBeDefined();
    });
  });
});
