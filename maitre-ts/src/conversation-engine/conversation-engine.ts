import { EventEmitter } from 'events';
import {
  CallSession,
  ConversationEngine,
  VoicePersona,
  ToolRequest,
  ToolResult,
  NovaSonicConnection,
} from '../types/index';

// ─── Nova Sonic Client Factory (injectable for testing) ───────────────────────

export interface NovaSonicClient extends EventEmitter {
  /** Send raw audio bytes to Nova Sonic */
  sendAudio(chunk: Buffer): void;
  /** Send the system prompt / session init payload */
  sendSystemPrompt(prompt: string, greeting: string): void;
  /** Send a tool result back to Nova Sonic after a toolRequest event */
  sendToolResult(toolUseId: string, content: string): void;
  /** Close the connection */
  close(): void;
  /** Whether the connection is currently open */
  readonly isOpen: boolean;
}

export interface NovaSonicClientFactory {
  create(callSid: string): NovaSonicClient;
}

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
  connection: NovaSonicConnection;
  client: NovaSonicClient;
  audioOutputHandler?: (audio: Buffer) => void;
  interruptionHandler?: () => void;
  toolRequestHandler?: (req: ToolRequest) => Promise<ToolResult>;
  audioBuffer: Buffer[];
  ended: boolean;
}

// ─── ConversationEngineImpl ───────────────────────────────────────────────────

export class ConversationEngineImpl implements ConversationEngine {
  private sessions = new Map<string, SessionState>();
  private readonly factory: NovaSonicClientFactory;

  constructor(factory: NovaSonicClientFactory) {
    this.factory = factory;
  }

  preWarmSession(callSid: string, voicePersona: VoicePersona): void {
    if (this.sessions.has(callSid)) return;
    const state = this._createSessionState(callSid, voicePersona);
    this.sessions.set(callSid, state);
  }

  async startSession(callSession: CallSession, voicePersona: VoicePersona): Promise<void> {
    const { callSid } = callSession;
    if (this.sessions.has(callSid)) return; // already pre-warmed

    const state = this._createSessionState(callSid, voicePersona);
    this.sessions.set(callSid, state);
  }

  sendAudio(callSid: string, audioChunk: Buffer): void {
    const state = this.sessions.get(callSid);
    if (!state || state.ended) return;
    if (state.client.isOpen) {
      state.client.sendAudio(audioChunk);
    }
  }

  onAudioOutput(callSid: string, handler: (audio: Buffer) => void): void {
    const state = this.sessions.get(callSid);
    if (!state) return;
    state.audioOutputHandler = handler;
    // Flush any audio buffered during pre-warm
    if (state.audioBuffer.length > 0) {
      for (const chunk of state.audioBuffer) {
        handler(chunk);
      }
      state.audioBuffer = [];
    }
  }

  onInterruption(callSid: string, handler: () => void): void {
    const state = this.sessions.get(callSid);
    if (!state) return;
    state.interruptionHandler = handler;
  }

  onToolRequest(callSid: string, handler: (req: ToolRequest) => Promise<ToolResult>): void {
    const state = this.sessions.get(callSid);
    if (!state) return;
    state.toolRequestHandler = handler;
  }

  async endSession(callSid: string): Promise<void> {
    const state = this.sessions.get(callSid);
    if (!state) return;

    state.ended = true;
    state.connection.state = 'closing';
    state.client.close();
    this.sessions.delete(callSid);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _createSessionState(callSid: string, voicePersona: VoicePersona): SessionState {
    const client = this.factory.create(callSid);

    const connection: NovaSonicConnection = {
      ws: {} as never, // managed by the client abstraction
      sessionId: callSid,
      state: 'connecting',
      reconnectAttempts: 0,
    };

    const state: SessionState = {
      connection,
      client,
      audioBuffer: [],
      ended: false,
    };

    this._attachClientListeners(callSid, state);

    // Send system prompt once the client signals it is open
    client.once('open', () => {
      connection.state = 'open';
      connection.reconnectAttempts = 0;
      client.sendSystemPrompt(voicePersona.systemPrompt, voicePersona.greeting);
    });

    return state;
  }

  private _attachClientListeners(
    callSid: string,
    state: SessionState,
  ): void {
    const { client, connection } = state;

    client.on('audio', (chunk: Buffer) => {
      if (state.audioOutputHandler) {
        state.audioOutputHandler(chunk);
      } else {
        state.audioBuffer.push(chunk);
      }
    });

    client.on('interruption', () => {
      if (state.interruptionHandler) {
        state.interruptionHandler();
      }
    });

    client.on('toolRequest', (req: ToolRequest) => {
      if (state.toolRequestHandler) {
        state.toolRequestHandler(req).then((result) => {
          if (req.idempotencyKey && client.isOpen) {
            const content = result.success
              ? JSON.stringify(result.data ?? {})
              : JSON.stringify({ error: result.error });
            client.sendToolResult(req.idempotencyKey, content);
          }
        }).catch(() => {
          // errors are handled by the caller; swallow here to avoid unhandled rejection
        });
      }
    });

    client.on('close', () => {
      if (state.ended) return;
      // Session closed unexpectedly (e.g. Nova Sonic timeout) — mark ended and clean up
      state.ended = true;
      connection.state = 'closed';
      this.sessions.delete(callSid);
    });

    client.on('error', () => {
      // errors are logged by the client; close event handles cleanup
    });
  }
}
