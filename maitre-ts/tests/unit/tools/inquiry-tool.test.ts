import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest, locationRepo } from '../../../src/tools/inquiry-tool/server';
import { RestaurantLocation } from '../../../src/types/models';

// Use in-memory local DB for all tests
process.env.USE_LOCAL_DB = 'true';

const sampleLocation: RestaurantLocation = {
  locationId: 'loc-test',
  restaurantGroupId: 'group-test',
  name: 'The Test Bistro',
  address: '123 Test Ave, Testville',
  phone: '+15550001234',
  mapUrl: 'https://maps.example.com/test',
  coordinates: { lat: 40.7128, lng: -74.006 },
  operatingHours: {
    monday: { open: '11:00', close: '22:00' },
    tuesday: { open: '11:00', close: '22:00' },
    wednesday: { open: '11:00', close: '22:00' },
    thursday: { open: '11:00', close: '22:00' },
    friday: { open: '11:00', close: '23:00' },
    saturday: { open: '10:00', close: '23:00' },
    sunday: { open: '10:00', close: '21:00' },
  },
  menuUrl: 'https://menu.example.com/test',
  timezone: 'America/New_York',
};

beforeEach(() => {
  locationRepo._clear();
  locationRepo._seed(sampleLocation);
});

describe('get_hours', () => {
  it('returns operating hours for a valid location', async () => {
    const res = await handleRequest('h1', 'get_hours', { locationId: 'loc-test' });
    expect(res.success).toBe(true);
    expect(res.data?.locationId).toBe('loc-test');
    expect(res.data?.name).toBe('The Test Bistro');
    expect(res.data?.operatingHours).toBeDefined();
  });

  it('returns hours for a specific date', async () => {
    // Find a Monday
    const d = new Date('2025-07-07'); // Monday
    const dateStr = d.toISOString().slice(0, 10);
    const res = await handleRequest('h2', 'get_hours', { locationId: 'loc-test', date: dateStr });
    expect(res.success).toBe(true);
    expect(res.data?.operatingHours).toBeDefined();
  });

  it('returns NOT_FOUND for unknown location', async () => {
    const res = await handleRequest('h3', 'get_hours', { locationId: 'unknown' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('returns VALIDATION_ERROR when locationId is missing', async () => {
    const res = await handleRequest('h4', 'get_hours', {});
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('VALIDATION_ERROR');
    expect(res.error?.message).toContain('locationId');
  });
});

describe('get_menu', () => {
  it('returns menu URL for a valid location', async () => {
    const res = await handleRequest('m1', 'get_menu', { locationId: 'loc-test' });
    expect(res.success).toBe(true);
    expect(res.data?.menuUrl).toBe('https://menu.example.com/test');
    expect(res.data?.locationId).toBe('loc-test');
  });

  it('includes category and dietaryFilter when provided', async () => {
    const res = await handleRequest('m2', 'get_menu', {
      locationId: 'loc-test',
      category: 'appetizers',
      dietaryFilter: 'vegetarian',
    });
    expect(res.success).toBe(true);
    expect(res.data?.category).toBe('appetizers');
    expect(res.data?.dietaryFilter).toBe('vegetarian');
  });

  it('returns NOT_FOUND for unknown location', async () => {
    const res = await handleRequest('m3', 'get_menu', { locationId: 'unknown' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('returns VALIDATION_ERROR when locationId is missing', async () => {
    const res = await handleRequest('m4', 'get_menu', {});
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('get_location', () => {
  it('returns location info for a valid location', async () => {
    const res = await handleRequest('l1', 'get_location', { locationId: 'loc-test' });
    expect(res.success).toBe(true);
    expect(res.data?.name).toBe('The Test Bistro');
    expect(res.data?.address).toBe('123 Test Ave, Testville');
    expect(res.data?.phone).toBe('+15550001234');
    expect(res.data?.mapUrl).toBe('https://maps.example.com/test');
    expect(res.data?.coordinates).toBeDefined();
  });

  it('returns NOT_FOUND for unknown location', async () => {
    const res = await handleRequest('l2', 'get_location', { locationId: 'unknown' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('returns VALIDATION_ERROR when locationId is missing', async () => {
    const res = await handleRequest('l3', 'get_location', {});
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
