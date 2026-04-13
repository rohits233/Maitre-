/**
 * Analytics API Lambda
 *
 * Handles GET /api/analytics with query params: startDate, endDate, locationId (optional).
 * Queries CallRecords DynamoDB table and computes aggregations.
 *
 * Uses in-memory fallback when USE_LOCAL_DB=true.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AnalyticsFilter, AnalyticsReport, CallRecord } from '../types/models';

// ─── DynamoDB client (lazy-initialized) ──────────────────────────────────────

let ddb: DynamoDBDocumentClient | null = null;

function getDdb(): DynamoDBDocumentClient {
  if (!ddb) {
    const client = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
    ddb = DynamoDBDocumentClient.from(client);
  }
  return ddb;
}

// ─── In-memory store for local dev ───────────────────────────────────────────

const localRecords: CallRecord[] = [];

/** Exposed for testing */
export function injectLocalRecords(records: CallRecord[]): void {
  localRecords.length = 0;
  localRecords.push(...records);
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchRecords(filter: AnalyticsFilter): Promise<CallRecord[]> {
  const useLocalDb = process.env['USE_LOCAL_DB'] === 'true';
  const tableName = process.env['CALL_RECORDS_TABLE'] ?? 'CallRecords';

  let records: CallRecord[];

  if (useLocalDb) {
    records = [...localRecords];
  } else {
    const result = await getDdb().send(new ScanCommand({ TableName: tableName }));
    records = (result.Items ?? []) as CallRecord[];
  }

  // Filter by date range and optional locationId
  return records.filter((r) => {
    if (!r.startTime) return false;
    const date = r.startTime.substring(0, 10); // YYYY-MM-DD
    if (date < filter.startDate || date > filter.endDate) return false;
    if (filter.locationId && r.locationId !== filter.locationId) return false;
    return true;
  });
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

function isoToHourKey(iso: string): string {
  // Returns "YYYY-MM-DDTHH" e.g. "2025-01-15T14"
  return iso.substring(0, 13);
}

function isoToDayKey(iso: string): string {
  return iso.substring(0, 10);
}

function isoToWeekKey(iso: string): string {
  const d = new Date(iso);
  // ISO week: Monday-based
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday.toISOString().substring(0, 10);
}

export function computeAnalytics(records: CallRecord[]): AnalyticsReport {
  const callsByHour: Record<string, number> = {};
  const callsByDay: Record<string, number> = {};
  const callsByWeek: Record<string, number> = {};
  const inquiryTopics: Record<string, number> = {};
  const csatByDay: Record<string, number[]> = {};
  const csatByWeek: Record<string, number[]> = {};

  let totalReservationInquiries = 0;
  let reservationsCreated = 0;
  let reservationsModified = 0;
  let reservationsCanceled = 0;

  for (const record of records) {
    const start = record.startTime;

    // Calls by period
    const hourKey = isoToHourKey(start);
    const dayKey = isoToDayKey(start);
    const weekKey = isoToWeekKey(start);

    callsByHour[hourKey] = (callsByHour[hourKey] ?? 0) + 1;
    callsByDay[dayKey] = (callsByDay[dayKey] ?? 0) + 1;
    callsByWeek[weekKey] = (callsByWeek[weekKey] ?? 0) + 1;

    // Inquiry topics
    for (const topic of record.inquiryTopics ?? []) {
      inquiryTopics[topic] = (inquiryTopics[topic] ?? 0) + 1;
    }

    // Reservation actions
    let hasReservationInquiry = false;
    for (const action of record.reservationActions ?? []) {
      if (action.type === 'create') {
        reservationsCreated++;
        hasReservationInquiry = true;
      } else if (action.type === 'modify') {
        reservationsModified++;
        hasReservationInquiry = true;
      } else if (action.type === 'cancel') {
        reservationsCanceled++;
        hasReservationInquiry = true;
      }
    }
    if (hasReservationInquiry) {
      totalReservationInquiries++;
    }

    // CSAT
    if (record.csatScore !== undefined && record.feedbackStatus === 'answered') {
      if (!csatByDay[dayKey]) csatByDay[dayKey] = [];
      csatByDay[dayKey]!.push(record.csatScore);
      if (!csatByWeek[weekKey]) csatByWeek[weekKey] = [];
      csatByWeek[weekKey]!.push(record.csatScore);
    }
  }

  // Average CSAT
  const avgCsatDaily: Record<string, number> = {};
  for (const [day, scores] of Object.entries(csatByDay)) {
    avgCsatDaily[day] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  const avgCsatWeekly: Record<string, number> = {};
  for (const [week, scores] of Object.entries(csatByWeek)) {
    avgCsatWeekly[week] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Peak hours: top 3 one-hour windows
  const peakHours = Object.entries(callsByHour)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour, count]) => ({ hour, count }));

  // Conversion rate: reservations created / total calls with reservation inquiry
  const conversionRate =
    totalReservationInquiries > 0
      ? reservationsCreated / totalReservationInquiries
      : 0;

  return {
    totalCalls: records.length,
    callsByPeriod: {
      hour: callsByHour,
      day: callsByDay,
      week: callsByWeek,
    },
    reservations: {
      created: reservationsCreated,
      modified: reservationsModified,
      canceled: reservationsCanceled,
      conversionRate,
    },
    inquiryTopics,
    averageCsat: {
      daily: avgCsatDaily,
      weekly: avgCsatWeekly,
    },
    peakHours,
  };
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const params = event.queryStringParameters ?? {};
    const startDate = params['startDate'];
    const endDate = params['endDate'];
    const locationId = params['locationId'] ?? undefined;

    if (!startDate || !endDate) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'startDate and endDate query parameters are required' }),
      };
    }

    // Basic date format validation
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'startDate and endDate must be in YYYY-MM-DD format' }),
      };
    }

    const filter: AnalyticsFilter = { startDate, endDate, locationId };
    const records = await fetchRecords(filter);
    const report = computeAnalytics(records);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    };
  } catch (err) {
    console.error('[analytics-api] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
