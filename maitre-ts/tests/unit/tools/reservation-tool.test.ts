import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest } from '../../../src/tools/reservation-tool/server';
import { ReservationRepository } from '../../../src/tools/reservation-tool/repository';

// Use in-memory local DB for all tests
process.env.USE_LOCAL_DB = 'true';

const repo = new ReservationRepository();

// Future date helper
function futureDate(daysAhead = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  repo._clearLocal();
});

describe('create_reservation', () => {
  it('creates a reservation with valid data', async () => {
    const res = await handleRequest('1', 'create_reservation', {
      guestName: 'Alice',
      partySize: 2,
      date: futureDate(),
      time: '19:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-1',
    });
    expect(res.success).toBe(true);
    expect(res.data?.confirmationNumber).toMatch(/^RES-/);
    expect(res.data?.guestName).toBe('Alice');
    expect(res.data?.partySize).toBe(2);
  });

  it('rejects past date', async () => {
    const res = await handleRequest('2', 'create_reservation', {
      guestName: 'Bob',
      partySize: 2,
      date: '2020-01-01',
      time: '19:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-2',
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('VALIDATION_ERROR');
    expect(res.error?.message).toContain('date');
  });

  it('rejects non-positive party size', async () => {
    const res = await handleRequest('3', 'create_reservation', {
      guestName: 'Carol',
      partySize: 0,
      date: futureDate(),
      time: '19:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-3',
    });
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('partySize');
  });

  it('rejects time outside operating hours', async () => {
    const res = await handleRequest('4', 'create_reservation', {
      guestName: 'Dave',
      partySize: 2,
      date: futureDate(),
      time: '23:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-4',
    });
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('time');
  });

  it('enforces idempotency — second call returns same result', async () => {
    const params = {
      guestName: 'Eve',
      partySize: 3,
      date: futureDate(),
      time: '18:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-5',
    };
    const first = await handleRequest('5a', 'create_reservation', params);
    const second = await handleRequest('5b', 'create_reservation', params);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data?.confirmationNumber).toBe(first.data?.confirmationNumber);
  });

  it('returns error for missing idempotencyKey', async () => {
    const res = await handleRequest('6', 'create_reservation', {
      guestName: 'Frank',
      partySize: 2,
      date: futureDate(),
      time: '19:00',
      locationId: 'loc-1',
    });
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('idempotencyKey');
  });
});

describe('modify_reservation', () => {
  it('modifies an existing reservation', async () => {
    const created = await handleRequest('m1', 'create_reservation', {
      guestName: 'Grace',
      partySize: 2,
      date: futureDate(),
      time: '18:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-m1',
    });
    const reservationId = created.data?.reservationId as string;

    const modified = await handleRequest('m2', 'modify_reservation', {
      reservationId,
      updates: { partySize: 4 },
    });
    expect(modified.success).toBe(true);
    expect(modified.data?.partySize).toBe(4);
    expect(modified.data?.reservationId).toBe(reservationId);
  });

  it('returns NOT_FOUND for unknown reservation', async () => {
    const res = await handleRequest('m3', 'modify_reservation', {
      reservationId: 'nonexistent',
      updates: { partySize: 2 },
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('rejects invalid partySize in updates', async () => {
    const created = await handleRequest('m4', 'create_reservation', {
      guestName: 'Hank',
      partySize: 2,
      date: futureDate(),
      time: '18:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-m4',
    });
    const reservationId = created.data?.reservationId as string;

    const res = await handleRequest('m5', 'modify_reservation', {
      reservationId,
      updates: { partySize: -1 },
    });
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('partySize');
  });
});

describe('cancel_reservation', () => {
  it('cancels an existing reservation', async () => {
    const created = await handleRequest('c1', 'create_reservation', {
      guestName: 'Iris',
      partySize: 2,
      date: futureDate(),
      time: '18:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-c1',
    });
    const reservationId = created.data?.reservationId as string;

    const cancelled = await handleRequest('c2', 'cancel_reservation', {
      reservationId,
      idempotencyKey: 'idem-cancel-c1',
    });
    expect(cancelled.success).toBe(true);
    expect(cancelled.data?.status).toBe('canceled');
  });

  it('enforces idempotency on cancel', async () => {
    const created = await handleRequest('c3', 'create_reservation', {
      guestName: 'Jack',
      partySize: 2,
      date: futureDate(),
      time: '18:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-c3',
    });
    const reservationId = created.data?.reservationId as string;
    const params = { reservationId, idempotencyKey: 'idem-cancel-c3' };

    const first = await handleRequest('c4a', 'cancel_reservation', params);
    const second = await handleRequest('c4b', 'cancel_reservation', params);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data?.status).toBe('canceled');
  });
});

describe('get_reservation', () => {
  it('retrieves by reservationId', async () => {
    const created = await handleRequest('g1', 'create_reservation', {
      guestName: 'Karen',
      partySize: 2,
      date: futureDate(),
      time: '18:00',
      locationId: 'loc-1',
      idempotencyKey: 'idem-g1',
    });
    const reservationId = created.data?.reservationId as string;

    const fetched = await handleRequest('g2', 'get_reservation', { reservationId });
    expect(fetched.success).toBe(true);
    expect(fetched.data?.guestName).toBe('Karen');
  });

  it('returns NOT_FOUND for unknown id', async () => {
    const res = await handleRequest('g3', 'get_reservation', { reservationId: 'unknown' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });
});

describe('check_availability', () => {
  it('returns available slots', async () => {
    repo._seedAvailability({
      locationId: 'loc-1',
      date: futureDate(),
      time: '18:00',
      maxPartySize: 10,
      remainingCapacity: 5,
    });

    const res = await handleRequest('a1', 'check_availability', {
      locationId: 'loc-1',
      date: futureDate(),
      partySize: 4,
    });
    expect(res.success).toBe(true);
    expect((res.data?.slots as unknown[]).length).toBeGreaterThan(0);
  });

  it('returns empty when no capacity', async () => {
    repo._seedAvailability({
      locationId: 'loc-1',
      date: futureDate(),
      time: '18:00',
      maxPartySize: 2,
      remainingCapacity: 1,
    });

    const res = await handleRequest('a2', 'check_availability', {
      locationId: 'loc-1',
      date: futureDate(),
      partySize: 5,
    });
    expect(res.success).toBe(true);
    expect((res.data?.slots as unknown[]).length).toBe(0);
  });

  it('validates required fields', async () => {
    const res = await handleRequest('a3', 'check_availability', { locationId: 'loc-1' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('check_group_availability', () => {
  it('returns alternatives capped at 3', async () => {
    const date = futureDate();
    for (let i = 1; i <= 5; i++) {
      repo._seedLocation({
        locationId: `loc-${i}`,
        restaurantGroupId: 'group-1',
        name: `Restaurant ${i}`,
        address: `${i} Main St`,
        phone: '+15550000000',
        mapUrl: 'https://maps.example.com',
        coordinates: { lat: 0, lng: 0 },
        operatingHours: {},
        menuUrl: 'https://menu.example.com',
        timezone: 'America/New_York',
      });
      repo._seedAvailability({
        locationId: `loc-${i}`,
        date,
        time: '18:00',
        maxPartySize: 10,
        remainingCapacity: 5,
      });
    }

    const res = await handleRequest('ga1', 'check_group_availability', {
      restaurantGroupId: 'group-1',
      date,
      partySize: 2,
    });
    expect(res.success).toBe(true);
    expect((res.data?.alternatives as unknown[]).length).toBeLessThanOrEqual(3);
  });

  it('excludes specified location', async () => {
    const date = futureDate();
    repo._seedLocation({
      locationId: 'loc-a',
      restaurantGroupId: 'group-2',
      name: 'Restaurant A',
      address: '1 A St',
      phone: '+15550000001',
      mapUrl: '',
      coordinates: { lat: 0, lng: 0 },
      operatingHours: {},
      menuUrl: '',
      timezone: 'UTC',
    });
    repo._seedAvailability({ locationId: 'loc-a', date, time: '18:00', maxPartySize: 10, remainingCapacity: 5 });

    const res = await handleRequest('ga2', 'check_group_availability', {
      restaurantGroupId: 'group-2',
      date,
      partySize: 2,
      excludeLocationId: 'loc-a',
    });
    expect(res.success).toBe(true);
    expect((res.data?.alternatives as unknown[]).length).toBe(0);
  });

  it('validates required fields', async () => {
    const res = await handleRequest('ga3', 'check_group_availability', { date: futureDate(), partySize: 2 });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('unknown tool', () => {
  it('returns NOT_FOUND for unregistered tool', async () => {
    const res = await handleRequest('u1', 'nonexistent_tool', {});
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });
});
