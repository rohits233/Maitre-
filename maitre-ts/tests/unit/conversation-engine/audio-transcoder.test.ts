import { describe, it, expect } from 'vitest';
import { AudioTranscoderImpl, audioTranscoder } from '../../../src/conversation-engine/audio-transcoder';

describe('AudioTranscoderImpl', () => {
  const transcoder = new AudioTranscoderImpl();

  describe('mulawToNovaSonic', () => {
    it('returns a Buffer', () => {
      const input = Buffer.from([0x00, 0xff, 0x7f]);
      const result = transcoder.mulawToNovaSonic(input);
      expect(result).toBeInstanceOf(Buffer);
    });

    it('output buffer is 4x the input length (upsample 2x, 2 bytes per sample)', () => {
      const input = Buffer.alloc(160); // typical 20ms chunk at 8kHz
      const result = transcoder.mulawToNovaSonic(input);
      expect(result.length).toBe(input.length * 4);
    });

    it('empty input produces empty output', () => {
      const result = transcoder.mulawToNovaSonic(Buffer.alloc(0));
      expect(result.length).toBe(0);
    });

    it('single byte input produces 4 bytes output', () => {
      const result = transcoder.mulawToNovaSonic(Buffer.from([0x7f]));
      expect(result.length).toBe(4);
    });
  });

  describe('novaSonicToMulaw', () => {
    it('returns a Buffer', () => {
      const input = Buffer.alloc(640); // 320 samples at 16kHz, 20ms
      const result = transcoder.novaSonicToMulaw(input);
      expect(result).toBeInstanceOf(Buffer);
    });

    it('output buffer is 1/4 the input length (downsample 2x, 2 bytes per sample)', () => {
      const input = Buffer.alloc(640); // 320 samples → 160 mulaw bytes
      const result = transcoder.novaSonicToMulaw(input);
      expect(result.length).toBe(input.length / 4);
    });

    it('empty input produces empty output', () => {
      const result = transcoder.novaSonicToMulaw(Buffer.alloc(0));
      expect(result.length).toBe(0);
    });
  });

  describe('round-trip: mulawToNovaSonic → novaSonicToMulaw', () => {
    it('output has the same length as the original mulaw input', () => {
      const input = Buffer.alloc(160, 0x7f); // 160 mulaw bytes
      const novaSonic = transcoder.mulawToNovaSonic(input);
      const roundTripped = transcoder.novaSonicToMulaw(novaSonic);
      expect(roundTripped.length).toBe(input.length);
    });

    it('round-trip with varied mulaw bytes preserves length', () => {
      const input = Buffer.from(Array.from({ length: 80 }, (_, i) => i % 256));
      const novaSonic = transcoder.mulawToNovaSonic(input);
      const roundTripped = transcoder.novaSonicToMulaw(novaSonic);
      expect(roundTripped.length).toBe(input.length);
    });
  });

  describe('singleton export', () => {
    it('audioTranscoder is an instance of AudioTranscoderImpl', () => {
      expect(audioTranscoder).toBeInstanceOf(AudioTranscoderImpl);
    });
  });
});
