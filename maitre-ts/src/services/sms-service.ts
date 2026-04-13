/**
 * SMS Service
 *
 * Sends SMS messages via Twilio Messaging API or Amazon SNS.
 * Provider is selected via `smsProvider` config field.
 *
 * All sends are fire-and-forget (callers do not await).
 * Failures are logged with correlation ID and error code.
 *
 * Subscribes to Session Manager events:
 *   - reservation:completed → sendReservationConfirmation
 *   - inquiry:completed     → sendDirections / sendMenuLink
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { AppConfig } from '../config';
import { CallSession } from '../types/index';
import { Reservation, RestaurantLocation } from '../types/models';

// ─── Provider abstraction ─────────────────────────────────────────────────────

interface SMSProviderBackend {
  sendSMS(to: string, body: string): Promise<void>;
}

class TwilioSMSProvider implements SMSProviderBackend {
  private client: import('twilio').Twilio;
  private fromNumber: string;

  constructor(accountSid: string, authToken: string, fromNumber: string) {
    // Lazy import to avoid loading twilio at module level in tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const twilio = require('twilio') as (sid: string, token: string) => import('twilio').Twilio;
    this.client = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
  }

  async sendSMS(to: string, body: string): Promise<void> {
    await this.client.messages.create({ to, from: this.fromNumber, body });
  }
}

class SNSSMSProvider implements SMSProviderBackend {
  private client: SNSClient;

  constructor(region: string) {
    this.client = new SNSClient({ region });
  }

  async sendSMS(to: string, body: string): Promise<void> {
    await this.client.send(
      new PublishCommand({
        PhoneNumber: to,
        Message: body,
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
        },
      })
    );
  }
}

// ─── SMS Service ──────────────────────────────────────────────────────────────

export class SMSService {
  private provider: SMSProviderBackend;
  private correlationId?: string;

  constructor(config: AppConfig) {
    if (config.smsProvider === 'sns') {
      this.provider = new SNSSMSProvider(config.awsRegion);
    } else {
      this.provider = new TwilioSMSProvider(
        config.twilioAccountSid,
        config.twilioAuthToken,
        config.twilioPhoneNumber
      );
    }
  }

  /** For testing: inject a custom provider backend */
  static withProvider(provider: SMSProviderBackend): SMSService {
    const instance = Object.create(SMSService.prototype) as SMSService;
    instance.provider = provider;
    return instance;
  }

  // ─── Public send methods ────────────────────────────────────────────────────

  async sendReservationConfirmation(callerPhone: string, reservation: Reservation): Promise<void> {
    const body =
      `Reservation confirmed!\n` +
      `Confirmation #: ${reservation.confirmationNumber}\n` +
      `Date: ${reservation.date} at ${reservation.time}\n` +
      `Party size: ${reservation.partySize}\n` +
      `Guest: ${reservation.guestName}`;
    await this.send(callerPhone, body, reservation.correlationId);
  }

  async sendReservationUpdate(callerPhone: string, reservation: Reservation): Promise<void> {
    const body =
      `Your reservation has been updated.\n` +
      `Confirmation #: ${reservation.confirmationNumber}\n` +
      `New date: ${reservation.date} at ${reservation.time}\n` +
      `Party size: ${reservation.partySize}`;
    await this.send(callerPhone, body, reservation.correlationId);
  }

  async sendCancellationConfirmation(callerPhone: string, reservation: Reservation): Promise<void> {
    const body =
      `Your reservation has been cancelled.\n` +
      `Original booking: ${reservation.date} at ${reservation.time}\n` +
      `Confirmation #: ${reservation.confirmationNumber}`;
    await this.send(callerPhone, body, reservation.correlationId);
  }

  async sendDirections(callerPhone: string, location: RestaurantLocation): Promise<void> {
    const body =
      `Directions to ${location.name}:\n` +
      `${location.address}\n` +
      `Map: ${location.mapUrl}`;
    await this.send(callerPhone, body, this.correlationId);
  }

  async sendMenuLink(callerPhone: string, location: RestaurantLocation): Promise<void> {
    const body = `${location.name} menu: ${location.menuUrl}`;
    await this.send(callerPhone, body, this.correlationId);
  }

  async sendFeedbackSurvey(callerPhone: string, correlationId: string): Promise<void> {
    const body =
      `Thank you for calling! How was your experience?\n` +
      `Reply with a rating 1-5 (5 = excellent).`;
    await this.send(callerPhone, body, correlationId);
  }

  // ─── Session Manager event subscriptions ───────────────────────────────────

  subscribeToSessionManager(sessionManager: {
    on(event: string, handler: (...args: unknown[]) => void): void;
  }): void {
    sessionManager.on('reservation:completed', (session: unknown, reservation: unknown) => {
      const s = session as CallSession;
      const r = reservation as Reservation;
      this.sendReservationConfirmation(s.callerPhone, r).catch(() => {
        // already logged inside send()
      });
    });

    sessionManager.on('inquiry:completed', (session: unknown, location: unknown) => {
      const s = session as CallSession;
      const loc = location as RestaurantLocation;
      if (loc?.mapUrl) {
        this.sendDirections(s.callerPhone, loc).catch(() => {});
      }
      if (loc?.menuUrl) {
        this.sendMenuLink(s.callerPhone, loc).catch(() => {});
      }
    });
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async send(to: string, body: string, correlationId?: string): Promise<void> {
    try {
      await this.provider.sendSMS(to, body);
    } catch (err) {
      const errorCode = (err as { code?: string | number }).code ?? 'UNKNOWN';
      console.error(
        `[sms-service] Failed to send SMS to ${to}` +
          (correlationId ? ` (correlationId=${correlationId})` : '') +
          ` errorCode=${errorCode}`,
        err
      );
    }
  }
}
