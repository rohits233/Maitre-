# Requirements Document

## Introduction

This document specifies the requirements for integrating a telephone (PSTN) voice channel using the Twilio SDK. The system enables natural, low-latency, interruption-aware voice conversations by reusing existing Nova Sonic bidirectional streaming logic and routing conversations through MCP tools. The solution supports both local development testing and production deployment on AWS infrastructure.

The system also serves as a restaurant voice AI platform, handling the full reservation lifecycle (create, modify, cancel), answering common restaurant inquiries, sending SMS follow-ups, supporting cross-location availability, VIP call routing, post-call guest feedback, call analytics, and customizable voice persona and call flows.

## Glossary

- **Voice_Gateway**: The server component that accepts inbound Twilio PSTN calls, manages WebSocket media streams, and bridges telephony audio to the Conversation_Engine.
- **Conversation_Engine**: The component that orchestrates bidirectional streaming sessions with Amazon Nova Sonic, handling audio input/output, turn-taking, and interruption detection.
- **MCP_Router**: The component responsible for dispatching tool invocations from the Conversation_Engine to registered MCP tool servers and returning results.
- **Call_Session**: A stateful object representing a single active phone call, including its Twilio call SID, WebSocket connection, Nova Sonic stream session, and associated metadata.
- **Media_Stream**: The Twilio Media Stream WebSocket connection that carries real-time audio (mulaw 8kHz) between Twilio and the Voice_Gateway.
- **PSTN**: Public Switched Telephone Network — the traditional telephone infrastructure.
- **Nova_Sonic**: Amazon Nova Sonic, a bidirectional speech-to-speech streaming model that supports real-time voice conversations with native interruption handling.
- **Interruption**: An event where the caller begins speaking while the system is still producing audio output, requiring the system to stop its current utterance and listen.
- **TwiML**: Twilio Markup Language — XML-based instructions that tell Twilio how to handle calls.
- **MCP_Tool**: A Model Context Protocol tool that the Conversation_Engine can invoke during a conversation to perform actions or retrieve information.
- **Reservation_Tool**: An MCP_Tool that manages restaurant reservations, including creating, modifying, and canceling bookings in the reservation system.
- **Inquiry_Tool**: An MCP_Tool that retrieves restaurant information such as operating hours, menu details, location, and table availability.
- **Reservation**: A booking record containing the guest name, party size, date, time, and optional special requests (e.g., dietary needs, seating preference).
- **Availability_Slot**: A bookable time window for a given party size, representing open capacity at the restaurant.
- **SMS_Service**: The component responsible for sending outbound SMS messages to callers via the Twilio Messaging API, triggered by events during or after a Call_Session.
- **Restaurant_Group**: A collection of one or more restaurant locations that share a common brand or ownership and whose availability data can be queried together.
- **Location**: A single physical restaurant within a Restaurant_Group, identified by a unique location identifier, address, and operating hours.
- **VIP_List**: A configurable registry of caller phone numbers or identifiers designated as VIP guests, used to determine special call routing.
- **Concierge_Line**: A designated staff phone number or extension to which VIP callers are transferred instead of being handled by the Conversation_Engine.
- **Feedback_Survey**: A short post-call questionnaire delivered via SMS or voice prompt to collect a caller's satisfaction rating and optional comments.
- **CSAT_Score**: Customer Satisfaction Score — a numeric rating (1–5) provided by a caller in a Feedback_Survey.
- **Call_Analytics_Service**: The component that aggregates and stores call metrics, reservation outcomes, inquiry topics, and satisfaction data for reporting and trend analysis.
- **Voice_Persona**: A configurable profile that defines the voice assistant's greeting, name, tone, and conversational style.
- **Call_Flow**: A configurable routing rule set that determines how inbound calls are handled based on business rules such as time of day, inquiry type, or caller identity.

## Requirements

### Requirement 1: Accept Inbound PSTN Calls

**User Story:** As a caller, I want to dial a phone number and be connected to the voice assistant, so that I can have a conversation without needing a web browser or app.

#### Acceptance Criteria

