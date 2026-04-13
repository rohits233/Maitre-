/**
 * Webhook handler for POST /voice/inbound and GET /health.
 *
 * createWebhookHandler returns an Express Router that:
 *   - POST /voice/inbound: validates Twilio signature, returns TwiML to connect
 *     the call to the media stream WebSocket.
 *   - GET /health: returns 200 { status: 'ok' } or 503 { status: 'draining' }
 *     based on the module-level isDraining flag.
 *
 * Requirements: 1.1, 1.3, 7.2
 */

import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { validateTwilioSignature } from './signature-validator';
import { VIPRouter, CallFlowEvaluator } from '../types/index';

// ─── Draining flag ────────────────────────────────────────────────────────────

let isDraining = false;

export function setDraining(value: boolean): void {
  isDraining = value;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface WebhookHandlerConfig {
  twilioAuthToken: string;
  /** Hostname used to build the wss:// media stream URL (e.g. "example.ngrok.io") */
  host: string;
}

export function createWebhookHandler(
  vipRouter: VIPRouter | null,
  callFlowEvaluator: CallFlowEvaluator | null,
  config: WebhookHandlerConfig
): Router {
  const router = Router();

  // ── Health check ────────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    if (isDraining) {
      res.status(503).json({ status: 'draining' });
    } else {
      res.status(200).json({ status: 'ok' });
    }
  });

  // ── Inbound call webhook ────────────────────────────────────────────────────
  router.post(
    '/voice/inbound',
    validateTwilioSignature(config.twilioAuthToken),
    async (req: Request, res: Response) => {
      try {
        // VIP and call flow checks are stubbed — vipRouter/callFlowEvaluator may be null
        void vipRouter;
        void callFlowEvaluator;

        const twiml = new twilio.twiml.VoiceResponse();
        const connect = twiml.connect();
        connect.stream({ url: `wss://${config.host}/media-stream` });

        res.type('text/xml');
        res.status(200).send(twiml.toString());
      } catch (err) {
        console.error('[webhook-handler] Error handling inbound call:', err);

        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('An error occurred');
        twiml.hangup();

        res.type('text/xml');
        res.status(200).send(twiml.toString());
      }
    }
  );

  return router;
}
