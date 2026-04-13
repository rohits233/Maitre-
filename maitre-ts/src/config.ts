/**
 * Configuration loader for the Voice Gateway.
 *
 * In production (NODE_ENV=production):
 *   - Twilio credentials are loaded from AWS Secrets Manager (SECRET_ARN env var)
 *   - Feature flags are loaded from SSM Parameter Store (SSM_PREFIX env var)
 *   - Other config from environment variables
 *
 * In local dev (NODE_ENV != production):
 *   - All configuration from environment variables
 *
 * Secrets are loaded once at startup and cached in-process.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ─── Config Shape ─────────────────────────────────────────────────────────────

export interface AppConfig {
  // Server
  port: number;
  nodeEnv: string;

  // Twilio
  twilioAuthToken: string;
  twilioAccountSid: string;
  twilioPhoneNumber: string;

  // Nova Sonic / Bedrock
  novaSonicEndpoint: string;
  awsRegion: string;

  // DynamoDB
  reservationsTable: string;
  availabilitySlotsTable: string;
  locationsTable: string;
  vipListTable: string;
  callFlowRulesTable: string;
  voicePersonasTable: string;
  callRecordsTable: string;
  idempotencyKeysTable: string;
  feedbackSurveysTable: string;

  // Feature flags
  feedbackEnabled: boolean;
  drainTimeoutMs: number;
  smsProvider: 'twilio' | 'sns';

  // Location
  defaultLocationId: string;
}

// ─── Cached config (populated at startup) ────────────────────────────────────

let cachedConfig: AppConfig | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

// ─── Secrets Manager loader ───────────────────────────────────────────────────

interface TwilioSecret {
  authToken: string;
  accountSid: string;
}

async function loadTwilioFromSecretsManager(secretArn: string, region: string): Promise<TwilioSecret> {
  const client = new SecretsManagerClient({ region });
  const command = new GetSecretValueCommand({ SecretId: secretArn });

  let secretString: string;
  try {
    const response = await client.send(command);
    if (!response.SecretString) {
      throw new Error(`Secret ${secretArn} has no SecretString value`);
    }
    secretString = response.SecretString;
  } catch (err) {
    throw new Error(
      `Failed to load Twilio credentials from Secrets Manager (${secretArn}): ${(err as Error).message}`
    );
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(secretString) as Record<string, string>;
  } catch {
    throw new Error(`Secret ${secretArn} is not valid JSON`);
  }

  if (!parsed.authToken) {
    throw new Error(`Secret ${secretArn} is missing required field: authToken`);
  }
  if (!parsed.accountSid) {
    throw new Error(`Secret ${secretArn} is missing required field: accountSid`);
  }

  return { authToken: parsed.authToken, accountSid: parsed.accountSid };
}

// ─── SSM Parameter Store loader ───────────────────────────────────────────────

async function loadSsmParameter(
  client: SSMClient,
  name: string,
  defaultValue: string
): Promise<string> {
  try {
    const response = await client.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
    return response.Parameter?.Value ?? defaultValue;
  } catch (err) {
    // Log warning and fall back to default — SSM unavailability should not crash startup
    console.warn(`[config] Failed to load SSM parameter ${name}, using default: ${(err as Error).message}`);
    return defaultValue;
  }
}

// ─── Main loader ──────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const nodeEnv = optionalEnv('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const awsRegion = optionalEnv('AWS_REGION', 'us-east-1');

  let twilioAuthToken: string;
  let twilioAccountSid: string;
  let feedbackEnabled: boolean;
  let drainTimeoutMs: number;
  let smsProvider: 'twilio' | 'sns';

  if (isProduction) {
    // ── Production: load secrets from Secrets Manager, flags from SSM ──────
    const secretArn = requireEnv('SECRET_ARN');
    const ssmPrefix = optionalEnv('SSM_PREFIX', '/voice-gateway');

    const twilioSecret = await loadTwilioFromSecretsManager(secretArn, awsRegion);
    twilioAuthToken = twilioSecret.authToken;
    twilioAccountSid = twilioSecret.accountSid;

    const ssmClient = new SSMClient({ region: awsRegion });

    const feedbackEnabledStr = await loadSsmParameter(
      ssmClient,
      `${ssmPrefix}/feedback-enabled`,
      'true'
    );
    feedbackEnabled = feedbackEnabledStr.toLowerCase() === 'true';

    const drainTimeoutStr = await loadSsmParameter(
      ssmClient,
      `${ssmPrefix}/drain-timeout-ms`,
      '120000'
    );
    drainTimeoutMs = parseInt(drainTimeoutStr, 10);
    if (isNaN(drainTimeoutMs)) {
      console.warn('[config] Invalid drain-timeout-ms from SSM, using default 120000');
      drainTimeoutMs = 120000;
    }

    const smsProviderStr = await loadSsmParameter(
      ssmClient,
      `${ssmPrefix}/sms-provider`,
      'twilio'
    );
    smsProvider = smsProviderStr === 'sns' ? 'sns' : 'twilio';
  } else {
    // ── Local dev: all config from environment variables ───────────────────
    twilioAuthToken = requireEnv('TWILIO_AUTH_TOKEN');
    twilioAccountSid = requireEnv('TWILIO_ACCOUNT_SID');
    feedbackEnabled = optionalEnvBool('FEEDBACK_ENABLED', true);
    drainTimeoutMs = optionalEnvInt('DRAIN_TIMEOUT_MS', 120000);
    const smsProviderRaw = optionalEnv('SMS_PROVIDER', 'twilio');
    smsProvider = smsProviderRaw === 'sns' ? 'sns' : 'twilio';
  }

  // ── Validate required fields ─────────────────────────────────────────────
  if (!twilioAuthToken) {
    throw new Error('Twilio auth token is required but was empty');
  }
  if (!twilioAccountSid) {
    throw new Error('Twilio account SID is required but was empty');
  }

  cachedConfig = {
    port: optionalEnvInt('PORT', 8080),
    nodeEnv,

    twilioAuthToken,
    twilioAccountSid,
    twilioPhoneNumber: requireEnv('TWILIO_PHONE_NUMBER'),

    novaSonicEndpoint: optionalEnv('NOVA_SONIC_ENDPOINT', 'wss://bedrock-runtime.us-east-1.amazonaws.com'),
    awsRegion,

    reservationsTable: optionalEnv('RESERVATIONS_TABLE', 'Reservations'),
    availabilitySlotsTable: optionalEnv('AVAILABILITY_SLOTS_TABLE', 'AvailabilitySlots'),
    locationsTable: optionalEnv('LOCATIONS_TABLE', 'Locations'),
    vipListTable: optionalEnv('VIP_LIST_TABLE', 'VIPList'),
    callFlowRulesTable: optionalEnv('CALL_FLOW_RULES_TABLE', 'CallFlowRules'),
    voicePersonasTable: optionalEnv('VOICE_PERSONAS_TABLE', 'VoicePersonas'),
    callRecordsTable: optionalEnv('CALL_RECORDS_TABLE', 'CallRecords'),
    idempotencyKeysTable: optionalEnv('IDEMPOTENCY_KEYS_TABLE', 'IdempotencyKeys'),
    feedbackSurveysTable: optionalEnv('FEEDBACK_SURVEYS_TABLE', 'FeedbackSurveys'),

    feedbackEnabled,
    drainTimeoutMs,
    smsProvider,

    defaultLocationId: optionalEnv('DEFAULT_LOCATION_ID', 'default'),
  };

  return cachedConfig;
}

/**
 * Returns the cached config. Throws if loadConfig() has not been called yet.
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error('Configuration has not been loaded. Call loadConfig() at startup.');
  }
  return cachedConfig;
}

/**
 * Clears the cached config. Useful for testing.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