1. WHEN an inbound PSTN call arrives at the configured Twilio phone number, THE Voice_Gateway SHALL respond with TwiML that initiates a Media_Stream WebSocket connection.
2. WHEN the Media_Stream WebSocket connection is established, THE Voice_Gateway SHALL create a new Call_Session and associate it with the Twilio call SID.
3. IF the Voice_Gateway fails to establish a Media_Stream WebSocket connection, THEN THE Voice_Gateway SHALL return a TwiML response that plays an error message to the caller and ends the call.
4. THE Voice_Gateway SHALL accept concurrent inbound calls, each managed as an independent Call_Session.

### Requirement 2: Bridge Telephony Audio to Nova Sonic

**User Story:** As a system operator, I want inbound call audio to be streamed to Nova Sonic in real time, so that the voice assistant can understand and respond to callers.

#### Acceptance Criteria

1. WHEN the Voice_Gateway receives audio data from a Media_Stream, THE Voice_Gateway SHALL transcode the audio from mulaw 8kHz to the format required by the Conversation_Engine and forward it with a latency of no more than 100ms.
2. WHEN the Conversation_Engine produces audio output, THE Voice_Gateway SHALL transcode the audio to mulaw 8kHz and send it to the corresponding Media_Stream.
3. WHILE a Call_Session is active, THE Conversation_Engine SHALL maintain a persistent bidirectional streaming session with Nova_Sonic.
4. IF the Nova_Sonic streaming session disconnects unexpectedly, THEN THE Conversation_Engine SHALL attempt to re-establish the session within 3 seconds and, if unsuccessful, play an error message to the caller and end the call gracefully.

### Requirement 3: Support Natural Interruption Handling

**User Story:** As a caller, I want to interrupt the voice assistant while it is speaking, so that the conversation feels natural and responsive.

#### Acceptance Criteria

1. WHEN the Conversation_Engine detects an Interruption event from Nova_Sonic, THE Voice_Gateway SHALL immediately stop sending the current audio output to the Media_Stream.
2. WHEN an Interruption is detected, THE Voice_Gateway SHALL send a clear message to the Twilio Media_Stream to flush any buffered audio on the Twilio side.
3. WHEN an Interruption is detected, THE Conversation_Engine SHALL begin processing the caller's new utterance within 200ms of the Interruption event.

### Requirement 4: Route Conversations Through MCP Tools

**User Story:** As a system operator, I want the voice assistant to invoke MCP tools during conversations, so that it can perform actions and retrieve information on behalf of callers.

#### Acceptance Criteria

1. WHEN the Conversation_Engine receives a tool invocation request from Nova_Sonic, THE MCP_Router SHALL dispatch the request to the appropriate registered MCP_Tool server.
2. WHEN the MCP_Router receives a response from an MCP_Tool server, THE MCP_Router SHALL return the result to the Conversation_Engine within the same streaming session.
3. IF an MCP_Tool server fails to respond within 10 seconds, THEN THE MCP_Router SHALL return a timeout error to the Conversation_Engine.
4. IF an MCP_Tool server returns an error, THEN THE MCP_Router SHALL forward the error to the Conversation_Engine so that Nova_Sonic can communicate the failure to the caller.
5. THE MCP_Router SHALL support registration of MCP_Tool servers via a configuration file.

### Requirement 5: Manage Call Session Lifecycle

**User Story:** As a system operator, I want call sessions to be properly created, maintained, and cleaned up, so that system resources are managed reliably.

#### Acceptance Criteria

1. WHEN a new Media_Stream WebSocket connection is established, THE Voice_Gateway SHALL initialize a Call_Session with the Twilio call SID, caller phone number, and timestamp.
2. WHEN the caller hangs up or the Twilio Media_Stream sends a stop event, THE Voice_Gateway SHALL terminate the corresponding Call_Session and release all associated resources including the Nova_Sonic streaming session.
3. WHEN the Media_Stream WebSocket connection drops unexpectedly, THE Voice_Gateway SHALL terminate the corresponding Call_Session within 5 seconds and release all associated resources.
4. WHILE a Call_Session is active, THE Voice_Gateway SHALL send periodic heartbeat messages to maintain the Media_Stream WebSocket connection.

### Requirement 6: Support Local Development Testing

**User Story:** As a developer, I want to test the voice channel locally, so that I can iterate on features without deploying to AWS.

#### Acceptance Criteria

1. THE Voice_Gateway SHALL be runnable on a local development machine using a single command.
2. WHEN running locally, THE Voice_Gateway SHALL support tunneling via ngrok or a similar tool to expose the local server to Twilio webhooks.
3. THE Voice_Gateway SHALL load configuration from environment variables, supporting both local and production values without code changes.
4. WHEN running locally, THE Voice_Gateway SHALL log all inbound and outbound audio events, WebSocket messages, and MCP_Tool invocations at debug level.

