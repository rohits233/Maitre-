/**
 * Voice Persona Loader
 *
 * Loads a VoicePersona from DynamoDB `VoicePersonas` table (or in-memory when
 * USE_LOCAL_DB=true). Falls back to a hardcoded default persona if none is
 * configured for the given locationId.
 *
 * Requirements: 18.1, 18.2, 18.5
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { VoicePersona } from '../types/index';

const DEFAULT_PERSONA: VoicePersona = {
  locationId: 'default',
  name: 'Maître',
  greeting: "Hello, thank you for calling. How may I assist you today?",
  toneDescriptors: ['warm', 'professional', 'concise'],
  systemPrompt:
    'You are a helpful restaurant assistant. You can help guests make, modify, or cancel reservations, ' +
    'and answer questions about hours, menu, and location. Be warm, professional, and concise.',
};

export class VoicePersonaLoader {
  private tableName: string;
  private ddb?: DynamoDBDocumentClient;
  private useLocalDb: boolean;
  private loadedPersona?: VoicePersona;

  /** In-memory store for local dev / testing */
  private localStore = new Map<string, VoicePersona>();

  constructor(tableName?: string) {
    this.tableName = tableName ?? process.env['VOICE_PERSONAS_TABLE'] ?? 'VoicePersonas';
    this.useLocalDb = process.env['USE_LOCAL_DB'] === 'true';

    if (!this.useLocalDb) {
      const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
      this.ddb = DynamoDBDocumentClient.from(client);
    }
  }

  async load(locationId: string): Promise<VoicePersona> {
    if (this.useLocalDb) {
      return this.localStore.get(locationId) ?? this.getDefault();
    }

    try {
      const resp = await this.ddb!.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { locationId },
        })
      );

      if (resp.Item) {
        this.loadedPersona = resp.Item as VoicePersona;
        return this.loadedPersona;
      }
    } catch (err) {
      console.error(
        `[voice-persona] Failed to load persona for locationId=${locationId}:`,
        err
      );
    }

    return this.getDefault();
  }

  getDefault(): VoicePersona {
    return this.loadedPersona ? { ...this.loadedPersona } : { ...DEFAULT_PERSONA };
  }

  // ─── Test helpers (USE_LOCAL_DB=true) ────────────────────────────────────────

  _seed(persona: VoicePersona): void {
    this.localStore.set(persona.locationId, persona);
  }

  _clear(): void {
    this.localStore.clear();
  }
}
