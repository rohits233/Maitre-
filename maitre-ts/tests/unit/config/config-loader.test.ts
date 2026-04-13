import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, getConfig, clearConfigCache } from '../../../src/config';

// Mock AWS SDK clients so tests don't need real AWS credentials
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  GetSecretValueCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  GetParameterCommand: vi.fn(),
}));

describe('Config Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    clearConfigCache();
    process.env = { ...originalEnv };
    // Ensure we're in local dev mode for most tests
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
    clearConfigCache();
  });

  describe('local dev mode', () => {
    it('loads config from environment variables', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
      process.env.TWILIO_ACCOUNT_SID = 'ACtest123';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      const config = await loadConfig();

      expect(config.twilioAuthToken).toBe('test-auth-token');
      expect(config.twilioAccountSid).toBe('ACtest123');
      expect(config.twilioPhoneNumber).toBe('+15551234567');
    });

    it('uses default values for optional config', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      const config = await loadConfig();

      expect(config.port).toBe(8080);
      expect(config.feedbackEnabled).toBe(true);
      expect(config.drainTimeoutMs).toBe(120000);
      expect(config.smsProvider).toBe('twilio');
      expect(config.awsRegion).toBe('us-east-1');
    });

    it('respects PORT environment variable', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';
      process.env.PORT = '9090';

      const config = await loadConfig();
      expect(config.port).toBe(9090);
    });

    it('respects FEEDBACK_ENABLED=false', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';
      process.env.FEEDBACK_ENABLED = 'false';

      const config = await loadConfig();
      expect(config.feedbackEnabled).toBe(false);
    });

    it('respects SMS_PROVIDER=sns', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';
      process.env.SMS_PROVIDER = 'sns';

      const config = await loadConfig();
      expect(config.smsProvider).toBe('sns');
    });

    it('throws when TWILIO_AUTH_TOKEN is missing', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      await expect(loadConfig()).rejects.toThrow('TWILIO_AUTH_TOKEN');
    });

    it('throws when TWILIO_ACCOUNT_SID is missing', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      delete process.env.TWILIO_ACCOUNT_SID;
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      await expect(loadConfig()).rejects.toThrow('TWILIO_ACCOUNT_SID');
    });

    it('throws when TWILIO_PHONE_NUMBER is missing', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      delete process.env.TWILIO_PHONE_NUMBER;

      await expect(loadConfig()).rejects.toThrow('TWILIO_PHONE_NUMBER');
    });

    it('caches config after first load', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      const config1 = await loadConfig();
      const config2 = await loadConfig();

      expect(config1).toBe(config2); // Same reference = cached
    });

    it('getConfig() throws before loadConfig() is called', () => {
      expect(() => getConfig()).toThrow('Configuration has not been loaded');
    });

    it('getConfig() returns config after loadConfig()', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      await loadConfig();
      const config = getConfig();
      expect(config.twilioAuthToken).toBe('token');
    });

    it('clearConfigCache() allows reloading config', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token-v1';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';

      const config1 = await loadConfig();
      expect(config1.twilioAuthToken).toBe('token-v1');

      clearConfigCache();
      process.env.TWILIO_AUTH_TOKEN = 'token-v2';

      const config2 = await loadConfig();
      expect(config2.twilioAuthToken).toBe('token-v2');
    });

    it('loads DynamoDB table names from env vars', async () => {
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_ACCOUNT_SID = 'ACsid';
      process.env.TWILIO_PHONE_NUMBER = '+15551234567';
      process.env.RESERVATIONS_TABLE = 'MyReservations';
      process.env.CALL_RECORDS_TABLE = 'MyCallRecords';

      const config = await loadConfig();
      expect(config.reservationsTable).toBe('MyReservations');
      expect(config.callRecordsTable).toBe('MyCallRecords');
    });
  });
});
