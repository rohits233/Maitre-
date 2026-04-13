/**
 * Reservation Tool MCP Server
 *
 * Communicates over stdio using JSON-lines protocol:
 *   stdin:  { id, toolName, parameters }
 *   stdout: { id, success, data?, error? }
 */

import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { Reservation } from '../../types/models';
import { ToolResult } from '../../types/index';
import { ReservationRepository } from './repository';

// ─── Operating hours defaults ─────────────────────────────────────────────────

const DEFAULT_OPEN = process.env.OPERATING_HOURS_OPEN ?? '11:00';
const DEFAULT_CLOSE = process.env.OPERATING_HOURS_CLOSE ?? '22:00';

// ─── Idempotency store (in-memory; DynamoDB in production) ────────────────────

const idempotencyStore = new Map<string, ToolResult>();

// ─── Validation helpers ───────────────────────────────────────────────────────

function isPositiveInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function isDateInPast(date: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return date < today;
}

function isValidDateFormat(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isValidTimeFormat(time: string): boolean {
  return /^\d{2}:\d{2}$/.test(time);
}

function isTimeWithinHours(time: string, open: string, close: string): boolean {
  return time >= open && time <= close;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function isTimeInRange(time: string, open: string, close: string): boolean {
  const t = timeToMinutes(time);
  return t >= timeToMinutes(open) && t <= timeToMinutes(close);
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

const repo = new ReservationRepository();

async function createReservation(params: Record<string, unknown>): Promise<ToolResult> {
  const idempotencyKey = params.idempotencyKey as string | undefined;
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) return cached;
  }

  const invalidFields: string[] = [];

  if (!params.guestName || typeof params.guestName !== 'string') invalidFields.push('guestName');
  if (!isPositiveInteger(params.partySize)) invalidFields.push('partySize');
  if (!params.date || !isValidDateFormat(params.date as string)) {
    invalidFields.push('date');
  } else if (isDateInPast(params.date as string)) {
    invalidFields.push('date (must not be in the past)');
  }
  if (!params.time || !isValidTimeFormat(params.time as string)) {
    invalidFields.push('time');
  } else if (!isTimeInRange(params.time as string, DEFAULT_OPEN, DEFAULT_CLOSE)) {
    invalidFields.push(`time (must be between ${DEFAULT_OPEN} and ${DEFAULT_CLOSE})`);
  }
  if (!params.locationId || typeof params.locationId !== 'string') invalidFields.push('locationId');
  if (!idempotencyKey) invalidFields.push('idempotencyKey');

  if (invalidFields.length > 0) {
    return {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: `Invalid fields: ${invalidFields.join(', ')}` },
    };
  }

  const now = new Date().toISOString();
  const reservation: Reservation = {
    reservationId: uuidv4(),
    locationId: params.locationId as string,
    guestName: params.guestName as string,
    partySize: params.partySize as number,
    date: params.date as string,
    time: params.time as string,
    specialRequests: params.specialRequests as string | undefined,
    status: 'confirmed',
    confirmationNumber: repo._generateConfirmationNumber(),
    createdAt: now,
    updatedAt: now,
    callerPhone: (params.callerPhone as string) ?? '',
    correlationId: (params.correlationId as string) ?? '',
    idempotencyKey: idempotencyKey!,
  };

  await repo.create(reservation);

  const result: ToolResult = {
    success: true,
    data: {
      reservationId: reservation.reservationId,
      confirmationNumber: reservation.confirmationNumber,
      guestName: reservation.guestName,
      partySize: reservation.partySize,
      date: reservation.date,
      time: reservation.time,
      locationId: reservation.locationId,
      status: reservation.status,
    },
  };

  if (idempotencyKey) idempotencyStore.set(idempotencyKey, result);
  return result;
}

