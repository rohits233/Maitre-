import express, { Request, Response } from 'express';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Health check — used by ALB / App Runner
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});

// Twilio webhook — called when someone dials your number
app.post('/voice/inbound', (req: Request, res: Response) => {
  // Validate the request came from Twilio (skip in dev if no auth token set)
  if (TWILIO_AUTH_TOKEN) {
    const signature = req.headers['x-twilio-signature'] as string;
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
    if (!isValid) {
      res.status(403).send('Forbidden');
      return;
    }
  }

  // Respond with TwiML — Twilio reads this aloud to the caller
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">
    Hello. You've reached Maître, your AI dining concierge. We're getting set up — please call back soon.
  </Say>
</Response>`);
});

app.listen(PORT, () => {
  console.log(`Maître listening on port ${PORT}`);
});
