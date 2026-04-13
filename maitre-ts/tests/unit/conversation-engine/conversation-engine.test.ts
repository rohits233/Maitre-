import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  ConversationEngineImpl,
  NovaSonicClient,
  NovaSonicClientFactory,
} from '../../../src/conversation-engine/conversation-engine';
import { CallSession, VoicePersona, ToolRequest, ToolResult } from '../../../src/types/index';

// ─── Test helpers ─────────────────────────────────────────────────────────────

class MockNovaSonicClient extends EventEmitter implements NovaSonicClient {
  sendAudio = vi.fn();
  sendSystemPrompt = vi.fn();
  close = vi.fn();
  isOpen = true;
}

function makeFactory(client?: MockNovaSonicClient): {
  factory: NovaSonicClientFactory;
  latestClient: () => MockNovaSonicClient;
} {
  let latest: MockNovaSonicClient;
  const factory: NovaSonicClientFactory = {
    create: (_callSid: string) => {
      latest = client ?? new MockNovaSonicClient();
      return latest;
    },
  };
  return { factory, latestClient: () => latest };
}

function makeSession(callSid = 'CA123'): CallSession {
  return {
    callSid,
    streamSid: 'MZ456',
    callerPhone: '+15551234567',
    locationId: 'loc-1',
    startTime: new Date(),
    correlationId: 'corr-1',
    inquiryTopics: [],
    reservationActions: [],
  };
}

function makePersona(): VoicePersona {
  return {
    locationId: 'loc-1',
    name: 'Aria',
    greeting: 'Hello, welcome!',
    toneDescriptors: ['warm'],
    systemPrompt: 'You are a helpful assistant.',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationEngineImpl', () => {
  let engine: ConversationEngineImpl;
  let mockClient: MockNovaSonicClient;
  let factory: NovaSonicClientFactory;

  beforeEach(() => {
    mockClient = new MockNovaSonicClient();
    ({ factory } = makeFactory(mockClient));
    engine = new ConversationEngineImpl(factory);
  });

  describe('startSession', () => {
    it('creates a session and sends system prompt on open', async () => {
      const session = makeSession();
      const persona = makePersona();

      await engine.startSession(session, persona);
      mockClient.emit('open');

      expect(mockClient.sendSystemPrompt).toHaveBeenCalledWith(
        persona.systemPrompt,
        persona.greeting,
      );
    });

    it('throws if session already exists for the same callSid', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());
      await expect(engine.startSession(session, makePersona())).rejects.toThrow();
    });
  });

  describe('sendAudio', () => {
    it('forwards audio chunk to the Nova Sonic client when open', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());
      mockClient.emit('open');

      const chunk = Buffer.from([0x01, 0x02]);
      engine.sendAudio(session.callSid, chunk);

      expect(mockClient.sendAudio).toHaveBeenCalledWith(chunk);
    });

    it('does nothing for an unknown callSid', () => {
      engine.sendAudio('unknown', Buffer.alloc(4));
      // no error thrown
    });

    it('does not forward audio when client is closed', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());
      mockClient.isOpen = false;

      engine.sendAudio(session.callSid, Buffer.from([0x01]));
      expect(mockClient.sendAudio).not.toHaveBeenCalled();
    });
  });

  describe('onAudioOutput', () => {
    it('registers a handler that is called when client emits audio', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());

      const handler = vi.fn();
      engine.onAudioOutput(session.callSid, handler);

      const chunk = Buffer.from([0xaa, 0xbb]);
      mockClient.emit('audio', chunk);

      expect(handler).toHaveBeenCalledWith(chunk);
    });

    it('does nothing for an unknown callSid', () => {
      engine.onAudioOutput('unknown', vi.fn());
    });
  });

  describe('onInterruption', () => {
    it('registers a handler that is called when client emits interruption', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());

      const handler = vi.fn();
      engine.onInterruption(session.callSid, handler);
      mockClient.emit('interruption');

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('onToolRequest', () => {
    it('registers a handler that is called when client emits toolRequest', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());

      const result: ToolResult = { success: true, data: { foo: 'bar' } };
      const handler = vi.fn().mockResolvedValue(result);
      engine.onToolRequest(session.callSid, handler);

      const req: ToolRequest = { toolName: 'check_availability', parameters: {} };
      mockClient.emit('toolRequest', req);

      expect(handler).toHaveBeenCalledWith(req);
    });
  });

  describe('endSession', () => {
    it('closes the client and removes the session', async () => {
      const session = makeSession();
      await engine.startSession(session, makePersona());
      await engine.endSession(session.callSid);

      expect(mockClient.close).toHaveBeenCalled();

      // Subsequent sendAudio should be a no-op (session removed)
      engine.sendAudio(session.callSid, Buffer.alloc(4));
      expect(mockClient.sendAudio).not.toHaveBeenCalled();
    });

    it('is idempotent for unknown callSid', async () => {
      await expect(engine.endSession('unknown')).resolves.toBeUndefined();
    });
  });

  describe('reconnect on disconnect', () => {
    it('schedules a reconnect when the client emits close (not ended)', async () => {
      vi.useFakeTimers();

      const clients: MockNovaSonicClient[] = [];
      const reconnectFactory: NovaSonicClientFactory = {
        create: () => {
          const c = new MockNovaSonicClient();
          clients.push(c);
          return c;
        },
      };
      const reconnectEngine = new ConversationEngineImpl(reconnectFactory);

      const session = makeSession('CA-reconnect');
      const persona = makePersona();
      await reconnectEngine.startSession(session, persona);

      const first = clients[0]!;
      first.emit('open');
      first.emit('close'); // simulate disconnect

      // Advance past the 3-second reconnect delay
      await vi.advanceTimersByTimeAsync(3100);

      // A second client should have been created
      expect(clients.length).toBe(2);

      vi.useRealTimers();
    });
  });
});