### Requirement 7: Support Production Deployment on AWS

**User Story:** As a system operator, I want to deploy the voice channel to AWS, so that it can handle production call traffic reliably.

#### Acceptance Criteria

1. THE Voice_Gateway SHALL provide infrastructure-as-code templates for deployment to AWS.
2. THE Voice_Gateway SHALL support deployment behind an Application Load Balancer with WebSocket-compatible routing.
3. WHEN deployed to AWS, THE Voice_Gateway SHALL use AWS IAM credentials for authenticating with Nova_Sonic.
4. THE Voice_Gateway SHALL support horizontal scaling by running multiple instances behind a load balancer, with each Call_Session handled entirely by a single instance.
5. IF an instance becomes unhealthy, THEN THE Application Load Balancer SHALL stop routing new calls to that instance while allowing existing Call_Sessions to complete.

### Requirement 8: Provide Observability and Logging

**User Story:** As a system operator, I want visibility into call activity and system health, so that I can monitor and troubleshoot the voice channel.

#### Acceptance Criteria

1. THE Voice_Gateway SHALL log the start and end of each Call_Session, including the Twilio call SID, caller phone number, call duration, and termination reason.
2. THE Voice_Gateway SHALL emit metrics for active Call_Session count, audio latency, and MCP_Tool invocation count and latency.
3. IF an error occurs during a Call_Session, THEN THE Voice_Gateway SHALL log the error with the associated Twilio call SID and sufficient context for debugging.
4. THE Voice_Gateway SHALL assign a unique correlation identifier to each Call_Session and include the identifier in all log entries and metric emissions for that session.

### Requirement 9: Secure Call Handling

**User Story:** As a system operator, I want call handling to be secure, so that caller data and system access are protected.

#### Acceptance Criteria

1. WHEN receiving a webhook request from Twilio, THE Voice_Gateway SHALL validate the request signature using the Twilio auth token to confirm the request originated from Twilio.
2. THE Voice_Gateway SHALL transmit all Media_Stream audio over WSS (WebSocket Secure) connections.
3. THE Voice_Gateway SHALL not persist raw call audio beyond the duration of the Call_Session unless explicitly configured to do so.
4. THE Voice_Gateway SHALL store Twilio credentials and other secrets using environment variables or a secrets manager, not in source code or configuration files committed to version control.

### Requirement 10: Handle Restaurant Reservation Requests

**User Story:** As a caller, I want to make, modify, or cancel a restaurant reservation by phone, so that I can manage my bookings without using a website or app.

#### Acceptance Criteria

1. WHEN a caller requests a new reservation, THE Conversation_Engine SHALL invoke the Reservation_Tool to collect the guest name, party size, desired date, and desired time, and create the Reservation.
2. WHEN a caller requests to modify an existing Reservation, THE Conversation_Engine SHALL invoke the Reservation_Tool to look up the Reservation by guest name and date, confirm the match with the caller, and apply the requested changes.
3. WHEN a caller requests to cancel an existing Reservation, THE Conversation_Engine SHALL invoke the Reservation_Tool to look up the Reservation, confirm the cancellation with the caller, and remove the Reservation.
4. WHEN the Reservation_Tool successfully creates, modifies, or cancels a Reservation, THE Conversation_Engine SHALL read back the Reservation details to the caller for verbal confirmation.
5. IF the requested date and time have no available Availability_Slots for the given party size, THEN THE Conversation_Engine SHALL invoke the Reservation_Tool to retrieve the nearest available Availability_Slots and offer them as alternatives to the caller.
6. IF the Reservation_Tool cannot find a matching Reservation for a modification or cancellation request, THEN THE Conversation_Engine SHALL inform the caller that no matching Reservation was found and offer to search again with different details.

### Requirement 11: Handle Restaurant Inquiries

**User Story:** As a caller, I want to ask about restaurant hours, menu options, location, and availability, so that I can get the information I need without visiting the website.

#### Acceptance Criteria

