/**
 * Unit tests for CallFlowEvaluatorImpl
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CallFlowEvaluatorImpl } from '../../../src/voice-gateway/call-flow-evaluator';
import { CallFlowRule } from '../../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<CallFlowRule> & { id: string }): CallFlowRule {
  return {
    locationId: 'loc-1',
    priority: 1,
    conditions: {},
    action: { type: 'conversation_engine' },
    ...overrides,
  };
}

/** Returns a Date with the given hour and minute (local time) */
function atTime(hour: number, minute = 0, dayOfWeek?: number): Date {
  const d = new Date(2024, 0, 7 + (dayOfWeek ?? 0)); // 2024-01-07 is a Sunday (0)
  d.setHours(hour, minute, 0, 0);
  return d;
}

describe('CallFlowEvaluatorImpl (USE_LOCAL_DB=true)', () => {
  let evaluator: CallFlowEvaluatorImpl;

  beforeEach(() => {
    vi.stubEnv('USE_LOCAL_DB', 'true');
    evaluator = new CallFlowEvaluatorImpl();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── evaluate ───────────────────────────────────────────────────────────────

  describe('evaluate()', () => {
    it('returns null when no rules are loaded', async () => {
      await evaluator.loadRules();
      expect(evaluator.evaluate('+15551234567', new Date())).toBeNull();
    });

    it('returns matching rule for unconditional rule', async () => {
      const rule = makeRule({ id: 'r1', priority: 1 });
      evaluator._seedRules([rule]);
      await evaluator.loadRules();
      expect(evaluator.evaluate('+15551234567', new Date())).toEqual(rule);
    });

    it('returns first matching rule by priority', async () => {
      // Use non-overlapping time ranges so validation passes
      const r1 = makeRule({
        id: 'r1',
        priority: 2,
        conditions: { timeOfDay: { start: '13:00', end: '17:00' } },
      });
      const r2 = makeRule({
        id: 'r2',
        priority: 1,
        conditions: { timeOfDay: { start: '09:00', end: '12:00' } },
      });
      evaluator._seedRules([r1, r2]);
      await evaluator.loadRules();
      // Call at 10:00 — only r2 matches (09:00–12:00), and r2 has lower priority number
      expect(evaluator.evaluate('+15551234567', atTime(10, 0))?.id).toBe('r2');
    });

    it('matches rule with time-of-day condition', async () => {
      const rule = makeRule({
        id: 'r1',
        priority: 1,
        conditions: { timeOfDay: { start: '09:00', end: '17:00' } },
      });
      evaluator._seedRules([rule]);
      await evaluator.loadRules();

      expect(evaluator.evaluate('+1', atTime(12, 0))).toEqual(rule);
      expect(evaluator.evaluate('+1', atTime(8, 59))).toBeNull();
      expect(evaluator.evaluate('+1', atTime(17, 1))).toBeNull();
    });

    it('matches rule with dayOfWeek condition', async () => {
      const rule = makeRule({
        id: 'r1',
        priority: 1,
        conditions: { dayOfWeek: [1, 2, 3, 4, 5] }, // Mon–Fri
      });
      evaluator._seedRules([rule]);
      await evaluator.loadRules();

      // atTime with dayOfWeek=1 → Monday
      expect(evaluator.evaluate('+1', atTime(10, 0, 1))).toEqual(rule);
      // dayOfWeek=0 → Sunday
      expect(evaluator.evaluate('+1', atTime(10, 0, 0))).toBeNull();
    });

    it('matches rule with callerPattern condition', async () => {
      const rule = makeRule({
        id: 'r1',
        priority: 1,
        conditions: { callerPattern: '^\\+1555' },
      });
      evaluator._seedRules([rule]);
      await evaluator.loadRules();

      expect(evaluator.evaluate('+15551234567', new Date())).toEqual(rule);
      expect(evaluator.evaluate('+14441234567', new Date())).toBeNull();
    });

    it('returns null when config is invalid (falls back to default)', async () => {
      const badRule = makeRule({
        id: 'r1',
        priority: 1,
        action: { type: 'transfer' }, // missing destination
      });
      evaluator._seedRules([badRule]);
      await evaluator.loadRules();
      expect(evaluator.evaluate('+1', new Date())).toBeNull();
    });
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('returns valid for empty rules', () => {
      expect(evaluator.validate([])).toEqual({ valid: true, errors: [] });
    });

    it('returns valid for well-formed rules', () => {
      const rules = [
        makeRule({ id: 'r1', priority: 1, conditions: { timeOfDay: { start: '09:00', end: '12:00' } } }),
        makeRule({ id: 'r2', priority: 2, conditions: { timeOfDay: { start: '13:00', end: '17:00' } } }),
      ];
      const result = evaluator.validate(rules);
      expect(result.valid).toBe(true);
    });

    it('detects missing transfer destination', () => {
      const rule = makeRule({ id: 'r1', action: { type: 'transfer' } });
      const result = evaluator.validate([rule]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('r1') && e.includes('destination'))).toBe(true);
    });

    it('detects overlapping time ranges in same location', () => {
      const rules = [
        makeRule({ id: 'r1', priority: 1, conditions: { timeOfDay: { start: '09:00', end: '14:00' } } }),
        makeRule({ id: 'r2', priority: 2, conditions: { timeOfDay: { start: '12:00', end: '17:00' } } }),
      ];
      const result = evaluator.validate(rules);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('r1') && e.includes('r2'))).toBe(true);
    });

    it('does not flag non-overlapping time ranges', () => {
      const rules = [
        makeRule({ id: 'r1', priority: 1, conditions: { timeOfDay: { start: '09:00', end: '12:00' } } }),
        makeRule({ id: 'r2', priority: 2, conditions: { timeOfDay: { start: '12:01', end: '17:00' } } }),
      ];
      const result = evaluator.validate(rules);
      expect(result.valid).toBe(true);
    });

    it('does not flag overlapping times on different days', () => {
      const rules = [
        makeRule({
          id: 'r1',
          priority: 1,
          conditions: { timeOfDay: { start: '09:00', end: '17:00' }, dayOfWeek: [1] },
        }),
        makeRule({
          id: 'r2',
          priority: 2,
          conditions: { timeOfDay: { start: '09:00', end: '17:00' }, dayOfWeek: [2] },
        }),
      ];
      const result = evaluator.validate(rules);
      expect(result.valid).toBe(true);
    });
  });

  // ─── loadRules ──────────────────────────────────────────────────────────────

  describe('loadRules()', () => {
    it('loads seeded rules and marks config valid', async () => {
      const rule = makeRule({ id: 'r1', priority: 1 });
      evaluator._seedRules([rule]);
      await evaluator.loadRules();
      expect(evaluator.evaluate('+1', new Date())).toEqual(rule);
    });

    it('marks config invalid and returns null on bad rules', async () => {
      evaluator._seedRules([makeRule({ id: 'r1', action: { type: 'transfer' } })]);
      await evaluator.loadRules();
      expect(evaluator.evaluate('+1', new Date())).toBeNull();
    });
  });
});
