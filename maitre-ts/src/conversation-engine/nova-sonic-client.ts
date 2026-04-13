import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { NovaSonicClient, NovaSonicClientFactory } from './conversation-engine';
import { logger } from '../logger';

const MODEL_ID = 'amazon.nova-sonic-v1:0';
const VOICE_ID = 'matthew';

class AsyncQueue<T> {
  private queue: T[] = [];
  private waiters: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()!({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined as unknown as T, done: true });
    }
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class NovaSonicBedrockClient extends EventEmitter implements NovaSonicClient {
  private _isOpen = false;
  private callSid: string;
  private region: string;
  private promptName: string;
  private contentName: string;
  private audioContentName: string;
  private toolDefinitions: Record<string, unknown>[];
  private inputQueue = new AsyncQueue<{ chunk: { bytes: Uint8Array } }>();

  constructor(callSid: string, region = 'us-east-1', toolDefinitions: Record<string, unknown>[] = []) {
    super();
    this.callSid = callSid;
    this.region = region;
    this.promptName = uuidv4();
    this.contentName = uuidv4();
    this.audioContentName = uuidv4();
    this.toolDefinitions = toolDefinitions;
    this._connect().catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
      logger.error('[nova-sonic] Failed to connect', { callSid, error: errMsg });
      this.emit('error', err);
      this.emit('close');
    });
  }

  get isOpen(): boolean { return this._isOpen; }

  sendAudio(chunk: Buffer): void {
    if (!this._isOpen) return;
    this._send({ event: { audioInput: { promptName: this.promptName, contentName: this.audioContentName, content: chunk.toString('base64') } } });
  }

  sendToolResult(toolUseId: string, content: string): void {
    if (!this._isOpen) return;
    const resultContentName = uuidv4();
    this._send({ event: { contentStart: { promptName: this.promptName, contentName: resultContentName, type: 'TOOL', interactive: false, role: 'TOOL', toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } } } });
    this._send({ event: { toolResult: { promptName: this.promptName, contentName: resultContentName, content } } });
    this._send({ event: { contentEnd: { promptName: this.promptName, contentName: resultContentName } } });
  }

  sendSystemPrompt(systemPrompt: string, greeting: string): void {
    if (!this._isOpen) return;
    const fullPrompt = systemPrompt + '\n\nStart the conversation by saying: "' + greeting + '"';
    logger.info('[nova-sonic] Sending system prompt', { callSid: this.callSid, promptLen: fullPrompt.length, greeting });
    this._send({ event: { contentStart: { promptName: this.promptName, contentName: this.contentName, type: 'TEXT', interactive: true, role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } } } });
    this._send({ event: { textInput: { promptName: this.promptName, contentName: this.contentName, content: fullPrompt } } });
    this._send({ event: { contentEnd: { promptName: this.promptName, contentName: this.contentName } } });
    this._send({ event: { contentStart: { promptName: this.promptName, contentName: this.audioContentName, type: 'AUDIO', interactive: true, role: 'USER', audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' } } } });
    logger.info('[nova-sonic] Audio content start queued', { callSid: this.callSid });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._send({ event: { contentEnd: { promptName: this.promptName, contentName: this.audioContentName } } });
    this._send({ event: { promptEnd: { promptName: this.promptName } } });
    this._send({ event: { sessionEnd: {} } });
    this.inputQueue.close();
    this.emit('close');
  }

  private _send(payload: Record<string, unknown>): void {
    this.inputQueue.push({ chunk: { bytes: Buffer.from(JSON.stringify(payload)) } });
  }

  private _buildToolSpecs(): Record<string, unknown>[] {
    return this.toolDefinitions.map((def) => {
      const typed = def as { toolSpec?: { inputSchema?: { json?: unknown }; [k: string]: unknown }; [k: string]: unknown };
      const spec = typed.toolSpec;
      if (!spec) return def;
      const schemaJson = spec.inputSchema?.json;
      if (schemaJson !== undefined && typeof schemaJson !== 'string') {
        return {
          toolSpec: {
            ...spec,
            inputSchema: { json: JSON.stringify(schemaJson) },
          },
        };
      }
      return def;
    });
  }

  private async _connect(): Promise<void> {
    // HTTP/2 is required for Nova Sonic bidirectional streaming
    const http2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 600000,
    });

    const client = new BedrockRuntimeClient({
      region: this.region,
      requestHandler: http2Handler,
    });

    this.inputQueue.push({ chunk: { bytes: Buffer.from(JSON.stringify({ event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } } } })) } });

    const promptStart: Record<string, unknown> = {
      promptName: this.promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId: VOICE_ID, audioType: 'SPEECH', encoding: 'base64' },
      toolUseOutputConfiguration: { mediaType: 'application/json' },
    };

    if (this.toolDefinitions.length > 0) {
      promptStart.toolConfiguration = { tools: this._buildToolSpecs() };
    }

    logger.info('[nova-sonic] Connecting', { callSid: this.callSid, hasTools: this.toolDefinitions.length > 0 });
    this.inputQueue.push({ chunk: { bytes: Buffer.from(JSON.stringify({ event: { promptStart } })) } });

    const command = new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: this.inputQueue });
    const response: InvokeModelWithBidirectionalStreamCommandOutput = await client.send(command);

    this._isOpen = true;
    logger.info('[nova-sonic] Connected', { callSid: this.callSid });
    this.emit('open');

    if (response.body) {
      this._processOutput(response.body).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
        logger.error('[nova-sonic] Output error', { callSid: this.callSid, error: errMsg });
        this._isOpen = false;
        this.emit('close');
      });
    }
  }

  private async _processOutput(outputStream: AsyncIterable<unknown>): Promise<void> {
    let audioChunkCount = 0;
    for await (const event of outputStream) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ev_raw = event as any;
        if (ev_raw?.modelStreamErrorException) {
          logger.error('[nova-sonic] Model stream error', { callSid: this.callSid, error: JSON.stringify(ev_raw.modelStreamErrorException) });
          continue;
        }
        if (ev_raw?.internalServerException) {
          logger.error('[nova-sonic] Internal server error', { callSid: this.callSid, error: JSON.stringify(ev_raw.internalServerException) });
          continue;
        }
        const raw = ev_raw?.chunk?.bytes;
        if (!raw) {
          // Log unexpected event shapes
          const keys = Object.keys(ev_raw || {});
          if (keys.length > 0) logger.warn('[nova-sonic] Unknown event shape', { callSid: this.callSid, keys });
          continue;
        }
        const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : new TextDecoder().decode(raw as Uint8Array);
        const json = JSON.parse(text) as Record<string, unknown>;
        const ev = (json.event ?? {}) as Record<string, unknown>;
        if (ev.audioOutput) {
          const chunk = Buffer.from((ev.audioOutput as { content: string }).content, 'base64');
          audioChunkCount++;
          if (audioChunkCount === 1) logger.info('[nova-sonic] First audio chunk', { callSid: this.callSid, bytes: chunk.length });
          this.emit('audio', chunk);
        } else if (ev.contentStart) {
          const cs = ev.contentStart as { role?: string; type?: string; contentName?: string };
          logger.info('[nova-sonic] contentStart', { callSid: this.callSid, role: cs.role, type: cs.type });
          if (cs.role === 'USER') {
            this.emit('interruption');
          }
        } else if (ev.textOutput) {
          const to = ev.textOutput as { content?: string };
          logger.info('[nova-sonic] textOutput', { callSid: this.callSid, preview: (to.content ?? '').slice(0, 80) });
        } else if (ev.toolUse) {
          const tool = ev.toolUse as { toolUseId: string; toolName: string; input: Record<string, unknown> };
          logger.info('[nova-sonic] Tool request', { callSid: this.callSid, toolName: tool.toolName });
          this.emit('toolRequest', { toolName: tool.toolName, parameters: tool.input, idempotencyKey: tool.toolUseId });
        } else if (ev.contentEnd) {
          logger.info('[nova-sonic] contentEnd', { callSid: this.callSid });
        } else {
          // Log full payload for unknown events (usageEvent, etc.)
          logger.info('[nova-sonic] Event', { callSid: this.callSid, payload: text.slice(0, 300) });
        }
      } catch { /* ignore parse errors */ }
    }
    logger.info('[nova-sonic] Stream ended', { callSid: this.callSid, audioChunks: audioChunkCount });
    this._isOpen = false;
    this.emit('close');
  }
}

export class NovaSonicBedrockClientFactory implements NovaSonicClientFactory {
  private region: string;
  private toolDefinitions: Record<string, unknown>[];
  constructor(region = 'us-east-1', toolDefinitions: Record<string, unknown>[] = []) {
    this.region = region;
    this.toolDefinitions = toolDefinitions;
  }
  create(callSid: string): NovaSonicClient { return new NovaSonicBedrockClient(callSid, this.region, this.toolDefinitions); }
}
