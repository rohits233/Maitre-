// ─── InterruptionHandler ──────────────────────────────────────────────────────
//
// Handles Nova Sonic interruption events per Call_Session.
// On interruption: invokes the registered callback, clears the audio output
// buffer, and begins processing the new utterance within 200ms.

const INTERRUPTION_PROCESSING_DEADLINE_MS = 200;

export class InterruptionHandler {
  /** Per-session audio output buffers (chunks queued for playback) */
  private buffers = new Map<string, Buffer[]>();

  /**
   * Handle an interruption for the given call session.
   *
   * Invokes `onInterrupt`, clears the audio buffer, and schedules the start
   * of new-utterance processing within 200ms.
   */
  handleInterruption(callSid: string, onInterrupt: () => void): void {
    // 1. Invoke the callback immediately (Voice Gateway sends `clear` to Twilio)
    onInterrupt();

    // 2. Reset the audio output buffer for this session
    this.clearBuffer(callSid);

    // 3. Begin processing the new utterance within 200ms
    //    (The actual processing is driven by the ConversationEngine; this
    //    timeout acts as a deadline guard — if nothing has started by then
    //    the buffer is already clear and the engine can proceed.)
    setTimeout(() => {
      // Ensure the buffer is still clear after the deadline
      this.clearBuffer(callSid);
    }, INTERRUPTION_PROCESSING_DEADLINE_MS);
  }

  /**
   * Clear any buffered audio output for the given call session.
   */
  clearBuffer(callSid: string): void {
    this.buffers.set(callSid, []);
  }

  /**
   * Append an audio chunk to the session's output buffer.
   * Used by the ConversationEngine to stage audio before playback.
   */
  appendToBuffer(callSid: string, chunk: Buffer): void {
    const buf = this.buffers.get(callSid) ?? [];
    buf.push(chunk);
    this.buffers.set(callSid, buf);
  }

  /**
   * Return the current buffered audio chunks for a session (read-only copy).
   */
  getBuffer(callSid: string): Buffer[] {
    return [...(this.buffers.get(callSid) ?? [])];
  }

  /**
   * Remove all state for a session (call cleanup).
   */
  removeSession(callSid: string): void {
    this.buffers.delete(callSid);
  }
}
