import { APIGatewayProxyHandler } from 'aws-lambda';

/**
 * SMS Webhook Lambda — POST /sms/inbound
 *
 * Handles inbound Twilio SMS webhooks for feedback survey responses.
 * Validates Twilio signature, parses CSAT score (1-5) and optional comment,
 * matches response to original Call_Session via FeedbackSurveys table,
 * records feedback in CallRecords table, and deletes the FeedbackSurveys record.
 *
 * Requirements: 16.3
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  // TODO: implement in task 16.2
  return {
    statusCode: 200,
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    headers: { 'Content-Type': 'text/xml' },
  };
};
