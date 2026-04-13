import { ToolResult } from './index';

// ─── Reservation ──────────────────────────────────────────────────────────────

export interface Reservation {
  reservationId: string;       // UUID
  locationId: string;
  guestName: string;
  partySize: number;
  date: string;                // YYYY-MM-DD
  time: string;                // HH:mm
  specialRequests?: string;
  status: 'confirmed' | 'modified' | 'canceled';
  confirmationNumber: string;  // Human-readable (e.g., "RES-A1B2C3")
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  callerPhone: string;
  correlationId: string;       // Links to Call_Session
  idempotencyKey: string;
}

// ─── Availability Slot ────────────────────────────────────────────────────────

export interface AvailabilitySlot {
  locationId: string;
  date: string;             // YYYY-MM-DD
  time: string;             // HH:mm
  maxPartySize: number;
  remainingCapacity: number;
}

// ─── Restaurant Location ──────────────────────────────────────────────────────

export interface RestaurantLocation {
  locationId: string;
  restaurantGroupId: string;
  name: string;
  address: string;
  phone: string;
  mapUrl: string;
  coordinates: { lat: number; lng: number };
  operatingHours: Record<string, { open: string; close: string }>; // day -> hours
  menuUrl: string;
  timezone: string;
}

// ─── Call Record (Analytics) ──────────────────────────────────────────────────

export interface ReservationAction {
  type: 'create' | 'modify' | 'cancel';
  reservationId: string;
  timestamp: string; // ISO 8601
}

export interface CallRecord {
  correlationId: string;
  callSid: string;
  callerPhone: string;
  locationId: string;
  startTime: string;       // ISO 8601
  endTime: string;         // ISO 8601
  durationSeconds: number;
  terminationReason: string;
  inquiryTopics: string[];
  reservationActions: ReservationAction[];
  csatScore?: number;
  csatComment?: string;
  feedbackStatus: 'sent' | 'answered' | 'unanswered' | 'disabled';
}

// ─── Feedback Record ──────────────────────────────────────────────────────────

export interface FeedbackRecord {
  correlationId: string;
  callerPhone: string;
  sentAt: string;          // ISO 8601
  csatScore?: number;      // 1-5
  comment?: string;
  respondedAt?: string;    // ISO 8601
  status: 'sent' | 'answered' | 'unanswered';
  timeoutAt: number;       // DynamoDB TTL for 24h unanswered check (Unix epoch seconds)
}

// ─── Idempotency Record ───────────────────────────────────────────────────────

export interface IdempotencyRecord {
  idempotencyKey: string;
  result: ToolResult;
  createdAt: string; // ISO 8601
  ttl: number;       // DynamoDB TTL, 24 hours from creation (Unix epoch seconds)
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface AnalyticsFilter {
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  locationId?: string;
}

export interface AnalyticsReport {
  totalCalls: number;
  callsByPeriod: {
    hour: Record<string, number>;
    day: Record<string, number>;
    week: Record<string, number>;
  };
  reservations: {
    created: number;
    modified: number;
    canceled: number;
    conversionRate: number;
  };
  inquiryTopics: Record<string, number>;
  averageCsat: {
    daily: Record<string, number>;
    weekly: Record<string, number>;
  };
  peakHours: { hour: string; count: number }[];
}
