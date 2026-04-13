import { DynamoDBStreamHandler } from 'aws-lambda';

/**
 * Feedback Timeout Lambda — DynamoDB Streams trigger on FeedbackSurveys
 *
 * Triggered by REMOVE events on the FeedbackSurveys table (TTL expiry).
 * Filters for TTL-deleted records (userIdentity.type === 'Service').
 * If feedback was not already answered, marks the CallRecords entry as 'unanswered'.
 *
 * Requirements: 16.4
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  // TODO: implement in task 16.3
  for (const record of event.Records) {
    if (record.eventName !== 'REMOVE') continue;
    // TTL expiry records have userIdentity.type === 'Service'
    // (filtered at the event source level, but double-check here for safety)
  }
};
