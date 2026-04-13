/**
 * test-nova-sonic.js
 *
 * Standalone test script for a live voice conversation with Amazon Nova Sonic
 * via AWS Bedrock Runtime bidirectional streaming.
 *
 * Audio input:  MacBook Pro Microphone → ffmpeg → 16kHz PCM → Nova Sonic
 * Audio output: Nova Sonic → 24kHz PCM → ffplay → speakers
 *
 * Usage:
 *   node test-nova-sonic.js
 *   node test-nova-sonic.js --region us-east-1
 *   node test-nova-sonic.js --voice matthew
 *
 * Press Ctrl+C to end the conversation.
 */

'use strict';

const { spawn } = require('child_process');
const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const { v4: uuidv4 } = require('uuid');

// ── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const REGION    = getArg('--region') || process.env.AWS_REGION || 'us-east-1';
const VOICE_ID  = getArg('--voice')  || 'matthew';
const MODEL_ID  = 'amazon.nova-sonic-v1:0';

// macOS AVFoundation audio device index — adjust if needed.
// Run: ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -A5 "audio"
// [0] Microsoft Teams Audio  [1] iPhone Mic  [2] MacBook Pro Microphone
const MIC_DEVICE = getArg('--mic') || '2';

const SYSTEM_PROMPT =
  'You are a friendly and helpful AI assistant. Have a warm, natural conversation ' +
  'with the user. Keep responses concise and conversational.';
const GREETING = "Hello! I'm your AI assistant. How can I help you today?";

// ── AsyncQueue ────────────────────────────────────────────────────────────────

