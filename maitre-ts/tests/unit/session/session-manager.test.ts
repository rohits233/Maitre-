import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySessionManager } from '../../../src/session/session-manager';

describe('InMemorySessionManager', () => {
  let manager: InMemorySessionManager;

  beforeEach(() => {
    manager = new InMemorySessionManager();
  });

  describe('createSession', () => {
    it('creates a session with the provided identifiers', () => {
      const session = manager.createSession('CA123', 'MZ456', '+15551234567');
      expect(session.callSid).toBe('CA123');
      expect(session.streamSid).toBe('MZ456');
      expect(session.callerPhone).toBe('+15551234567');
    });

    it('assigns a UUID correlationId', () => {
      const session = manager.createSession('CA123', 'MZ456', '+15551234567');
      expect(session.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('sets startTime to now', () => {
      const before = new Date();
      const session = manager.createSession('CA123', 'MZ456', '+15551234567');
      const after = new Date();
      expect(session.startTime.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(session.startTime.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('initializes empty inquiryTopics and reservationActions', () => {
      const session = manager.createSession('CA123', 'MZ456', '+15551234567');
      expect(session.inquiryTopics).toEqual([]);
      expect(session.reservationActions).toEqual([]);
    });

    it('sets a default locationId', () => {
      const session = manager.createSession('CA123', 'MZ456', '+15551234567');
      expect(typeof session.locationId).toBe('string');
      expect(session.locationId.length).toBeGreaterThan(0);
    });

    it('emits session:created event with the new session', () => {
      let emitted: unknown;
      manager.on('session:created', (s) => { emitted = s; });
      const session = manager.createSession('CA123', 'MZ456', '+15551234567');
      expect(emitted).toBe(session);
    });

    it('assigns unique correlationIds to different sessions', () => {
      const s1 = manager.createSession('CA001', 'MZ001', '+15550000001');
      const s2 = manager.createSession('CA002', 'MZ002', '+15550000002');
      expect(s1.correlationId).not.toBe(s2.correlationId);
    });
  });

  describe('getSession', () => {
    it('returns the session for a known callSid', () => {
      const created = manager.createSession('CA123', 'MZ456', '+15551234567');
      expect(manager.getSession('CA123')).toBe(created);
    });

    it('returns undefined for an unknown callSid', () => {
      expect(manager.getSession('CA_UNKNOWN')).toBeUndefined();
    });
  });

  describe('terminateSession', () => {
    it('sets endTime on the session', () => {
      manager.createSession('CA123', 'MZ456', '+15551234567');
      const before = new Date();
      manager.terminateSession('CA123', 'caller_hangup');
      const session = manager.getSession('CA123')!;
      expect(session.endTime).toBeDefined();
      expect(session.endTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('sets terminationReason on the session', () => {
      manager.createSession('CA123', 'MZ456', '+15551234567');
      manager.terminateSession('CA123', 'caller_hangup');
      expect(manager.getSession('CA123')!.terminationReason).toBe('caller_hangup');
    });

    it('emits session:terminated event', () => {
      manager.createSession('CA123', 'MZ456', '+15551234567');
      let emitted: unknown;
      manager.on('session:terminated', (s) => { emitted = s; });
      manager.terminateSession('CA123', 'caller_hangup');
      expect(emitted).toBeDefined();
    });

    it('does nothing for an unknown callSid', () => {
      expect(() => manager.terminateSession('CA_UNKNOWN', 'error')).not.toThrow();
    });
  });

  describe('getActiveSessions', () => {
    it('returns sessions without endTime', () => {
      manager.createSession('CA001', 'MZ001', '+15550000001');
      manager.createSession('CA002', 'MZ002', '+15550000002');
      expect(manager.getActiveSessions()).toHaveLength(2);
    });

    it('excludes terminated sessions', () => {
      manager.createSession('CA001', 'MZ001', '+15550000001');
      manager.createSession('CA002', 'MZ002', '+15550000002');
      manager.terminateSession('CA001', 'caller_hangup');
      const active = manager.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0]!.callSid).toBe('CA002');
    });

    it('returns empty array when no active sessions', () => {
      expect(manager.getActiveSessions()).toEqual([]);
    });
  });
});
