import { describe, it, expect, beforeEach } from 'vitest';
import { AnalyticsService } from '../../../src/services/analytics-service';
import { AppConfig } from '../../../src/config';
import { CallSession } from '../../../src/types/index';
import { ReservationAction } from '../../../src/types/models';

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
    startTime: new Date('2025-01-01T10:00:00Z'),
    correlationId: 'corr-001',
    inquiryTopics: [],
    reservationActions: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    process.env['USE_LOCAL_DB'] = 'true';
    service = new AnalyticsService(makeConfig());
  });

  describe('recordCallStart', () => {
    it('creates a CallRecord in local store', async () => {
      const session = makeSession({ correlationId: 'corr-start' });
      await service.recordCallStart(session);
      const record = service.getLocalRecord('corr-start');
      expect(record).toBeDefined();
      expect(record!.callSid).toBe('CA001');
      expect(record!.callerPhone).toBe('+15551234567');
      expect(record!.locationId).toBe('loc-001');
    });

    it('initializes empty inquiryTopics and reservationActions', async () => {
      const session = makeSession({ correlationId: 'corr-init' });
      await service.recordCallStart(session);
      const record = service.getLocalRecord('corr-init')!;
      expect(record.inquiryTopics).toEqual([]);
      expect(record.reservationActions).toEqual([]);
    });
  });

  describe('recordCallEnd', () => {
    it('updates endTime and durationSeconds', async () => {
      const startTime = new Date('2025-01-01T10:00:00Z');
      const endTime = new Date('2025-01-01T10:05:30Z');
      const session = makeSession({ correlationId: 'corr-end', startTime, endTime });
      await service.recordCallStart(session);
      await service.recordCallEnd(session);
      const record = service.getLocalRecord('corr-end')!;
      expect(record.endTime).toBe(endTime.toISOString());
      expect(record.durationSeconds).toBe(330); // 5 min 30 sec
    });

    it('sets terminationReason', async () => {
      const session = makeSession({
        correlationId: 'corr-reason',
        terminationReason: 'caller_hangup',
      });
      await service.recordCallStart(session);
      await service.recordCallEnd(session);
      expect(service.getLocalRecord('corr-reason')!.terminationReason).toBe('caller_hangup');
    });
  });

  describe('recordReservationAction', () => {
    it('appends reservation action to the record', async () => {
      const session = makeSession({ correlationId: 'corr-res' });
      await service.recordCallStart(session);

      const action: ReservationAction = {
        type: 'create',
        reservationId: 'res-001',
        timestamp: new Date().toISOString(),
      };
      await service.recordReservationAction('corr-res', action);

      const record = service.getLocalRecord('corr-res')!;
      expect(record.reservationActions).toHaveLength(1);
      expect(record.reservationActions[0]!.type).toBe('create');
    });

    it('appends multiple actions', async () => {
      const session = makeSession({ correlationId: 'corr-multi' });
      await service.recordCallStart(session);

      const ts = new Date().toISOString();
      await service.recordReservationAction('corr-multi', { type: 'create', reservationId: 'r1', timestamp: ts });
      await service.recordReservationAction('corr-multi', { type: 'modify', reservationId: 'r1', timestamp: ts });

      expect(service.getLocalRecord('corr-multi')!.reservationActions).toHaveLength(2);
    });
  });

  describe('recordInquiryTopic', () => {
    it('appends inquiry topic to the record', async () => {
      const session = makeSession({ correlationId: 'corr-inq' });
      await service.recordCallStart(session);
      await service.recordInquiryTopic('corr-inq', 'hours');
      expect(service.getLocalRecord('corr-inq')!.inquiryTopics).toContain('hours');
    });
  });

  describe('recordFeedback', () => {
    it('updates csatScore and marks feedbackStatus as answered', async () => {
      const session = makeSession({ correlationId: 'corr-fb' });
      await service.recordCallStart(session);
      await service.recordFeedback('corr-fb', 5);
      const record = service.getLocalRecord('corr-fb')!;
      expect(record.csatScore).toBe(5);
      expect(record.feedbackStatus).toBe('answered');
    });

    it('accepts optional comment', async () => {
      const session = makeSession({ correlationId: 'corr-fb-comment' });
      await service.recordCallStart(session);
      await service.recordFeedback('corr-fb-comment', 4, 'Great service!');
      expect(service.getLocalRecord('corr-fb-comment')!.csatComment).toBe('Great service!');
    });
  });

  describe('subscribeToSessionManager', () => {
    it('records call start on session:created event', async () => {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const mockSessionManager = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] ?? [];
          handlers[event]!.push(handler);
        },
      };

      service.subscribeToSessionManager(mockSessionManager);

      const session = makeSession({ correlationId: 'corr-evt-start' });
      handlers['session:created']![0]!(session);
      await new Promise(r => setTimeout(r, 20));

      expect(service.getLocalRecord('corr-evt-start')).toBeDefined();
    });

    it('records call end on session:terminated event', async () => {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const mockSessionManager = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] ?? [];
          handlers[event]!.push(handler);
        },
      };

      service.subscribeToSessionManager(mockSessionManager);

      const session = makeSession({
        correlationId: 'corr-evt-end',
        endTime: new Date(),
        terminationReason: 'caller_hangup',
      });
      // First create the record
      await service.recordCallStart(session);

      handlers['session:terminated']![0]!(session);
      await new Promise(r => setTimeout(r, 20));

      const record = service.getLocalRecord('corr-evt-end')!;
      expect(record.terminationReason).toBe('caller_hangup');
    });
  });
});
