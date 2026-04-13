/**
 * Call Flow Evaluator
 *
 * Loads call flow rules from DynamoDB `CallFlowRules` table (or in-memory when
 * USE_LOCAL_DB=true), validates them at startup, and evaluates them in priority
 * order to return the first matching rule for a given caller + call time.
 *
 * On invalid config: logs the validation error and falls back to returning null
 * from evaluate() (meaning route to Conversation Engine).
 *
 * Requirements: 18.3, 18.4, 18.5, 18.6
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CallFlowEvaluator, CallFlowRule, ValidationResult } from '../types/index';

export class CallFlowEvaluatorImpl implements CallFlowEvaluator {
  private tableName: string;
  private ddb?: DynamoDBDocumentClient;
  private useLocalDb: boolean;

  private rules: CallFlowRule[] = [];
  private configValid = true;

  /** In-memory store for local dev / testing */
  private localRules: CallFlowRule[] = [];

  constructor(tableName?: string) {
    this.tableName = tableName ?? process.env['CALL_FLOW_RULES_TABLE'] ?? 'CallFlowRules';
    this.useLocalDb = process.env['USE_LOCAL_DB'] === 'true';

    if (!this.useLocalDb) {
      const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
      this.ddb = DynamoDBDocumentClient.from(client);
    }
  }

  evaluate(callerPhone: string, callTime: Date): CallFlowRule | null {
    if (!this.configValid) {
      return null;
    }

    const sorted = [...this.rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sorted) {
      if (this.matchesRule(rule, callerPhone, callTime)) {
        return rule;
      }
    }

    return null;
  }

  validate(rules: CallFlowRule[]): ValidationResult {
    const errors: string[] = [];

    // Check for missing transfer destinations
    for (const rule of rules) {
      if (rule.action.type === 'transfer' && !rule.action.destination) {
        errors.push(`Rule ${rule.id}: transfer action is missing a destination`);
      }
    }

    // Check for overlapping time ranges within the same locationId + dayOfWeek combination
    const byLocation = new Map<string, CallFlowRule[]>();
    for (const rule of rules) {
      const key = rule.locationId;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push(rule);
    }

    for (const [, locationRules] of byLocation) {
      for (let i = 0; i < locationRules.length; i++) {
        for (let j = i + 1; j < locationRules.length; j++) {
          const a = locationRules[i];
          const b = locationRules[j];
          if (this.rulesOverlap(a, b)) {
            errors.push(
              `Rules ${a.id} and ${b.id} have overlapping time ranges`
            );
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async loadRules(): Promise<void> {
    const rawRules = this.useLocalDb ? [...this.localRules] : await this.fetchFromDynamo();

    const result = this.validate(rawRules);
    if (!result.valid) {
      console.error('[call-flow-evaluator] Invalid call flow configuration:', result.errors);
      this.configValid = false;
      this.rules = [];
      return;
    }

    this.configValid = true;
    this.rules = rawRules;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async fetchFromDynamo(): Promise<CallFlowRule[]> {
    const results: CallFlowRule[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const resp = await this.ddb!.send(
        new ScanCommand({
          TableName: this.tableName,
          ExclusiveStartKey: lastKey,
        })
      );
      if (resp.Items) {
        results.push(...(resp.Items as CallFlowRule[]));
      }
      lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return results;
  }

  private matchesRule(rule: CallFlowRule, callerPhone: string, callTime: Date): boolean {
    const { conditions } = rule;

    // Day of week check
    if (conditions.dayOfWeek && conditions.dayOfWeek.length > 0) {
      const dow = callTime.getDay(); // 0=Sun, 6=Sat
      if (!conditions.dayOfWeek.includes(dow)) {
        return false;
      }
    }

    // Time of day check (HH:mm)
    if (conditions.timeOfDay) {
      const hhmm = this.toHHMM(callTime);
      if (!this.inTimeRange(hhmm, conditions.timeOfDay.start, conditions.timeOfDay.end)) {
        return false;
      }
    }

    // Caller pattern check
    if (conditions.callerPattern) {
      const re = new RegExp(conditions.callerPattern);
      if (!re.test(callerPhone)) {
        return false;
      }
    }

    return true;
  }

  private toHHMM(date: Date): string {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private inTimeRange(current: string, start: string, end: string): boolean {
    // Handles overnight ranges (e.g. 22:00 – 06:00)
    if (start <= end) {
      return current >= start && current <= end;
    }
    // Overnight
    return current >= start || current <= end;
  }

  private rulesOverlap(a: CallFlowRule, b: CallFlowRule): boolean {
    const aTime = a.conditions.timeOfDay;
    const bTime = b.conditions.timeOfDay;

    // If either rule has no time condition it matches all times — always overlaps
    if (!aTime || !bTime) {
      // Only flag as overlap if they share at least one day (or both have no day restriction)
      return this.daysOverlap(a.conditions.dayOfWeek, b.conditions.dayOfWeek);
    }

    if (!this.daysOverlap(a.conditions.dayOfWeek, b.conditions.dayOfWeek)) {
      return false;
    }

    return this.timeRangesOverlap(aTime.start, aTime.end, bTime.start, bTime.end);
  }

  private daysOverlap(a?: number[], b?: number[]): boolean {
    if (!a || a.length === 0 || !b || b.length === 0) return true;
    return a.some((d) => b.includes(d));
  }

  private timeRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
    // Convert to minutes for easier comparison
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };

    const aS = toMin(aStart);
    const aE = toMin(aEnd);
    const bS = toMin(bStart);
    const bE = toMin(bEnd);

    // Expand overnight ranges to [start, end+1440]
    const aEnd2 = aE < aS ? aE + 1440 : aE;
    const bEnd2 = bE < bS ? bE + 1440 : bE;

    // Check overlap in both normal and shifted positions
    const overlaps = (s1: number, e1: number, s2: number, e2: number) =>
      s1 < e2 && s2 < e1;

    return (
      overlaps(aS, aEnd2, bS, bEnd2) ||
      overlaps(aS, aEnd2, bS + 1440, bEnd2 + 1440) ||
      overlaps(aS + 1440, aEnd2 + 1440, bS, bEnd2)
    );
  }

  // ─── Test helpers (USE_LOCAL_DB=true) ────────────────────────────────────────

  _seedRules(rules: CallFlowRule[]): void {
    this.localRules = [...rules];
  }
}
