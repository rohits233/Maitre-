import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SMSService } from '../../../src/services/sms-service';
import { Reservation, RestaurantLocation } from '../../../src/types/models';
import { CallSession } from '../../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservationId: 'res-001',
    locationId: 'loc-001',
    guestName: 'Alice',
    partySize: 2,
    date: '2025-08-01',
    time: '19:00',
    status: 'confirmed',
    confirmationNumber: 'RES-ABC123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    callerPhone: '+15551234567',
    correlationId: 'corr-001',
    idempotencyKey: 'idem-001',
    ...overrides,
  };
}

function makeLocation(overrides: Partial<RestaurantLocation> = {}): RestaurantLocation {
  return {
    locationId: 'loc-001',
    restaurantGroupId: 'grp-001',
    name: 'The Grand',
    address: '123 Main St, Springfield',
    phone: '+15559876543',
    mapUrl: 'https://maps.example.com/grand',
    coordinates: { lat: 37.7749, lng: -122.4194 },
    operatingHours: { monday: { open: '11:00', close: '22:00' } },
    menuUrl: 'https://example.com/menu',
    timezone: 'America/Los_Angeles',
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SMSService', () => {
  let sentMessages: { to: string; body: string }[];
  let smsService: SMSService;

  beforeEach(() => {
    sentMessages = [];
    const mockProvider = {
      sendSMS: vi.fn(async (to: string, body: string) => {
        sentMessages.push({ to, body });
      }),
    };
    smsService = SMSService.withProvider(mockProvider);
  });

  describe('sendReservationConfirmation', () => {
    it('sends to the caller phone', async () => {
      const res = makeReservation();
      await smsService.sendReservationConfirmation('+15551234567', res);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.to).toBe('+15551234567');
    });

    it('includes confirmation number in body', async () => {
      const res = makeReservation({ confirmationNumber: 'RES-XYZ999' });
      await smsService.sendReservationConfirmation('+15551234567', res);
      expect(sentMessages[0]!.body).toContain('RES-XYZ999');
    });

    it('includes date and time in body', async () => {
      const res = makeReservation({ date: '2025-12-25', time: '20:00' });
      await smsService.sendReservationConfirmation('+15551234567', res);
      expect(sentMessages[0]!.body).toContain('2025-12-25');
      expect(sentMessages[0]!.body).toContain('20:00');
    });

    it('includes party size in body', async () => {
      const res = makeReservation({ partySize: 4 });
      await smsService.sendReservationConfirmation('+15551234567', res);
      expect(sentMessages[0]!.body).toContain('4');
    });
  });

  describe('sendReservationUpdate', () => {
    it('sends update SMS with new date and time', async () => {
      const res = makeReservation({ date: '2025-09-10', time: '18:30' });
      await smsService.sendReservationUpdate('+15551234567', res);
      expect(sentMessages[0]!.body).toContain('2025-09-10');
      expect(sentMessages[0]!.body).toContain('18:30');
    });
  });

  describe('sendCancellationConfirmation', () => {
    it('sends cancellation SMS with original date', async () => {
      const res = makeReservation({ date: '2025-07-04', time: '19:00' });
      await smsService.sendCancellationConfirmation('+15551234567', res);
      expect(sentMessages[0]!.body).toContain('2025-07-04');
      expect(sentMessages[0]!.body).toContain('cancelled');
    });
  });

  describe('sendDirections', () => {
    it('includes address and map link', async () => {
      const loc = makeLocation();
      await smsService.sendDirections('+15551234567', loc);
      expect(sentMessages[0]!.body).toContain('123 Main St');
      expect(sentMessages[0]!.body).toContain('https://maps.example.com/grand');
    });
  });

  describe('sendMenuLink', () => {
    it('includes menu URL', async () => {
      const loc = makeLocation({ menuUrl: 'https://example.com/menu' });
      await smsService.sendMenuLink('+15551234567', loc);
      expect(sentMessages[0]!.body).toContain('https://example.com/menu');
    });
  });

  describe('sendFeedbackSurvey', () => {
    it('sends survey asking for rating', async () => {
      await smsService.sendFeedbackSurvey('+15551234567', 'corr-001');
      expect(sentMessages[0]!.body).toMatch(/1-5/);
    });
  });

  describe('error handling', () => {
    it('does not throw when provider fails', async () => {
      const failingProvider = {
        sendSMS: vi.fn(async () => { throw new Error('Network error'); }),
      };
      const failService = SMSService.withProvider(failingProvider);
      await expect(
        failService.sendFeedbackSurvey('+15551234567', 'corr-001')
      ).resolves.not.toThrow();
    });
  });

  describe('subscribeToSessionManager', () => {
    it('sends reservation confirmation on reservation:completed event', async () => {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      const mockSessionManager = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] ?? [];
          handlers[event]!.push(handler);
        },
      };

      smsService.subscribeToSessionManager(mockSessionManager);

      const session = makeSession();
      const reservation = makeReservation({ confirmationNumber: 'RES-EVT001' });
      await handlers['reservation:completed']![0]!(session, reservation);

      expect(sentMessages.some(m => m.body.includes('RES-EVT001'))).toBe(true);
    });
  });
});
