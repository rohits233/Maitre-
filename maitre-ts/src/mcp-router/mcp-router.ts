import * as fs from 'fs';
import * as cp from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import {
  MCPRouter,
  MCPToolConfig,
  MCPToolConnection,
  ToolRequest,
  ToolResult,
} from '../types/index';

export class MCPRouterImpl implements MCPRouter {
  private tools = new Map<string, MCPToolConfig>();
  private connections = new Map<string, MCPToolConnection>();

  registerTool(config: MCPToolConfig): void {
    this.tools.set(config.name, config);
  }

  async connect(toolName: string): Promise<void> {
    const config = this.tools.get(toolName);
    if (!config) {
      throw new Error(`Tool not registered: ${toolName}`);
    }

    if (config.transport === 'websocket') {
      await this._connectWebSocket(toolName, config);
    } else if (config.transport === 'stdio') {
      await this._connectStdio(toolName, config);
    } else {
      throw new Error(`Unknown transport: ${(config as MCPToolConfig).transport}`);
    }
  }

  private _connectWebSocket(toolName: string, config: MCPToolConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.serverUrl!);

      const conn: MCPToolConnection = {
        config,
        ws,
        state: 'connecting',
        pendingRequests: new Map(),
      };
      this.connections.set(toolName, conn);

      ws.once('open', () => {
        conn.state = 'connected';
        resolve();
      });

      ws.once('error', (err) => {
        if (conn.state === 'connecting') {
          conn.state = 'disconnected';
          reject(err);
        }
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            id: string;
            success: boolean;
            data?: Record<string, unknown>;
            error?: { code: string; message: string };
          };
          const pending = conn.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            conn.pendingRequests.delete(msg.id);
            pending.resolve({ success: msg.success, data: msg.data, error: msg.error });
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        if (conn.state === 'disconnected') {
          // Already intentionally disconnected (e.g. disconnectAll) — skip reconnect
          return;
        }
        conn.state = 'disconnected';
        // Auto-reconnect once after 1 second (unref so it doesn't block process exit)
        const reconnectTimer = setTimeout(() => {
          if (conn.state === 'disconnected' && this.connections.has(toolName)) {
            this._connectWebSocket(toolName, config).catch(() => {
              // reconnect failed — leave as disconnected
            });
          }
        }, 1000);
        reconnectTimer.unref();
      });
    });
  }

  private _connectStdio(toolName: string, config: MCPToolConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(config.command!, config.args ?? [], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      const conn: MCPToolConnection = {
        config,
        process: proc,
        state: 'connecting',
        pendingRequests: new Map(),
      };
      this.connections.set(toolName, conn);

      let buffer = '';

      proc.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as {
              id: string;
              success: boolean;
              data?: Record<string, unknown>;
              error?: { code: string; message: string };
            };
            const pending = conn.pendingRequests.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              conn.pendingRequests.delete(msg.id);
              pending.resolve({ success: msg.success, data: msg.data, error: msg.error });
            }
          } catch {
            // ignore malformed lines
          }
        }
      });

      proc.once('spawn', () => {
        conn.state = 'connected';
        resolve();
      });

      proc.once('error', (err) => {
        if (conn.state === 'connecting') {
          conn.state = 'disconnected';
          reject(err);
        }
      });

      proc.once('exit', () => {
        conn.state = 'disconnected';
        // Reject any pending requests
        for (const [id, pending] of conn.pendingRequests) {
          clearTimeout(pending.timer);
          conn.pendingRequests.delete(id);
          pending.resolve({ success: false, error: { code: 'DISCONNECTED', message: 'Process exited' } });
        }
      });
    });
  }

  async dispatch(request: ToolRequest): Promise<ToolResult> {
    const config = this.tools.get(request.toolName);
    if (!config) {
      return { success: false, error: { code: 'NOT_FOUND', message: `Tool not registered: ${request.toolName}` } };
    }

    const conn = this.connections.get(request.toolName);
    if (!conn || conn.state !== 'connected') {
      return { success: false, error: { code: 'NOT_FOUND', message: `Tool not connected: ${request.toolName}` } };
    }

    const id = uuidv4();
    const timeoutMs = config.timeoutMs ?? 10000;

    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pendingRequests.delete(id);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `Tool invocation timed out after ${timeoutMs}ms` } });
      }, timeoutMs);

      conn.pendingRequests.set(id, { resolve, reject: () => {}, timer });

      const payload = JSON.stringify({ id, toolName: request.toolName, parameters: request.parameters });

      if (conn.ws) {
        conn.ws.send(payload);
      } else if (conn.process?.stdin) {
        conn.process.stdin.write(payload + '\n');
      }
    });
  }

  loadConfig(configPath: string): void {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { tools: MCPToolConfig[] };
    for (const toolConfig of parsed.tools) {
      this.registerTool(toolConfig);
    }
  }

  async disconnectAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const [name, conn] of this.connections) {
      conn.state = 'disconnected';

      // Reject all pending requests
      for (const [id, pending] of conn.pendingRequests) {
        clearTimeout(pending.timer);
        conn.pendingRequests.delete(id);
        pending.resolve({ success: false, error: { code: 'DISCONNECTED', message: 'Router disconnected' } });
      }

      if (conn.ws) {
        closePromises.push(
          new Promise<void>((resolve) => {
            conn.ws!.once('close', resolve);
            conn.ws!.close();
            // Resolve immediately if already closed
            if (conn.ws!.readyState === WebSocket.CLOSED) resolve();
          })
        );
      }

      if (conn.process) {
        conn.process.kill();
      }

      this.connections.delete(name);
    }

    await Promise.all(closePromises);
  }
}
