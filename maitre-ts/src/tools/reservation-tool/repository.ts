import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { Reservation, AvailabilitySlot, RestaurantLocation } from '../../types/models';

// ─── In-memory fallback (USE_LOCAL_DB=true) ───────────────────────────────────

const localReservations = new Map<string, Reservation>();
const localAvailability = new Map<string, AvailabilitySlot>();
const localLocations = new Map<string, RestaurantLocation>();

function isLocal(): boolean {
  return process.env.USE_LOCAL_DB === 'true';
}

// ─── ReservationRepository ────────────────────────────────────────────────────

export class ReservationRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly reservationsTable: string;
  private readonly availabilityTable: string;
  private readonly locationsTable: string;

  constructor() {
    const dynamo = new DynamoDBClient({});
    this.client = DynamoDBDocumentClient.from(dynamo);
    this.reservationsTable = process.env.RESERVATIONS_TABLE ?? 'Reservations';
    this.availabilityTable = process.env.AVAILABILITY_TABLE ?? 'AvailabilitySlots';
    this.locationsTable = process.env.LOCATIONS_TABLE ?? 'Locations';
  }

  async create(reservation: Reservation): Promise<void> {
    if (isLocal()) {
      localReservations.set(reservation.reservationId, { ...reservation });
      return;
    }
    await this.client.send(new PutCommand({
      TableName: this.reservationsTable,
      Item: reservation,
    }));
  }

  async getById(reservationId: string): Promise<Reservation | null> {
    if (isLocal()) {
      return localReservations.get(reservationId) ?? null;
    }
    const result = await this.client.send(new GetCommand({
      TableName: this.reservationsTable,
      Key: { reservationId },
    }));
    return (result.Item as Reservation) ?? null;
  }

  async getByGuestNameAndDate(
    guestName: string,
    date: string,
    locationId: string,
  ): Promise<Reservation | null> {
    if (isLocal()) {
      for (const r of localReservations.values()) {
        if (r.guestName === guestName && r.date === date && r.locationId === locationId) {
          return r;
        }
      }
      return null;
    }
    const result = await this.client.send(new QueryCommand({
      TableName: this.reservationsTable,
      IndexName: 'guestName-date-index',
      KeyConditionExpression: 'guestName = :gn AND #dt = :dt',
      FilterExpression: 'locationId = :lid',
      ExpressionAttributeNames: { '#dt': 'date' },
      ExpressionAttributeValues: { ':gn': guestName, ':dt': date, ':lid': locationId },
      Limit: 1,
    }));
    return (result.Items?.[0] as Reservation) ?? null;
  }

  async update(reservationId: string, updates: Partial<Reservation>): Promise<Reservation | null> {
    if (isLocal()) {
      const existing = localReservations.get(reservationId);
      if (!existing) return null;
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      localReservations.set(reservationId, updated);
      return updated;
    }

    const now = new Date().toISOString();
    const entries = Object.entries({ ...updates, updatedAt: now });
    const updateExpr = 'SET ' + entries.map((_, i) => `#k${i} = :v${i}`).join(', ');
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    entries.forEach(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
    });

    const result = await this.client.send(new UpdateCommand({
      TableName: this.reservationsTable,
      Key: { reservationId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return (result.Attributes as Reservation) ?? null;
  }

  async delete(reservationId: string): Promise<void> {
    if (isLocal()) {
      localReservations.delete(reservationId);
      return;
    }
    await this.client.send(new DeleteCommand({
      TableName: this.reservationsTable,
      Key: { reservationId },
    }));
  }

  async checkAvailability(
    locationId: string,
    date: string,
    partySize: number,
  ): Promise<AvailabilitySlot[]> {
    if (isLocal()) {
      const slots: AvailabilitySlot[] = [];
      for (const slot of localAvailability.values()) {
        if (
          slot.locationId === locationId &&
          slot.date === date &&
          slot.remainingCapacity >= partySize
        ) {
          slots.push(slot);
        }
      }
      return slots.sort((a, b) => a.time.localeCompare(b.time));
    }

    const result = await this.client.send(new QueryCommand({
      TableName: this.availabilityTable,
      KeyConditionExpression: 'locationId = :lid AND begins_with(#sk, :date)',
      FilterExpression: 'remainingCapacity >= :ps',
      ExpressionAttributeNames: { '#sk': 'date#time' },
      ExpressionAttributeValues: { ':lid': locationId, ':date': date, ':ps': partySize },
    }));
    return (result.Items as AvailabilitySlot[]) ?? [];
  }

  async checkGroupAvailability(
    restaurantGroupId: string,
    date: string,
    partySize: number,
    excludeLocationId?: string,
  ): Promise<{ location: RestaurantLocation; slots: AvailabilitySlot[] }[]> {
    if (isLocal()) {
      const results: { location: RestaurantLocation; slots: AvailabilitySlot[] }[] = [];
      for (const loc of localLocations.values()) {
        if (loc.restaurantGroupId !== restaurantGroupId) continue;
        if (excludeLocationId && loc.locationId === excludeLocationId) continue;
        const slots = await this.checkAvailability(loc.locationId, date, partySize);
        if (slots.length > 0) {
          results.push({ location: loc, slots });
        }
      }
      return results;
    }

    // Query Locations GSI by restaurantGroupId
    const locResult = await this.client.send(new QueryCommand({
      TableName: this.locationsTable,
      IndexName: 'restaurantGroupId-index',
      KeyConditionExpression: 'restaurantGroupId = :rgid',
      ExpressionAttributeValues: { ':rgid': restaurantGroupId },
    }));
    const locations = (locResult.Items as RestaurantLocation[]) ?? [];

    const results: { location: RestaurantLocation; slots: AvailabilitySlot[] }[] = [];
    for (const loc of locations) {
      if (excludeLocationId && loc.locationId === excludeLocationId) continue;
      const slots = await this.checkAvailability(loc.locationId, date, partySize);
      if (slots.length > 0) {
        results.push({ location: loc, slots });
      }
    }
    return results;
  }

  // ─── Local dev seed helpers ─────────────────────────────────────────────────

  _seedLocation(loc: RestaurantLocation): void {
    localLocations.set(loc.locationId, loc);
  }

  _seedAvailability(slot: AvailabilitySlot): void {
    const key = `${slot.locationId}#${slot.date}#${slot.time}`;
    localAvailability.set(key, slot);
  }

  _clearLocal(): void {
    localReservations.clear();
    localAvailability.clear();
    localLocations.clear();
  }

  _generateConfirmationNumber(): string {
    return 'RES-' + uuidv4().replace(/-/g, '').substring(0, 6).toUpperCase();
  }
}
