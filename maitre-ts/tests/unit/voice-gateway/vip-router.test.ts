/**
 * Unit tests for VIPRouterImpl
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VIPRouterImpl } from '../../../src/voice-gateway/vip-router';
import { VIPEntry } from '../../../src/types/index';

const VIP_ENTRY: VIPEntry = {
  phoneNumber: '+15551234567',
  guestName: 'Alice Smith',
  conciergeLine: '+15559876543',
  locationId: 'loc-1',
};

describe('VIPRouterImpl (USE_LOCAL_DB=true)', () => {
  let router: VIPRouterImpl;

  beforeEach(() => {
    vi.stubEnv('USE_LOCAL_DB', 'true');
    router = new VIPRouterImpl();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    router._clear();
  });

  it('returns null for unknown caller', async () => {
    const result = await router.isVIP('+10000000000');
    expect(result).toBeNull();
  });

  it('returns VIPEntry for a seeded VIP caller', async () => {
    router._seed(VIP_ENTRY);
    const result = await router.isVIP('+15551234567');
    expect(result).toEqual(VIP_ENTRY);
  });

  it('returns null after _clear()', async () => {
    router._seed(VIP_ENTRY);
    router._clear();
    const result = await router.isVIP('+15551234567');
    expect(result).toBeNull();
  });

  it('refreshList() does not throw in local mode', async () => {
    await expect(router.refreshList()).resolves.toBeUndefined();
  });

  it('supports multiple VIP entries', async () => {
    const entry2: VIPEntry = {
      phoneNumber: '+15550000001',
      guestName: 'Bob Jones',
      conciergeLine: '+15559999999',
    };
    router._seed(VIP_ENTRY);
    router._seed(entry2);

    expect(await router.isVIP('+15551234567')).toEqual(VIP_ENTRY);
    expect(await router.isVIP('+15550000001')).toEqual(entry2);
    expect(await router.isVIP('+10000000000')).toBeNull();
  });

  it('isVIP triggers lazy load on first call (not already loaded)', async () => {
    // Create a fresh router without seeding (loaded=false)
    const freshRouter = new VIPRouterImpl();
    const refreshSpy = vi.spyOn(freshRouter, 'refreshList');
    await freshRouter.isVIP('+15551234567');
    expect(refreshSpy).toHaveBeenCalledOnce();
    // Second call should NOT trigger another refresh
    await freshRouter.isVIP('+15551234567');
    expect(refreshSpy).toHaveBeenCalledOnce();
    freshRouter._clear();
  });
});
