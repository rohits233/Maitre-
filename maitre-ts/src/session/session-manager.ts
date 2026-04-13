import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { CallSession, SessionManager } from '../types/index';

const DEFAULT_LOCATION_ID = process.env['DEFAULT_LOCATION_ID'] ?? 'default';

export class InMemorySessionManager extends EventEmitter implements SessionManager {
  private sessions = new Map<string, CallSession>();

  createSession(callSid: string, streamSid: string, callerPhone: string): CallSession {
    const session: CallSession = {
      callSid,
      streamSid,
      callerPhone,
      locationId: DEFAULT_LOCATION_ID,
      startTime: new Date(),
      correlationId: uuidv4(),
      inquiryTopics: [],
      reservationActions: [],
    };
    this.sessions.set(callSid, session);
    this.emit('session:created', session);
    return session;
  }

  getSession(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  terminateSession(callSid: string, reason: string): void {
    const session = this.sessions.get(callSid);
    if (!session) return;
    session.endTime = new Date();
    session.terminationReason = reason as CallSession['terminationReason'];
    this.emit('session:terminated', session);
  }

  getActiveSessions(): CallSession[] {
    return Array.from(this.sessions.values()).filter(s => !s.endTime);
  }
}
