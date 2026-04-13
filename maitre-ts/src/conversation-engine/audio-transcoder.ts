import { AudioTranscoder } from '../types/index';

// Standard mulaw decode table: maps each mulaw byte (0-255) to a 16-bit PCM value
const MULAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    // Invert all bits
    let byte = ~i & 0xff;
    const sign = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0f;
    let sample = ((mantissa << 1) + 33) << exponent;
    sample -= 33;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

/**
 * Encode a 16-bit PCM sample to a mulaw byte using the standard algorithm.
 */
function encodeMulaw(sample: number): number {
  const MULAW_BIAS = 33;
  const MULAW_MAX = 32767;

  // Clamp
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  if (sample < -MULAW_MAX) sample = -MULAW_MAX;

  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;

  sample += MULAW_BIAS;

  // Find exponent
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // empty
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

export class AudioTranscoderImpl implements AudioTranscoder {
  /**
   * Convert mulaw 8kHz audio to PCM 16-bit little-endian 16kHz.
   * Each mulaw byte → 16-bit PCM sample, then upsample 8kHz→16kHz by duplicating each sample.
   */
  mulawToNovaSonic(mulawBuffer: Buffer): Buffer {
    const inputSamples = mulawBuffer.length;
    // Each input sample becomes 2 output samples (upsample 2x), each 2 bytes = 4 bytes per input byte
    const output = Buffer.allocUnsafe(inputSamples * 4);
    let outOffset = 0;
    for (let i = 0; i < inputSamples; i++) {
      const pcm = MULAW_DECODE_TABLE[mulawBuffer[i]!]!;
      // Write sample twice (duplicate for 8kHz → 16kHz upsampling)
      output.writeInt16LE(pcm, outOffset);
      output.writeInt16LE(pcm, outOffset + 2);
      outOffset += 4;
    }
    return output;
  }

  /**
   * Convert PCM 16-bit little-endian 16kHz back to mulaw 8kHz.
   * Downsample 16kHz→8kHz by taking every other sample, then encode to mulaw.
   */
  novaSonicToMulaw(novaSonicBuffer: Buffer): Buffer {
    // Each sample is 2 bytes; take every other sample → half the samples
    const inputSamples = Math.floor(novaSonicBuffer.length / 2);
    const outputSamples = Math.floor(inputSamples / 2);
    const output = Buffer.allocUnsafe(outputSamples);
    for (let i = 0; i < outputSamples; i++) {
      // Take every other sample (indices 0, 2, 4, ... in sample space)
      const pcm = novaSonicBuffer.readInt16LE(i * 4);
      output[i] = encodeMulaw(pcm);
    }
    return output;
  }
}

export const audioTranscoder = new AudioTranscoderImpl();
