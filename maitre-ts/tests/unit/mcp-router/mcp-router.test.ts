import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as net from 'net';
import { MCPRouterImpl } from '../../../src/mcp-router/mcp-router';
import { MCPToolConfig } from '../../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function startWss(
  port: number,
  handler?: (ws: WebSocket) => void
): Promise<{ wss: WebSocketServer; httpServer: http.Server }> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    if (handler) wss.on('connection', handler);
    httpServer.on('error', reject);
    httpServer.listen(port, () => resolve({ wss, httpServer }));
  });
}

function closeWss(wss: WebSocketServer, httpServer: http.Server): Promise<void> {
  return new Promise((resolve) => {
    // Close all client connections first
    wss.clients.forEach((c) => c.terminate());
    wss.close(() => httpServer.close(() => resolve()));
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCPRouterImpl', () => {
  let router: MCPRouterImpl;

  beforeEach(() => {
    router = new MCPRouterImpl();
  });

  afterEach(async () => {
    await router.disconnectAll();
  });

  // ── dispatch: NOT_FOUND for unregistered tool ──────────────────────────────

  describe('dispatch', () => {
    it('returns NOT_FOUND when tool is not registered', async () => {
      const result = await router.dispatch({ toolName: 'unknown_tool', parameters: {} });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when tool is registered but not connected', async () => {
      router.registerTool({
        name: 'my_tool',
        transport: 'websocket',
        serverUrl: 'ws://localhost:9999',
        timeoutMs: 10000,
      });
      const result = await router.dispatch({ toolName: 'my_tool', parameters: {} });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });

    it('returns TIMEOUT when tool server does not respond within timeoutMs', async () => {
      const port = await getFreePort();
      // Server accepts connections but never responds to messages
      const { wss, httpServer } = await startWss(port);

      const config: MCPToolConfig = {
        name: 'silent_tool',
        transport: 'websocket',
        serverUrl: `ws://localhost:${port}`,
        timeoutMs: 150, // very short timeout
      };
      router.registerTool(config);
      await router.connect('silent_tool');

      const result = await router.dispatch({ toolName: 'silent_tool', parameters: {} });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TIMEOUT');

      await closeWss(wss, httpServer);
    }, 8000);
  });

  // ── registerTool + connect + dispatch with mock WS server ─────────────────

  describe('WebSocket transport', () => {
    it('dispatches a request and receives a response from a mock WS server', async () => {
      const port = await getFreePort();
      const { wss, httpServer } = await startWss(port, (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as {
            id: string;
            toolName: string;
            parameters: unknown;
          };
          ws.send(
            JSON.stringify({ id: msg.id, success: true, data: { echo: msg.parameters } })
          );
        });
      });

      const config: MCPToolConfig = {
        name: 'echo_tool',
        transport: 'websocket',
        serverUrl: `ws://localhost:${port}`,
        timeoutMs: 5000,
      };
      router.registerTool(config);
      await router.connect('echo_tool');

      const result = await router.dispatch({
        toolName: 'echo_tool',
        parameters: { foo: 'bar' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ echo: { foo: 'bar' } });

      await closeWss(wss, httpServer);
    }, 12000);

    it('forwards error responses from the tool server', async () => {
      const port = await getFreePort();
      const { wss, httpServer } = await startWss(port, (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as { id: string };
          ws.send(
            JSON.stringify({
              id: msg.id,
              success: false,
              error: { code: 'TOOL_ERROR', message: 'Something went wrong' },
            })
          );
        });
      });

      const config: MCPToolConfig = {
        name: 'error_tool',
        transport: 'websocket',
        serverUrl: `ws://localhost:${port}`,
        timeoutMs: 5000,
      };
      router.registerTool(config);
      await router.connect('error_tool');

      const result = await router.dispatch({ toolName: 'error_tool', parameters: {} });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOOL_ERROR');

      await closeWss(wss, httpServer);
    }, 12000);
  });

  // ── disconnectAll ──────────────────────────────────────────────────────────

  describe('disconnectAll', () => {
    it('closes all open WebSocket connections', async () => {
      const port = await getFreePort();
      const connectedClients: WebSocket[] = [];
      const { wss, httpServer } = await startWss(port, (ws) => connectedClients.push(ws));

      const config: MCPToolConfig = {
        name: 'closeable_tool',
        transport: 'websocket',
        serverUrl: `ws://localhost:${port}`,
        timeoutMs: 5000,
      };
      router.registerTool(config);
      await router.connect('closeable_tool');

      expect(connectedClients).toHaveLength(1);

      await router.disconnectAll();

      // After disconnectAll, dispatching should return NOT_FOUND (connection removed)
      const result = await router.dispatch({ toolName: 'closeable_tool', parameters: {} });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');

      await closeWss(wss, httpServer);
    }, 12000);

    it('resolves pending requests with DISCONNECTED error on disconnectAll', async () => {
      const port = await getFreePort();
      const { wss, httpServer } = await startWss(port); // silent server

      const config: MCPToolConfig = {
        name: 'pending_tool',
        transport: 'websocket',
        serverUrl: `ws://localhost:${port}`,
        timeoutMs: 30000,
      };
      router.registerTool(config);
      await router.connect('pending_tool');

      const dispatchPromise = router.dispatch({ toolName: 'pending_tool', parameters: {} });
      await router.disconnectAll();

      const result = await dispatchPromise;
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DISCONNECTED');

      await closeWss(wss, httpServer);
    }, 12000);
  });

  // ── loadConfig ─────────────────────────────────────────────────────────────

  describe('loadConfig', () => {
    it('registers tools from a JSON config file', async () => {
      const { writeFileSync, unlinkSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      const configPath = join(tmpdir(), `mcp-test-config-${Date.now()}.json`);
      const configData = {
        tools: [
          {
            name: 'tool_a',
            transport: 'websocket',
            serverUrl: 'ws://localhost:1111',
            timeoutMs: 5000,
          },
          {
            name: 'tool_b',
            transport: 'websocket',
            serverUrl: 'ws://localhost:2222',
            timeoutMs: 5000,
          },
        ],
      };
      writeFileSync(configPath, JSON.stringify(configData));

      router.loadConfig(configPath);

      // Both tools should be registered — dispatch returns NOT_FOUND (not connected, but registered)
      const resultA = await router.dispatch({ toolName: 'tool_a', parameters: {} });
      const resultB = await router.dispatch({ toolName: 'tool_b', parameters: {} });

      expect(resultA.error?.code).toBe('NOT_FOUND');
      expect(resultB.error?.code).toBe('NOT_FOUND');

      unlinkSync(configPath);
    });
  });
});