async function modifyReservation(params: Record<string, unknown>): Promise<ToolResult> {
  if (!params.reservationId || typeof params.reservationId !== 'string') {
    return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid fields: reservationId' } };
  }

  const existing = await repo.getById(params.reservationId as string);
  if (!existing) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Reservation not found: ${params.reservationId}` } };
  }

  const updates = params.updates as Record<string, unknown> | undefined ?? {};
  const invalidFields: string[] = [];

  if (updates.partySize !== undefined && !isPositiveInteger(updates.partySize)) {
    invalidFields.push('partySize');
  }
  if (updates.date !== undefined) {
    if (!isValidDateFormat(updates.date as string)) {
      invalidFields.push('date');
    } else if (isDateInPast(updates.date as string)) {
      invalidFields.push('date (must not be in the past)');
    }
  }
  if (updates.time !== undefined) {
    if (!isValidTimeFormat(updates.time as string)) {
      invalidFields.push('time');
    } else if (!isTimeInRange(updates.time as string, DEFAULT_OPEN, DEFAULT_CLOSE)) {
      invalidFields.push(`time (must be between ${DEFAULT_OPEN} and ${DEFAULT_CLOSE})`);
    }
  }

  if (invalidFields.length > 0) {
    return { success: false, error: { code: 'VALIDATION_ERROR', message: `Invalid fields: ${invalidFields.join(', ')}` } };
  }

  const updated = await repo.update(params.reservationId as string, {
    ...updates,
    status: 'modified',
  } as Partial<Reservation>);

  return {
    success: true,
    data: updated as unknown as Record<string, unknown>,
  };
}

async function cancelReservation(params: Record<string, unknown>): Promise<ToolResult> {
  const idempotencyKey = params.idempotencyKey as string | undefined;
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) return cached;
  }

  if (!params.reservationId || typeof params.reservationId !== 'string') {
    return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid fields: reservationId' } };
  }

  const existing = await repo.getById(params.reservationId as string);
  if (!existing) {
    return { success: false, error: { code: 'NOT_FOUND', message: `Reservation not found: ${params.reservationId}` } };
  }

  await repo.update(params.reservationId as string, { status: 'canceled' });

  const result: ToolResult = {
    success: true,
    data: { reservationId: params.reservationId, status: 'canceled' },
  };

  if (idempotencyKey) idempotencyStore.set(idempotencyKey, result);
  return result;
}

async function getReservation(params: Record<string, unknown>): Promise<ToolResult> {
  if (params.reservationId) {
    const r = await repo.getById(params.reservationId as string);
    if (!r) return { success: false, error: { code: 'NOT_FOUND', message: 'Reservation not found' } };
    return { success: true, data: r as unknown as Record<string, unknown> };
  }

  if (params.guestName && params.date && params.locationId) {
    const r = await repo.getByGuestNameAndDate(
      params.guestName as string,
      params.date as string,
      params.locationId as string,
    );
    if (!r) return { success: false, error: { code: 'NOT_FOUND', message: 'Reservation not found' } };
    return { success: true, data: r as unknown as Record<string, unknown> };
  }

  return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Provide reservationId or guestName+date+locationId' } };
}

async function checkAvailability(params: Record<string, unknown>): Promise<ToolResult> {
  const invalidFields: string[] = [];
  if (!params.locationId) invalidFields.push('locationId');
  if (!params.date || !isValidDateFormat(params.date as string)) invalidFields.push('date');
  if (!isPositiveInteger(params.partySize)) invalidFields.push('partySize');

  if (invalidFields.length > 0) {
    return { success: false, error: { code: 'VALIDATION_ERROR', message: `Invalid fields: ${invalidFields.join(', ')}` } };
  }

  const slots = await repo.checkAvailability(
    params.locationId as string,
    params.date as string,
    params.partySize as number,
  );

  return { success: true, data: { slots } };
}

async function checkGroupAvailability(params: Record<string, unknown>): Promise<ToolResult> {
  const invalidFields: string[] = [];
  if (!params.restaurantGroupId) invalidFields.push('restaurantGroupId');
  if (!params.date || !isValidDateFormat(params.date as string)) invalidFields.push('date');
  if (!isPositiveInteger(params.partySize)) invalidFields.push('partySize');

  if (invalidFields.length > 0) {
    return { success: false, error: { code: 'VALIDATION_ERROR', message: `Invalid fields: ${invalidFields.join(', ')}` } };
  }

  const results = await repo.checkGroupAvailability(
    params.restaurantGroupId as string,
    params.date as string,
    params.partySize as number,
    params.excludeLocationId as string | undefined,
  );

  // Cap at 3 alternatives, include location name, address, and available times
  const alternatives = results.slice(0, 3).map(({ location, slots }) => ({
    locationId: location.locationId,
    name: location.name,
    address: location.address,
    availableTimes: slots.map((s) => s.time),
  }));

  return { success: true, data: { alternatives } };
}

// ─── Dispatch table ───────────────────────────────────────────────────────────

const handlers: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> = {
  create_reservation: createReservation,
  modify_reservation: modifyReservation,
  cancel_reservation: cancelReservation,
  get_reservation: getReservation,
  check_availability: checkAvailability,
  check_group_availability: checkGroupAvailability,
};

// ─── stdio JSON-lines server loop ─────────────────────────────────────────────

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
