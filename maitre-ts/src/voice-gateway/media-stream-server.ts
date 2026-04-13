/**
 * WebSocket Media Stream server for /media-stream.
 *
 * Handles Twilio media stream events: connected, start, media, stop, mark.
 * Sends heartbeat mark messages every 30 seconds to keep the connection alive.
 *
 * Requirements: 1.2, 2.1, 2.2, 5.1, 5.2, 5.3, 5.4
 */

import { WebSocketServer, WebSocket } from 'ws';
import { MediaStreamMessage, SessionManager, AudioTranscoder, ConversationEngine, VoicePersona, MCPRouter } from '../types/index';

const HEARTBEAT_INTERVAL_MS = 30_000;

export function createMediaStreamServer(
  sessionManager: SessionManager,
  audioTranscoder: AudioTranscoder,
  conversationEngine?: ConversationEngine,
  voicePersona?: VoicePersona,
  mcpRouter?: MCPRouter,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    let callSid: string | null = null;
    let streamSid: string | null = null;

    // ── Heartbeat ─────────────────────────────────────────────────────────────
    const heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const mark = JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: 'heartbeat' },
        });
        ws.send(mark);
      }
    }, HEARTBEAT_INTERVAL_MS);

    ws.on('message', (data: Buffer | string) => {
      let msg: MediaStreamMessage;
      try {
        msg = JSON.parse(data.toString()) as MediaStreamMessage;
      } catch (err) {
        console.error('[media-stream] Failed to parse message:', err);
        return;
      }

      switch (msg.event) {
        case 'connected':
          console.info('[media-stream] Twilio media stream connected');
          break;

        case 'start': {
          if (!msg.start) {
            console.warn('[media-stream] Received start event without start payload');
            break;
          }
          callSid = msg.start.callSid;
          streamSid = msg.streamSid ?? null;
          const callerPhone = ''; // Caller phone is not in the start event; populated from webhook
          const session = sessionManager.createSession(callSid, streamSid ?? '', callerPhone);
          console.info(`[media-stream] Session started: callSid=${callSid} streamSid=${streamSid}`);

          // Start Nova Sonic session if conversation engine is wired
          if (conversationEngine && voicePersona) {
            console.info(`[media-stream] Starting Nova Sonic session for callSid=${callSid}`);
            conversationEngine.startSession(session, voicePersona).then(() => {
              console.info(`[media-stream] Nova Sonic session started for callSid=${callSid}`);
              // Route Nova Sonic audio output back to Twilio
              conversationEngine.onAudioOutput(callSid!, (pcmBuffer: Buffer) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const mulawBuffer = audioTranscoder.novaSonicToMulaw(pcmBuffer);
                const mediaMsg = JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: { payload: mulawBuffer.toString('base64') },
                });
                ws.send(mediaMsg);
              });

              // Handle interruptions — send clear to Twilio
              conversationEngine.onInterruption(callSid!, () => {
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({ event: 'clear', streamSid }));
              });

              // Dispatch tool requests via MCP router
              if (mcpRouter) {
                conversationEngine.onToolRequest(callSid!, (req) => mcpRouter.dispatch(req));
              }
            }).catch((err: Error) => {
              console.error(`[media-stream] Failed to start Nova Sonic session: ${err.message}`, err.stack);
            });
          }
          break;
        }

        case 'media': {
          if (!msg.media || !callSid) break;

          const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
          const pcmBuffer = audioTranscoder.mulawToNovaSonic(mulawBuffer);

          // Forward audio to Nova Sonic if conversation engine is wired
          if (conversationEngine) {
            conversationEngine.sendAudio(callSid, pcmBuffer);
          }
          break;
        }

        case 'stop': {
          if (callSid) {
            console.info(`[media-stream] Stop event received: callSid=${callSid}`);
            if (conversationEngine) {
              conversationEngine.endSession(callSid).catch(() => {});
            }
            sessionManager.terminateSession(callSid, 'caller_hangup');
          }
          break;
        }

        case 'mark':
          // Acknowledge mark events (used for flow control / interruption)
          break;

        default:
          console.warn(`[media-stream] Unknown event: ${(msg as { event: string }).event}`);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeatTimer);
      if (callSid) {
        if (conversationEngine) {
          conversationEngine.endSession(callSid).catch(() => {});
        }
        const session = sessionManager.getSession(callSid);
        if (session && !session.endTime) {
          sessionManager.terminateSession(callSid, 'caller_hangup');
        }
      }
    });

    ws.on('error', (err: Error) => {
      console.error(`[media-stream] WebSocket error: ${err.message}`);
      clearInterval(heartbeatTimer);
    });
  });

  return wss;
}