1. WHEN a caller asks about restaurant operating hours, THE Conversation_Engine SHALL invoke the Inquiry_Tool to retrieve the current hours of operation and read them to the caller.
2. WHEN a caller asks about the menu, THE Conversation_Engine SHALL invoke the Inquiry_Tool to retrieve menu information and provide a spoken summary relevant to the caller's question (e.g., dietary options, specials, price range).
3. WHEN a caller asks about the restaurant location or directions, THE Conversation_Engine SHALL invoke the Inquiry_Tool to retrieve the address and provide it to the caller.
4. WHEN a caller asks about table availability for a specific date, time, or party size, THE Conversation_Engine SHALL invoke the Inquiry_Tool to check Availability_Slots and report the results to the caller.
5. IF the Inquiry_Tool does not have information to answer a caller's question, THEN THE Conversation_Engine SHALL inform the caller that the information is not available and offer to transfer the call or take a message.

### Requirement 12: Provide Restaurant-Domain MCP Tools

**User Story:** As a system operator, I want dedicated MCP tools for restaurant operations, so that the voice assistant can manage reservations and answer inquiries against the restaurant's data sources.

#### Acceptance Criteria

1. THE Reservation_Tool SHALL expose MCP_Tool endpoints for creating, retrieving, modifying, and canceling Reservations.
2. THE Reservation_Tool SHALL expose an MCP_Tool endpoint for querying available Availability_Slots by date, time range, and party size.
3. THE Inquiry_Tool SHALL expose MCP_Tool endpoints for retrieving operating hours, menu information, and restaurant location.
4. THE Reservation_Tool SHALL validate all incoming reservation data, including that the party size is a positive integer, the date is not in the past, and the requested time falls within operating hours.
5. IF the Reservation_Tool receives a request with invalid data, THEN THE Reservation_Tool SHALL return a descriptive error message indicating which fields are invalid and why.
6. THE Reservation_Tool SHALL enforce idempotency for create and cancel operations using a caller-session-scoped idempotency key to prevent duplicate Reservations from repeated tool invocations.

### Requirement 13: Send SMS Follow-up Messages

**User Story:** As a caller, I want to receive an SMS after key interactions, so that I have a written record of reservation details, directions, or other information discussed during the call.

#### Acceptance Criteria

1. WHEN the Reservation_Tool successfully creates a Reservation, THE SMS_Service SHALL send an SMS to the caller's phone number containing the reservation confirmation number, date, time, party size, and restaurant address.
2. WHEN the Reservation_Tool successfully modifies a Reservation, THE SMS_Service SHALL send an SMS to the caller's phone number containing the updated Reservation details.
3. WHEN the Reservation_Tool successfully cancels a Reservation, THE SMS_Service SHALL send an SMS to the caller's phone number confirming the cancellation and including the original reservation date and time.
4. WHEN a caller requests directions or location information, THE SMS_Service SHALL send an SMS to the caller's phone number containing the restaurant address and a map link.
5. WHEN a caller requests menu information, THE SMS_Service SHALL send an SMS to the caller's phone number containing a link to the restaurant's online menu.
6. IF the SMS_Service fails to deliver an SMS, THEN THE SMS_Service SHALL log the failure with the Call_Session correlation identifier and the Twilio error code.
7. THE SMS_Service SHALL send all follow-up SMS messages within 30 seconds of the triggering event.

### Requirement 14: Suggest Cross-Location Availability

**User Story:** As a caller, I want to be offered availability at other locations in the same restaurant group when my preferred location or time is unavailable, so that I can still make a reservation without calling multiple numbers.

#### Acceptance Criteria

1. IF the requested date, time, and party size have no available Availability_Slots at the caller's preferred Location, THEN THE Conversation_Engine SHALL invoke the Reservation_Tool to query Availability_Slots across all Locations in the same Restaurant_Group.
2. WHEN alternative Availability_Slots are found at other Locations, THE Conversation_Engine SHALL present the caller with up to three alternative options, including the Location name, address, and available times.
3. WHEN the caller selects an alternative Location and time, THE Conversation_Engine SHALL invoke the Reservation_Tool to create the Reservation at the selected Location.
4. IF no Availability_Slots are found at any Location in the Restaurant_Group for the requested date and party size, THEN THE Conversation_Engine SHALL inform the caller that no availability exists and offer to search alternative dates.
5. WHERE the restaurant operates as a single Location with no Restaurant_Group, THE Conversation_Engine SHALL skip the cross-location search and proceed directly to offering alternative times at the same Location.

### Requirement 15: Route VIP Callers

