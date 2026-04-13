/**
 * Application entry point — wires all components and starts the HTTP/WebSocket server.
 *
 * Requirements: 1.1, 1.2, 4.1, 6.1, 7.2, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4
 */

import http from 'http';
import express from 'express';
import { loadConfig } from './config';
import { logger } from './logger';
import { InMemorySessionManager } from './session/session-manager';
import { ConversationEngineImpl } from './conversation-engine/conversation-engine';
import { NovaSonicBedrockClientFactory } from './conversation-engine/nova-sonic-client';
import { audioTranscoder } from './conversation-engine/audio-transcoder';
import { MCPRouterImpl } from './mcp-router/mcp-router';
import { VIPRouterImpl } from './voice-gateway/vip-router';
import { CallFlowEvaluatorImpl } from './voice-gateway/call-flow-evaluator';
import { VoicePersonaLoader } from './voice-gateway/voice-persona';
import { SMSService } from './services/sms-service';
import { FeedbackService } from './services/feedback-service';
import { AnalyticsService } from './services/analytics-service';
import { createWebhookHandler, setDraining } from './voice-gateway/webhook-handler';
import { createMediaStreamServer } from './voice-gateway/media-stream-server';
import { startActiveConnectionsReporter, publishSessionDuration } from './metrics';
import { CallSession } from './types/index';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = await loadConfig();

  const host = process.env['HOST'] ?? 'localhost:8080';

  // ── Express app ─────────────────────────────────────────────────────────────
  const app = express();
  app.set('trust proxy', true);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // ── Inquiry tool definitions (sent to Nova Sonic so it knows what to call) ──
  const inquiryToolDefinitions = [
    {
      toolSpec: {
        name: 'get_hours',
        description: 'Get the restaurant operating hours. Use when the caller asks what time the restaurant opens or closes, or whether it is open on a specific day.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Optional date in YYYY-MM-DD format to get hours for that specific day' },
            },
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_menu',
        description: 'Get the restaurant menu URL. Use when the caller asks about the menu, what dishes are available, or wants the menu link.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_location',
        description: 'Get the restaurant address, phone number, and directions link. Use when the caller asks for the address or how to get there.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
    },
  ];

  // ── Core components ─────────────────────────────────────────────────────────
  const sessionManager = new InMemorySessionManager();
  const conversationEngine = new ConversationEngineImpl(
    new NovaSonicBedrockClientFactory(config.awsRegion, inquiryToolDefinitions)
  );
  const mcpRouter = new MCPRouterImpl();

  // ── Register & connect inquiry tool (stdio) ──────────────────────────────────
  mcpRouter.registerTool({ name: 'get_hours',    transport: 'stdio', command: 'node', args: ['dist/tools/inquiry-tool/server.js'], timeoutMs: 10000 });
  mcpRouter.registerTool({ name: 'get_menu',     transport: 'stdio', command: 'node', args: ['dist/tools/inquiry-tool/server.js'], timeoutMs: 10000 });
  mcpRouter.registerTool({ name: 'get_location', transport: 'stdio', command: 'node', args: ['dist/tools/inquiry-tool/server.js'], timeoutMs: 10000 });

  await Promise.all([
    mcpRouter.connect('get_hours').catch((err: unknown) => {
      logger.error('[startup] Failed to connect get_hours tool', { error: String(err) });
    }),
    mcpRouter.connect('get_menu').catch((err: unknown) => {
      logger.error('[startup] Failed to connect get_menu tool', { error: String(err) });
    }),
    mcpRouter.connect('get_location').catch((err: unknown) => {
      logger.error('[startup] Failed to connect get_location tool', { error: String(err) });
    }),
  ]);
  const vipRouter = new VIPRouterImpl(config.vipListTable);
  const callFlowEvaluator = new CallFlowEvaluatorImpl(config.callFlowRulesTable);
  const voicePersonaLoader = new VoicePersonaLoader(config.voicePersonasTable);
  const smsService = new SMSService(config);
  const feedbackService = new FeedbackService(config, smsService);
  const analyticsService = new AnalyticsService(config);

  // ── Subscribe services to session events ────────────────────────────────────
  smsService.subscribeToSessionManager(sessionManager);
  feedbackService.subscribeToSessionManager(sessionManager);
  analyticsService.subscribeToSessionManager(sessionManager);

  // ── Publish CallSessionDuration on session termination ───────────────────────
  sessionManager.on('session:terminated', (session: unknown) => {
    const s = session as CallSession;
    if (s.endTime) {
      const durationSeconds = Math.round(
        (s.endTime.getTime() - s.startTime.getTime()) / 1000
      );
      publishSessionDuration(durationSeconds, s.correlationId).catch(() => {});
    }
  });

  // ── Load startup data ────────────────────────────────────────────────────────
  await Promise.all([
    vipRouter.refreshList().catch((err: unknown) => {
      logger.error('[startup] Failed to load VIP list', { error: String(err) });
    }),
    callFlowEvaluator.loadRules().catch((err: unknown) => {
      logger.error('[startup] Failed to load call flow rules', { error: String(err) });
    }),
    voicePersonaLoader.load(config.defaultLocationId).catch((err: unknown) => {
      logger.error('[startup] Failed to load voice persona', { error: String(err) });
    }),
  ]);

  // ── Webhook router ───────────────────────────────────────────────────────────
  const webhookRouter = createWebhookHandler(vipRouter, callFlowEvaluator, {
    twilioAuthToken: config.twilioAuthToken,
    host,
  });
  app.use('/', webhookRouter);

  // ── WebSocket media stream server ────────────────────────────────────────────
  const defaultPersona = voicePersonaLoader.getDefault();
  const wss = createMediaStreamServer(sessionManager, audioTranscoder, conversationEngine, defaultPersona, mcpRouter);

  // ── HTTP server ──────────────────────────────────────────────────────────────
  const server = http.createServer(app);

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/media-stream') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // ── CloudWatch EMF metrics ───────────────────────────────────────────────────
  const metricsTimer = startActiveConnectionsReporter(sessionManager);

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  process.on('SIGTERM', () => {
    logger.info('[shutdown] SIGTERM received — starting graceful drain');

    setDraining(true);

    server.close(() => {
      logger.info('[shutdown] HTTP server closed');
    });

    const drainStart = Date.now();
    const pollInterval = setInterval(() => {
      const active = sessionManager.getActiveSessions();
      if (active.length === 0 || Date.now() - drainStart >= config.drainTimeoutMs) {
        clearInterval(pollInterval);
        clearInterval(metricsTimer);

        mcpRouter.disconnectAll().then(() => {
          logger.info('[shutdown] MCP connections closed — exiting');
          process.exit(0);
        }).catch(() => {
          process.exit(0);
        });
      } else {
        logger.info(`[shutdown] Waiting for ${active.length} active session(s)…`);
      }
    }, 1000);
  });

  // ── Start listening ──────────────────────────────────────────────────────────
  server.listen(config.port, () => {
    logger.info('[startup] Voice Gateway started', {
      port: config.port,
      webhookUrl: `https://${host}/voice/inbound`,
      nodeEnv: config.nodeEnv,
    });
  });

  // Suppress unused-variable warnings for components wired but not yet fully used
  void conversationEngine;
}

main().catch((err: unknown) => {
  logger.error('[startup] Fatal error during startup', { error: String(err) });
  process.exit(1);
});
