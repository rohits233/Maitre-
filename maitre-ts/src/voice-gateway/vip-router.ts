/**
 * VIP Router
 *
 * Looks up a caller phone number (E.164) in the VIP list.
 * Loads from DynamoDB `VIPList` table on first call (lazy load), caches in-process.
 * Falls back to in-memory store when USE_LOCAL_DB=true.
 *
 * Requirements: 15.1, 15.2, 15.4, 15.5
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { VIPRouter, VIPEntry } from '../types/index';

export class VIPRouterImpl implements VIPRouter {
  private tableName: string;
  private ddb?: DynamoDBDocumentClient;
  private useLocalDb: boolean;

  /** In-process cache: phone → VIPEntry */
  private cache = new Map<string, VIPEntry>();
  private loaded = false;

  /** In-memory store for local dev / testing */
  private localStore = new Map<string, VIPEntry>();

  constructor(tableName?: string) {
    this.tableName = tableName ?? process.env['VIP_LIST_TABLE'] ?? 'VIPList';
    this.useLocalDb = process.env['USE_LOCAL_DB'] === 'true';

    if (!this.useLocalDb) {
      const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
      this.ddb = DynamoDBDocumentClient.from(client);
    }
  }

  async isVIP(callerPhone: string): Promise<VIPEntry | null> {
    if (!this.loaded) {
      await this.refreshList();
    }

    if (this.useLocalDb) {
      return this.localStore.get(callerPhone) ?? null;
    }

    return this.cache.get(callerPhone) ?? null;
  }

  async refreshList(): Promise<void> {
    if (this.useLocalDb) {
      // In local mode the store is managed via _seed/_clear; nothing to reload
      this.loaded = true;
      return;
    }

    const items = await this.scanAll();
    this.cache.clear();
    for (const item of items) {
      const entry = item as unknown as VIPEntry;
      if (entry.phoneNumber) {
        this.cache.set(entry.phoneNumber, entry);
      }
    }
    this.loaded = true;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async scanAll(): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const resp = await this.ddb!.send(
        new ScanCommand({
          TableName: this.tableName,
          ExclusiveStartKey: lastKey,
        })
      );
      if (resp.Items) {
        results.push(...(resp.Items as Record<string, unknown>[]));
      }
      lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return results;
  }

  // ─── Test helpers (USE_LOCAL_DB=true) ────────────────────────────────────────

  _seed(entry: VIPEntry): void {
    this.localStore.set(entry.phoneNumber, entry);
    this.loaded = true;
  }

  _clear(): void {
    this.localStore.clear();
    this.cache.clear();
    this.loaded = false;
  }
}