**User Story:** As a restaurant operator, I want VIP guests to be routed directly to a staff member or concierge line, so that high-value guests receive personalized service.

#### Acceptance Criteria

1. WHEN an inbound PSTN call arrives, THE Voice_Gateway SHALL check the caller's phone number against the VIP_List before initiating a Conversation_Engine session.
2. WHEN the caller's phone number matches an entry in the VIP_List, THE Voice_Gateway SHALL transfer the call to the configured Concierge_Line using TwiML and log the transfer with the Call_Session correlation identifier.
3. IF the Concierge_Line does not answer within 30 seconds, THEN THE Voice_Gateway SHALL route the call back to the Conversation_Engine and inform the caller that a staff member is unavailable.
4. THE Voice_Gateway SHALL load the VIP_List from a configurable data source that can be updated without redeploying the application.
5. WHEN a VIP call is transferred, THE Voice_Gateway SHALL log the caller's phone number, the matched VIP_List entry, and the target Concierge_Line.

### Requirement 16: Collect Post-Call Guest Feedback

**User Story:** As a restaurant operator, I want to collect caller satisfaction feedback after calls, so that I can measure service quality and identify areas for improvement.

#### Acceptance Criteria

1. WHEN a Call_Session ends normally, THE SMS_Service SHALL send a Feedback_Survey SMS to the caller's phone number within 60 seconds of call termination.
2. THE Feedback_Survey SHALL ask the caller to reply with a CSAT_Score (1–5) and an optional text comment.
3. WHEN the caller replies to the Feedback_Survey SMS, THE Call_Analytics_Service SHALL record the CSAT_Score and comment, associated with the original Call_Session correlation identifier.
4. IF the caller does not respond to the Feedback_Survey within 24 hours, THEN THE Call_Analytics_Service SHALL record the survey as unanswered for that Call_Session.
5. WHERE the restaurant operator has disabled post-call feedback in the configuration, THE SMS_Service SHALL skip sending the Feedback_Survey.

### Requirement 17: Provide Call Analytics and Insights

**User Story:** As a restaurant operator, I want to view analytics on call volume, reservation conversions, common inquiries, and guest satisfaction, so that I can make data-driven decisions about staffing and operations.

#### Acceptance Criteria

1. THE Call_Analytics_Service SHALL record the total number of inbound calls, grouped by hour, day, and week.
2. THE Call_Analytics_Service SHALL record the number of Reservations created, modified, and canceled per day, and calculate a reservation conversion rate as the ratio of Reservations created to total calls that included a reservation inquiry.
3. THE Call_Analytics_Service SHALL categorize and count inquiry topics (e.g., hours, menu, directions, availability) per Call_Session.
4. THE Call_Analytics_Service SHALL compute an average CSAT_Score per day and per week from collected Feedback_Survey responses.
5. THE Call_Analytics_Service SHALL identify peak call time windows by calculating the top three one-hour periods with the highest call volume per week.
6. THE Call_Analytics_Service SHALL expose an API endpoint that returns analytics data in JSON format, filterable by date range and Location.

### Requirement 18: Support Customizable Voice Persona and Call Flows

**User Story:** As a restaurant operator, I want to customize the voice assistant's greeting, name, and tone, and configure call routing rules, so that the phone experience matches my restaurant's brand and operational needs.

#### Acceptance Criteria

1. THE Conversation_Engine SHALL load a Voice_Persona configuration at startup, including the assistant's name, greeting message, and tone descriptors.
2. WHEN a new Call_Session begins, THE Conversation_Engine SHALL use the configured Voice_Persona greeting as the initial spoken message to the caller.
3. THE Voice_Gateway SHALL evaluate Call_Flow rules for each inbound call to determine routing behavior based on configurable conditions including time of day, day of week, and caller phone number.
4. WHERE a Call_Flow rule specifies a direct transfer destination, THE Voice_Gateway SHALL transfer the call to the specified phone number or extension without initiating a Conversation_Engine session.
5. THE Voice_Gateway SHALL load Voice_Persona and Call_Flow configurations from a configuration file or data source that can be updated without redeploying the application.
6. IF a Call_Flow configuration contains invalid rules (e.g., overlapping time ranges, missing transfer destinations), THEN THE Voice_Gateway SHALL log a validation error at startup and fall back to the default Call_Flow that routes all calls to the Conversation_Engine.
