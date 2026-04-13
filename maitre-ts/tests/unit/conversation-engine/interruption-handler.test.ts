import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InterruptionHandler } from '../../../src/conversation-engine/interruption-handler';

describe('InterruptionHandler', () => {
  let handler: InterruptionHandler;

  beforeEach(() => {
    handler = new InterruptionHandler();
  });

  describe('handleInterruption', () => {
    it('invokes the onInterrupt callback immediately', () => {
      const onInterrupt = vi.fn();
      handler.handleInterruption('CA1', onInterrupt);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
    });

    it('clears the audio buffer for the session', () => {
      handler.appendToBuffer('CA1', Buffer.from([0x01]));
      handler.appendToBuffer('CA1', Buffer.from([0x02]));

      handler.handleInterruption('CA1', vi.fn());

      expect(handler.getBuffer('CA1')).toHaveLength(0);
    });

    it('does not affect buffers of other sessions', () => {
      handler.appendToBuffer('CA1', Buffer.from([0x01]));
      handler.appendToBuffer('CA2', Buffer.from([0x02]));

      handler.handleInterruption('CA1', vi.fn());

      expect(handler.getBuffer('CA2')).toHaveLength(1);
    });

    it('clears the buffer again after 200ms deadline', async () => {
      vi.useFakeTimers();

      handler.appendToBuffer('CA1', Buffer.from([0x01]));
      handler.handleInterruption('CA1', vi.fn());

      // Append something after the interruption (simulating late audio)
      handler.appendToBuffer('CA1', Buffer.from([0x03]));
      expect(handler.getBuffer('CA1')).toHaveLength(1);

      // Advance past the 200ms deadline
      await vi.advanceTimersByTimeAsync(201);

      expect(handler.getBuffer('CA1')).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  describe('clearBuffer', () => {
    it('empties the buffer for the session', () => {
      handler.appendToBuffer('CA1', Buffer.from([0xaa]));
      handler.clearBuffer('CA1');
      expect(handler.getBuffer('CA1')).toHaveLength(0);
    });

    it('is safe to call on a session with no buffer', () => {
      expect(() => handler.clearBuffer('unknown')).not.toThrow();
      expect(handler.getBuffer('unknown')).toHaveLength(0);
    });
  });

  describe('appendToBuffer / getBuffer', () => {
    it('accumulates chunks in order', () => {
      const a = Buffer.from([0x01]);
      const b = Buffer.from([0x02]);
      handler.appendToBuffer('CA1', a);
      handler.appendToBuffer('CA1', b);

      const buf = handler.getBuffer('CA1');
      expect(buf).toHaveLength(2);
      expect(buf[0]).toEqual(a);
      expect(buf[1]).toEqual(b);
    });

    it('returns an empty array for unknown session', () => {
      expect(handler.getBuffer('unknown')).toEqual([]);
    });

    it('getBuffer returns a copy (mutations do not affect internal state)', () => {
      handler.appendToBuffer('CA1', Buffer.from([0x01]));
      const copy = handler.getBuffer('CA1');
      copy.push(Buffer.from([0x99]));
      expect(handler.getBuffer('CA1')).toHaveLength(1);
    });
  });

  describe('removeSession', () => {
    it('removes all state for the session', () => {
      handler.appendToBuffer('CA1', Buffer.from([0x01]));
      handler.removeSession('CA1');
      expect(handler.getBuffer('CA1')).toEqual([]);
    });

    it('is safe to call on an unknown session', () => {
      expect(() => handler.removeSession('unknown')).not.toThrow();
    });
  });
});
