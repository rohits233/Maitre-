import { ChildProcess } from 'child_process';
import WebSocket from 'ws';
import { ReservationAction } from './models';

// ─── Call Session ────────────────────────────────────────────────────────────

export interface CallSession {
  callSid: string;
  streamSid: string;
  callerPhone: string;
  locationId: string;
  startTime: Date;
  endTime?: Date;
  terminationReason?: 'caller_hangup' | 'error' | 'transfer' | 'timeout';
  correlationId: string; // UUID for logging/metrics
  novaSonicSessionId?: string;
  inquiryTopics: string[];
  reservationActions: ReservationAction[];
}

// ─── Twilio Media Stream ──────────────────────────────────────────────────────

export interface MediaFormat {
  encoding: 'audio/x-mulaw';
  sampleRate: 8000;
  channels: 1;
}

export interface MediaStreamMessage {
  event: 'connected' | 'start' | 'media' | 'stop' | 'mark';
  sequenceNumber: string;
  streamSid?: string;
  start?: {
    callSid: string;
    tracks: string[];
    mediaFormat: MediaFormat;
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64 mulaw
  };
  mark?: {
    name: string;
  };
}

// ─── Inbound Call ─────────────────────────────────────────────────────────────

export interface InboundCallRequest {
  CallSid: string;
  From: string; // Caller phone number (E.164)
  To: string;   // Twilio phone number
  CallStatus: string;
}

// ─── VIP Routing ─────────────────────────────────────────────────────────────

export interface VIPEntry {
  phoneNumber: string;   // E.164
  guestName: string;
  conciergeLine: string; // E.164
  locationId?: string;   // Optional: location-specific VIP
}

// ─── Call Flow ────────────────────────────────────────────────────────────────

export interface CallFlowRule {
  id: string;
  locationId: string;
  priority: number;
  conditions: {
    timeOfDay?: { start: string; end: string }; // HH:mm format
    dayOfWeek?: number[];                         // 0=Sun, 6=Sat
    callerPattern?: string;                       // regex pattern
  };
  action: {
    type: 'transfer' | 'conversation_engine';
    destination?: string; // phone number for transfer
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Voice Persona ────────────────────────────────────────────────────────────

export interface VoicePersona {
  locationId: string;
  name: string;
  greeting: string;
  toneDescriptors: string[]; // e.g., ["warm", "professional", "concise"]
  systemPrompt: string;      // Full system prompt for Nova Sonic
}

// ─── MCP Tool Interfaces ──────────────────────────────────────────────────────

export interface ToolRequest {
  toolName: string;
  parameters: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ToolResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface MCPToolConfig {
  name: string;
  transport: 'websocket' | 'stdio';
  serverUrl?: string;  // For WebSocket transport
  command?: string;    // For stdio transport
  args?: string[];     // For stdio transport
  timeoutMs: number;   // default: 10000
}

export interface MCPToolConnection {
  config: MCPToolConfig;
  ws?: WebSocket;
  process?: ChildProcess;
  state: 'connecting' | 'connected' | 'disconnected';
  pendingRequests: Map<string, {
    resolve: (result: ToolResult) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

// ─── Nova Sonic ───────────────────────────────────────────────────────────────

export interface NovaSonicConnection {
  /** Persistent bidirectional WebSocket to Nova Sonic */
  ws: WebSocket;
  sessionId: string;
  state: 'connecting' | 'open' | 'closing' | 'closed';
  reconnectAttempts: number;
}

// ─── Audio Transcoder ─────────────────────────────────────────────────────────

export interface AudioTranscoder {
  mulawToNovaSonic(mulawBuffer: Buffer): Buffer;
  novaSonicToMulaw(novaSonicBuffer: Buffer): Buffer;
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export interface SessionManager {
  createSession(callSid: string, streamSid: string, callerPhone: string): CallSession;
  getSession(callSid: string): CallSession | undefined;
  terminateSession(callSid: string, reason: string): void;
  getActiveSessions(): CallSession[];
  on(
    event: 'session:created' | 'session:terminated' | 'reservation:completed' | 'inquiry:completed',
    handler: (...args: unknown[]) => void
  ): void;
}

// ─── Conversation Engine ──────────────────────────────────────────────────────

export interface ConversationEngine {
  startSession(callSession: CallSession, voicePersona: VoicePersona): Promise<void>;
  sendAudio(callSid: string, audioChunk: Buffer): void;
  onAudioOutput(callSid: string, handler: (audio: Buffer) => void): void;
  onInterruption(callSid: string, handler: () => void): void;
  onToolRequest(callSid: string, handler: (req: ToolRequest) => Promise<ToolResult>): void;
  endSession(callSid: string): Promise<void>;
}

// ─── MCP Router ───────────────────────────────────────────────────────────────

export interface MCPRouter {
  registerTool(config: MCPToolConfig): void;
  connect(toolName: string): Promise<void>;
  dispatch(request: ToolRequest): Promise<ToolResult>;
  loadConfig(configPath: string): void;
  disconnectAll(): Promise<void>;
}

// ─── VIP Router ───────────────────────────────────────────────────────────────

export interface VIPRouter {
  isVIP(callerPhone: string): Promise<VIPEntry | null>;
  refreshList(): Promise<void>;
}

// ─── Call Flow Evaluator ──────────────────────────────────────────────────────

export interface CallFlowEvaluator {
  evaluate(callerPhone: string, callTime: Date): CallFlowRule | null;
  validate(rules: CallFlowRule[]): ValidationResult;
  loadRules(): Promise<void>;
}
