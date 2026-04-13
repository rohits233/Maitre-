import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { RestaurantLocation } from '../../types/models';

// ─── In-memory fallback (USE_LOCAL_DB=true) ───────────────────────────────────

const localLocations = new Map<string, RestaurantLocation>();

function isLocal(): boolean {
  return process.env.USE_LOCAL_DB === 'true';
}

// ─── LocationRepository ───────────────────────────────────────────────────────

export class LocationRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly locationsTable: string;

  constructor() {
    const dynamo = new DynamoDBClient({});
    this.client = DynamoDBDocumentClient.from(dynamo);
    this.locationsTable = process.env.LOCATIONS_TABLE ?? 'Locations';
  }

  async getById(locationId: string): Promise<RestaurantLocation | null> {
    if (isLocal()) {
      return localLocations.get(locationId) ?? null;
    }
    const result = await this.client.send(new GetCommand({
      TableName: this.locationsTable,
      Key: { locationId },
    }));
    return (result.Item as RestaurantLocation) ?? null;
  }

  async getByGroupId(restaurantGroupId: string): Promise<RestaurantLocation[]> {
    if (isLocal()) {
      const results: RestaurantLocation[] = [];
      for (const loc of localLocations.values()) {
        if (loc.restaurantGroupId === restaurantGroupId) {
          results.push(loc);
        }
      }
      return results;
    }
    const result = await this.client.send(new QueryCommand({
      TableName: this.locationsTable,
      IndexName: 'restaurantGroupId-index',
      KeyConditionExpression: 'restaurantGroupId = :rgid',
      ExpressionAttributeValues: { ':rgid': restaurantGroupId },
    }));
    return (result.Items as RestaurantLocation[]) ?? [];
  }

  // ─── Local dev seed helpers ─────────────────────────────────────────────────

  _seed(loc: RestaurantLocation): void {
    localLocations.set(loc.locationId, loc);
  }

  _clear(): void {
    localLocations.clear();
  }
}