class AsyncQueue {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.done = false;
  }

  push(item) {
    if (this.waiters.length > 0) {
      this.waiters.shift()({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close() {
    this.done = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.done)            return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const promptName       = uuidv4();
  const systemContentName = uuidv4();
  const audioContentName  = uuidv4();
  const inputQueue       = new AsyncQueue();
  let   closing          = false;

  function send(payload) {
    inputQueue.push({ chunk: { bytes: Buffer.from(JSON.stringify(payload)) } });
  }

  // ── 1. Session + prompt init ───────────────────────────────────────────────
  send({ event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } } } });
  send({ event: { promptStart: {
    promptName,
    textOutputConfiguration: { mediaType: 'text/plain' },
    audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId: VOICE_ID },
  } } });

  // ── 2. System prompt ───────────────────────────────────────────────────────
  const fullPrompt = SYSTEM_PROMPT + `\n\nStart the conversation by saying: "${GREETING}"`;
  send({ event: { contentStart: { promptName, contentName: systemContentName, type: 'TEXT', interactive: true, role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } } } });
  send({ event: { textInput: { promptName, contentName: systemContentName, content: fullPrompt } } });
  send({ event: { contentEnd: { promptName, contentName: systemContentName } } });

  // ── 3. Open audio input content block ─────────────────────────────────────
  send({ event: { contentStart: { promptName, contentName: audioContentName, type: 'AUDIO', interactive: true, role: 'USER',
    audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH' },
  } } });

  // ── 4. Connect to Bedrock ─────────────────────────────────────────────────
  console.log(`[nova-sonic] Connecting to ${MODEL_ID} in ${REGION}…`);
  const bedrockClient = new BedrockRuntimeClient({ region: REGION });
  const command = new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: inputQueue });
  const response = await bedrockClient.send(command);
  console.log('[nova-sonic] Connected! Starting audio I/O…\n');

  // ── 5. ffplay — plays 24kHz PCM from Nova Sonic ───────────────────────────
  const ffplay = spawn('ffplay', [
    '-f', 's16le', '-ar', '24000', '-ac', '1',
    '-autoexit', '-nodisp', '-loglevel', 'quiet',
    '-',
  ], { stdio: ['pipe', 'ignore', 'ignore'] });

  ffplay.on('error', (err) => console.error('[ffplay] Error:', err.message));

  // ── 6. ffmpeg — captures microphone as 16kHz PCM ─────────────────────────
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', `:${MIC_DEVICE}`,
    '-ar', '16000',
    '-ac', '1',
    '-acodec', 'pcm_s16le',
    '-f', 's16le',
    '-loglevel', 'quiet',
    '-',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  ffmpeg.on('error', (err) => {
    console.error('[ffmpeg] Error:', err.message);
    console.error('  Try running: ffmpeg -f avfoundation -list_devices true -i "" 2>&1');
    console.error('  Then pass the correct mic index: node test-nova-sonic.js --mic <index>');
  });

  // Feed mic audio to Nova Sonic in 320-byte chunks (~10ms at 16kHz)
  const CHUNK_SIZE = 3200; // 100ms chunks
  let micBuffer = Buffer.alloc(0);

  ffmpeg.stdout.on('data', (data) => {
    micBuffer = Buffer.concat([micBuffer, data]);
    while (micBuffer.length >= CHUNK_SIZE) {
      const chunk = micBuffer.slice(0, CHUNK_SIZE);
      micBuffer = micBuffer.slice(CHUNK_SIZE);
      if (!closing) {
        send({ event: { audioInput: { promptName, contentName: audioContentName, content: chunk.toString('base64') } } });
      }
    }
  });

  // ── 7. Process Nova Sonic output ──────────────────────────────────────────
  let botTurn = false;

  (async () => {
    try {
      for await (const event of response.body) {
        const raw = event?.chunk?.bytes;
        if (!raw) continue;

        let json;
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : new TextDecoder().decode(raw);
          json = JSON.parse(text);
        } catch { continue; }

        const ev = json.event ?? {};

        if (ev.audioOutput) {
          const audio = Buffer.from(ev.audioOutput.content, 'base64');
          ffplay.stdin.write(audio);
          if (!botTurn) {
            process.stdout.write('\n[Bot] ');
            botTurn = true;
          }
          process.stdout.write('▪');

        } else if (ev.textOutput) {
          process.stdout.write(`\n[Bot text] ${ev.textOutput.content}`);

        } else if (ev.contentStart) {
          if (ev.contentStart.role === 'ASSISTANT') {
            botTurn = false;
          } else if (ev.contentStart.role === 'USER') {
            if (botTurn) {
              process.stdout.write('\n');
              botTurn = false;
            }
            console.log('[Interruption — bot stopped]');
          }

        } else if (ev.contentEnd) {
          if (botTurn) {
            process.stdout.write('\n');
            botTurn = false;
          }

        } else if (ev.metadata) {
          // ignore usage metadata

        } else if (ev.internalServerException || ev.throttlingException || ev.validationException) {
          const errName = Object.keys(ev)[0];
          console.error(`\n[Error from Nova Sonic] ${errName}:`, JSON.stringify(ev[errName], null, 2));
        }
      }
    } catch (err) {
      if (!closing) console.error('\n[nova-sonic] Stream error:', err.message);
    } finally {
      console.log('\n[nova-sonic] Stream closed.');
      shutdown(0);
    }
  })();

  // ── 8. Graceful shutdown ──────────────────────────────────────────────────
  function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    console.log('\n[nova-sonic] Closing session…');
    try {
      send({ event: { contentEnd: { promptName, contentName: audioContentName } } });
      send({ event: { promptEnd: { promptName } } });
      send({ event: { sessionEnd: {} } });
      inputQueue.close();
    } catch {}
    ffmpeg.kill('SIGTERM');
    setTimeout(() => {
      try { ffplay.stdin.end(); } catch {}
      setTimeout(() => process.exit(code), 500);
    }, 300);
  }

  process.on('SIGINT', () => {
    console.log('\n[Ctrl+C] Ending conversation…');
    shutdown(0);
  });

  console.log('Speak into your microphone. Press Ctrl+C to end.\n');
}

main().catch((err) => {
  console.error('[fatal]', err.message || err);
  process.exit(1);
});
