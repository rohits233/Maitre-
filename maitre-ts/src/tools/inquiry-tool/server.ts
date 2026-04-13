/**
 * Inquiry Tool MCP Server
 *
 * Communicates over stdio using JSON-lines protocol:
 *   stdin:  { id, toolName, parameters }
 *   stdout: { id, success, data?, error? }
 */

import * as readline from 'readline';
import { ToolResult } from '../../types/index';
import { LocationRepository } from './repository';

const repo = new LocationRepository();

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function getHours(params: Record<string, unknown>): Promise<ToolResult> {
  const locationId = (typeof params.locationId === 'string' && params.locationId) ? params.locationId : 'default';

  const location = await repo.getById(locationId);
  if (!location) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Location not found: ${params.locationId}` } };
  }

  // If a specific date is requested, return hours for that day-of-week
  let hours: Record<string, unknown> = location.operatingHours as unknown as Record<string, unknown>;
  if (params.date && typeof params.date === 'string') {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayIndex = new Date(params.date).getDay();
    const dayName = dayNames[dayIndex];
    const dayHours = location.operatingHours[dayName] ?? location.operatingHours['default'];
    hours = dayHours ? { [dayName]: dayHours } : location.operatingHours as unknown as Record<string, unknown>;
  }

  return {
    success: true,
    data: {
      locationId: location.locationId,
      name: location.name,
      timezone: location.timezone,
      operatingHours: hours,
    },
  };
}

async function getMenu(params: Record<string, unknown>): Promise<ToolResult> {
  const locationId = (typeof params.locationId === 'string' && params.locationId) ? params.locationId : 'default';

  const location = await repo.getById(locationId);
  if (!location) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Location not found: ${params.locationId}` } };
  }

  return {
    success: true,
    data: {
      locationId: location.locationId,
      name: location.name,
      menuUrl: location.menuUrl,
      category: params.category ?? null,
      dietaryFilter: params.dietaryFilter ?? null,
    },
  };
}

async function getLocation(params: Record<string, unknown>): Promise<ToolResult> {
  const locationId = (typeof params.locationId === 'string' && params.locationId) ? params.locationId : 'default';

  const location = await repo.getById(locationId);
  if (!location) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Location not found: ${params.locationId}` } };
  }

  return {
    success: true,
    data: {
      locationId: location.locationId,
      name: location.name,
      address: location.address,
      phone: location.phone,
      mapUrl: location.mapUrl,
      coordinates: location.coordinates as unknown as Record<string, unknown>,
    },
  };
}

// ─── Dispatch table ───────────────────────────────────────────────────────────

const handlers: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> = {
  get_hours: getHours,
  get_menu: getMenu,
  get_location: getLocation,
};

// ─── Public request handler (used by tests and the stdio loop) ────────────────

export async function handleRequest(
  id: string,
  toolName: string,
  parameters: Record<string, unknown>,
): Promise<{ id: string; success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }> {
  const handler = handlers[toolName];
  if (!handler) {
    return { id, success: false, error: { code: 'NOT_FOUND', message: `Unknown tool: ${toolName}` } };
  }
  try {
    const result = await handler(parameters);
    return { id, ...result };
  } catch (err) {
    return { id, success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } };
  }
}

export { repo as locationRepo };

// ─── stdio JSON-lines server loop ─────────────────────────────────────────────

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let id = '';
    try {
      const msg = JSON.parse(trimmed) as { id: string; toolName: string; parameters: Record<string, unknown> };
      id = msg.id;
      const response = await handleRequest(msg.id, msg.toolName, msg.parameters ?? {});
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ id, success: false, error: { code: 'PARSE_ERROR', message: 'Invalid JSON' } }) + '\n');
    }
  });
}
