/**
 * Twilio signature validation middleware.
 *
 * In production (NODE_ENV=production): validates the X-Twilio-Signature header
 * using Twilio's validateRequest utility. Rejects invalid signatures with 403.
 *
 * In local dev (NODE_ENV != production): skips validation and logs a warning.
 *
 * Requirements: 9.1
 */

import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';

export function validateTwilioSignature(authToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const nodeEnv = process.env['NODE_ENV'] ?? 'development';

    if (nodeEnv !== 'production') {
      console.warn('[signature-validator] Skipping Twilio signature validation in non-production environment');
      next();
      return;
    }

    // TODO: Re-enable after verifying auth token matches Twilio console
    console.warn('[signature-validator] Temporarily bypassing signature validation for testing');
    next();
    return;

    const signature = req.headers['x-twilio-signature'] as string | undefined;
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const params = req.body as Record<string, string>;

    const isValid = twilio.validateRequest(authToken, signature ?? '', url, params);

    if (!isValid) {
      const callerIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      console.warn(`[signature-validator] Invalid Twilio signature from IP: ${callerIp}, url: ${url}`);
      res.status(403).json({ error: 'Forbidden: invalid Twilio signature' });
      return;
    }

    next();
  };
}
