/**
 * Unit tests for VoicePersonaLoader
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoicePersonaLoader } from '../../../src/voice-gateway/voice-persona';
import { VoicePersona } from '../../../src/types/index';

const CUSTOM_PERSONA: VoicePersona = {
  locationId: 'loc-1',
  name: 'Bella',
  greeting: 'Welcome to Bella Vista, how can I help you?',
  toneDescriptors: ['elegant', 'warm'],
  systemPrompt: 'You are Bella, the assistant for Bella Vista restaurant.',
};

describe('VoicePersonaLoader (USE_LOCAL_DB=true)', () => {
  let loader: VoicePersonaLoader;

  beforeEach(() => {
    vi.stubEnv('USE_LOCAL_DB', 'true');
    loader = new VoicePersonaLoader();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    loader._clear();
  });

  it('returns default persona when no persona is seeded', async () => {
    const persona = await loader.load('loc-unknown');
    const def = loader.getDefault();
    expect(persona).toEqual(def);
  });

  it('returns seeded persona for matching locationId', async () => {
    loader._seed(CUSTOM_PERSONA);
    const persona = await loader.load('loc-1');
    expect(persona).toEqual(CUSTOM_PERSONA);
  });

  it('returns default persona for a different locationId', async () => {
    loader._seed(CUSTOM_PERSONA);
    const persona = await loader.load('loc-2');
    expect(persona).toEqual(loader.getDefault());
  });

  it('returns default persona after _clear()', async () => {
    loader._seed(CUSTOM_PERSONA);
    loader._clear();
    const persona = await loader.load('loc-1');
    expect(persona).toEqual(loader.getDefault());
  });

  it('getDefault() returns a persona with required fields', () => {
    const def = loader.getDefault();
    expect(def.name).toBeTruthy();
    expect(def.greeting).toBeTruthy();
    expect(def.systemPrompt).toBeTruthy();
    expect(Array.isArray(def.toneDescriptors)).toBe(true);
    expect(def.toneDescriptors.length).toBeGreaterThan(0);
  });

  it('getDefault() returns a new copy each time (immutable)', () => {
    const a = loader.getDefault();
    const b = loader.getDefault();
    expect(a).toEqual(b);
    a.name = 'Modified';
    expect(loader.getDefault().name).not.toBe('Modified');
  });

  it('supports multiple personas for different locations', async () => {
    const persona2: VoicePersona = {
      locationId: 'loc-2',
      name: 'Marco',
      greeting: 'Ciao!',
      toneDescriptors: ['friendly'],
      systemPrompt: 'You are Marco.',
    };
    loader._seed(CUSTOM_PERSONA);
    loader._seed(persona2);

    expect(await loader.load('loc-1')).toEqual(CUSTOM_PERSONA);
    expect(await loader.load('loc-2')).toEqual(persona2);
  });
});
