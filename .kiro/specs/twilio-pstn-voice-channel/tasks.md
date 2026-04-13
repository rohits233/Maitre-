# Implementation Plan: Twilio PSTN Voice Channel

## Overview

This plan implements a telephony voice AI system using Twilio PSTN, Amazon Nova Sonic, and MCP tools, deployed on ECS Fargate with AWS-native serverless services. Tasks are ordered to build foundational components first (project setup, data models, session management), then core audio pipeline (Voice Gateway, Conversation Engine, Audio Transcoder), then MCP routing and tool servers, then services (SMS, Feedback, Analytics), then Lambda functions (Analytics API, SMS Webhook, Feedback Timeout), then configuration-driven features (VIP, Call Flow, Voice Persona), and finally infrastructure and integration wiring.

Non-latency-sensitive workloads (analytics API, SMS webhook, feedback timeout) are implemented as API Gateway + Lambda functions. Secrets are stored in AWS Secrets Manager, runtime config in SSM Parameter Store. DynamoDB access from Fargate uses a VPC Gateway Endpoint. Metrics use CloudWatch Embedded Metric Format (EMF). AWS X-Ray provides distributed tracing across Fargate tasks, Lambda functions, and DynamoDB. SMS sending supports both Amazon SNS and Twilio Messaging API as configurable providers.

## Tasks

- [x] 1. Project setup and core interfaces
  - [x] 1.1 Initialize Node.js/TypeScript project with Vitest, fast-check, Express, ws, and AWS SDK dependencies
    - Create `package.json`, `tsconfig.json`, and project directory structure (`src/`, `src/lambdas/`, `tests/unit/`, `tests/property/`, `tests/integration/`, `infra/`)
    - Install dependencies: `express`, `ws`, `twilio`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ssm`, `@aws-sdk/client-sns`, `aws-xray-sdk`, `uuid`, `fast-check`, `vitest`, `aws-embedded-metrics`
    - _Requirements: 6.1, 6.3_

  - [x] 1.2 Define all TypeScript interfaces and types
    - Create `src/types/` with interfaces for: `CallSession`, `MediaStreamMessage`, `MediaFormat`, `InboundCallRequest`, `VIPEntry`, `CallFlowRule`, `VoicePersona`, `ToolRequest`, `ToolResult`, `MCPToolConfig`, `MCPToolConnection`, `NovaSonicConnection`
    - Create `src/types/models.ts` with data model interfaces: `Reservation`, `AvailabilitySlot`, `RestaurantLocation`, `CallRecord`, `ReservationAction`, `FeedbackRecord`, `IdempotencyRecord`, `AnalyticsFilter`, `AnalyticsReport`
    - _Requirements: 1.2, 5.1, 10.1, 12.1, 17.6_

  - [x] 1.3 Implement configuration loader with Secrets Manager and SSM Parameter Store support
    - Create `src/config.ts` that reads configuration from multiple sources:
      - In production: Twilio auth token and account SID from AWS Secrets Manager, feature flags (feedback enabled, drain timeout) from SSM Parameter Store, other config from environment variables
      - In local dev: All configuration from environment variables
    - Load secrets at startup and cache in-process
    - Validate required fields are present and throw descriptive errors on missing config
    - _Requirements: 6.3, 9.4_

  - [ ]* 1.4 Write property test for configuration loading
    - **Property 10: Configuration loading from environment variables and AWS services**
    - **Validates: Requirements 6.3, 9.4**

- [x] 2. Session Manager
  - [x] 2.1 Implement Session Manager with in-memory session store and EventEmitter
    - Create `src/session/session-manager.ts` implementing `SessionManager` interface
    - Support `createSession`, `getSession`, `terminateSession`, `getActiveSessions`
    - Emit events: `session:created`, `session:terminated`, `reservation:completed`, `inquiry:completed`
    - Assign unique correlation ID (UUID) to each session
    - _Requirements: 1.2, 1.4, 5.1, 5.2, 8.4_

  - [ ]* 2.2 Write property test for Call_Session initialization
    - **Property 2: Call_Session initialization contains all required fields**
    - **Validates: Requirements 1.2, 5.1, 8.4**

  - [ ]* 2.3 Write property test for concurrent session independence
    - **Property 3: Concurrent sessions are independent**
    - **Validates: Requirements 1.4**

  - [ ]* 2.4 Write property test for session termination on stop event
    - **Property 9: Session termination on stop event**
    - **Validates: Requirements 5.2**

  - [ ]* 2.5 Write property test for session log records
    - **Property 11: Session log records contain required fields**
    - **Validates: Requirements 8.1, 8.4**

  - [ ]* 2.6 Write property test for metrics emission
    - **Property 12: Metrics emission for session activity**
    - **Validates: Requirements 8.2**

  - [ ]* 2.7 Write property test for no audio persistence after termination
    - **Property 14: No audio persistence after session termination**
    - **Validates: Requirements 9.3**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Audio Transcoder
  - [x] 4.1 Implement Audio Transcoder for mulaw 8kHz ↔ Nova Sonic format conversion
    - Create `src/conversation-engine/audio-transcoder.ts` implementing `AudioTranscoder` interface
    - Implement `mulawToNovaSonic` and `novaSonicToMulaw` as synchronous pure functions
    - Ensure transcoding completes in <5ms per chunk
    - _Requirements: 2.1, 2.2_

  - [ ]* 4.2 Write property test for audio transcoding round trip
    - **Property 4: Audio transcoding round trip**
    - **Validates: Requirements 2.1, 2.2**

- [x] 5. Voice Gateway - Webhook Handler and Media Stream Server
  - [x] 5.1 Implement Twilio signature validation middleware
    - Create `src/voice-gateway/signature-validator.ts` using Twilio's `validateRequest` utility
    - Reject invalid signatures with 403 and log the attempt
    - _Requirements: 9.1_

  - [ ]* 5.2 Write property test for Twilio signature validation
    - **Property 13: Twilio signature validation**
    - **Validates: Requirements 9.1**

  - [x] 5.3 Implement webhook handler (`POST /voice/inbound`)
    - Create `src/voice-gateway/webhook-handler.ts`
    - Validate Twilio signature, check VIP list, evaluate Call Flow rules
    - Return TwiML `<Connect><Stream>` for normal calls, `<Dial>` for VIP/transfer, or `<Say>` + `<Hangup>` on error
    - _Requirements: 1.1, 1.3, 15.1, 15.2, 18.3, 18.4_

  - [ ]* 5.4 Write property test for inbound call TwiML
    - **Property 1: Inbound call TwiML contains Media Stream connection**
    - **Validates: Requirements 1.1**

  - [x] 5.5 Implement WebSocket Media Stream server (`/media-stream`)
    - Create `src/voice-gateway/media-stream-server.ts`
    - Accept WSS connections, parse `connected`, `start`, `media`, `stop`, `mark` events
    - On `start`: create Call_Session via Session Manager
    - On `media`: transcode and forward audio to Conversation Engine
    - On `stop`: terminate Call_Session
    - Send `clear` messages on interruption, send heartbeat/mark messages for keepalive
    - _Requirements: 1.2, 2.1, 2.2, 3.1, 3.2, 5.1, 5.2, 5.3, 5.4_

  - [ ]* 5.6 Write property test for interruption handling
    - **Property 5: Interruption clears output and sends flush**
    - **Validates: Requirements 3.1, 3.2**

  - [x] 5.7 Implement health check endpoint (`GET /health`)
    - Create health check route returning 200 when healthy, 503 when draining
    - _Requirements: 7.2_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Conversation Engine
  - [x] 7.1 Implement Conversation Engine with Nova Sonic bidirectional WebSocket streaming
    - Create `src/conversation-engine/conversation-engine.ts` implementing `ConversationEngine` interface
    - Manage persistent bidirectional WSS connection to Nova Sonic per Call_Session
    - Implement `startSession` (open Nova Sonic WSS, send system prompt from Voice Persona), `sendAudio`, `onAudioOutput`, `onInterruption`, `onToolRequest`, `endSession`
    - Handle Nova Sonic disconnect with reconnection within 3 seconds; if failed, play error and end call
    - _Requirements: 2.3, 2.4, 3.3, 18.2_

  - [x] 7.2 Implement Interruption Handler
    - Create `src/conversation-engine/interruption-handler.ts`
    - On interruption event from Nova Sonic: invoke callback to Voice Gateway, reset audio output buffer, begin processing new utterance within 200ms
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ]* 7.3 Write property test for Voice Persona greeting at session start
    - **Property 37: Voice_Persona greeting used at session start**
    - **Validates: Requirements 18.2**

- [x] 8. MCP Router
  - [x] 8.1 Implement MCP Router with WebSocket and stdio transport support
    - Create `src/mcp-router/mcp-router.ts` implementing `MCPRouter` interface
    - Support `registerTool`, `connect` (establish persistent WSS or stdio connection), `dispatch`, `loadConfig`, `disconnectAll`
    - Implement 10-second timeout per tool invocation
    - Auto-reconnect on connection drop, queue pending requests with timeout
    - Forward errors from tool servers as `ToolResult` with `success: false`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 8.2 Write property test for MCP tool dispatch routing
    - **Property 6: MCP tool dispatch routes to correct server**
    - **Validates: Requirements 4.1**

  - [ ]* 8.3 Write property test for MCP tool error forwarding
    - **Property 7: MCP tool errors are forwarded**
    - **Validates: Requirements 4.4**

  - [ ]* 8.4 Write property test for MCP tool configuration loading
    - **Property 8: MCP tool configuration loading**
    - **Validates: Requirements 4.5**

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Reservation Tool Server
  - [x] 10.1 Implement Reservation Tool MCP server
    - Create `src/tools/reservation-tool/server.ts` as an MCP tool server (WSS/stdio)
    - Implement tools: `create_reservation`, `modify_reservation`, `cancel_reservation`, `get_reservation`, `check_availability`, `check_group_availability`
    - Validate inputs: positive party size, future date, time within operating hours
    - Return descriptive errors naming invalid fields
    - Enforce idempotency via `idempotencyKey` stored in DynamoDB with 24h TTL
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 12.1, 12.2, 12.4, 12.5, 12.6, 14.1_

  - [x] 10.2 Implement DynamoDB data access layer for Reservations and Availability
    - Create `src/tools/reservation-tool/repository.ts`
    - Implement CRUD operations for `Reservations` table, query operations for `AvailabilitySlots` table, idempotency check/store for `IdempotencyKeys` table
    - Support GSI queries: by locationId+date, guestName+date, callerPhone+date
    - _Requirements: 10.1, 10.2, 10.3, 12.1, 12.2, 12.6_

  - [x] 10.3 Implement cross-location availability query
    - Add `check_group_availability` logic querying all locations in a Restaurant_Group via `restaurantGroupId` GSI
    - Cap alternatives at 3 results, include location name, address, and available times
    - Skip cross-location search for single-location restaurants
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ]* 10.4 Write property test for reservation creation with valid data
    - **Property 15: Reservation creation with valid data**
    - **Validates: Requirements 10.1**

  - [ ]* 10.5 Write property test for reservation modification preserves identity
    - **Property 16: Reservation modification preserves identity**
    - **Validates: Requirements 10.2**

  - [ ]* 10.6 Write property test for reservation cancellation marks status
    - **Property 17: Reservation cancellation marks status**
    - **Validates: Requirements 10.3**

  - [ ]* 10.7 Write property test for alternative slots when unavailable
    - **Property 18: Alternative slots offered when unavailable**
    - **Validates: Requirements 10.5, 14.1**

  - [ ]* 10.8 Write property test for reservation data validation
    - **Property 21: Reservation data validation**
    - **Validates: Requirements 12.4, 12.5**

  - [ ]* 10.9 Write property test for reservation idempotency
    - **Property 22: Reservation idempotency**
    - **Validates: Requirements 12.6**

  - [ ]* 10.10 Write property test for availability query returns only fitting slots
    - **Property 20: Availability query returns only fitting slots**
    - **Validates: Requirements 11.4, 12.2**

  - [ ]* 10.11 Write property test for cross-location alternatives capped at three
    - **Property 25: Cross-location alternatives capped at three**
    - **Validates: Requirements 14.2**

  - [ ]* 10.12 Write property test for single-location skips cross-location search
    - **Property 26: Single-location skips cross-location search**
    - **Validates: Requirements 14.5**

- [x] 11. Inquiry Tool Server
  - [x] 11.1 Implement Inquiry Tool MCP server
    - Create `src/tools/inquiry-tool/server.ts` as an MCP tool server (WSS/stdio)
    - Implement tools: `get_hours`, `get_menu`, `get_location`
    - Query `Locations` DynamoDB table for restaurant data
    - _Requirements: 11.1, 11.2, 11.3, 12.3_

  - [x] 11.2 Implement DynamoDB data access layer for Locations
    - Create `src/tools/inquiry-tool/repository.ts`
    - Implement queries for `Locations` table by `locationId` and `restaurantGroupId` GSI
    - _Requirements: 12.3_

  - [ ]* 11.3 Write property test for Inquiry Tool returns requested information
    - **Property 19: Inquiry_Tool returns requested information**
    - **Validates: Requirements 11.1, 11.2, 11.3**

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. SMS Service
  - [x] 13.1 Implement SMS Service using Twilio Messaging API
    - Create `src/services/sms-service.ts` implementing `SMSService` interface
    - Implement: `sendReservationConfirmation`, `sendReservationUpdate`, `sendCancellationConfirmation`, `sendDirections`, `sendMenuLink`, `sendFeedbackSurvey`
    - Subscribe to Session Manager events (`reservation:completed`, `inquiry:completed`) via EventEmitter
    - Send asynchronously with 30-second SLA, log failures with correlation ID and Twilio error code
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [ ]* 13.2 Write property test for reservation SMS content
    - **Property 23: Reservation SMS contains required details**
    - **Validates: Requirements 13.1, 13.2, 13.3**

  - [ ]* 13.3 Write property test for info-request SMS content
    - **Property 24: Info-request SMS contains relevant content**
    - **Validates: Requirements 13.4, 13.5**

- [x] 14. Feedback Service (in-process survey sending only)
  - [x] 14.1 Implement Feedback Service for sending surveys on call end
    - Create `src/services/feedback-service.ts` implementing `FeedbackService` interface
    - Implement `sendSurvey` (triggered on session end via EventEmitter)
    - Write feedback record to `FeedbackSurveys` DynamoDB table with TTL set to 24 hours
    - Respect configuration flag for enabling/disabling post-call feedback
    - Note: Survey response handling is in the SMS Webhook Lambda (task 16.2), timeout handling is in the Feedback Timeout Lambda (task 16.3)
    - _Requirements: 16.1, 16.2, 16.5_

  - [ ]* 14.2 Write property test for feedback survey conditional sending
    - **Property 28: Feedback survey conditional sending**
    - **Validates: Requirements 16.1, 16.5**

- [x] 15. Call Analytics Service (in-process recording only)
  - [x] 15.1 Implement Call Analytics Service for recording call data to DynamoDB
    - Create `src/services/analytics-service.ts` implementing `CallAnalyticsService` interface
    - Implement `recordCallStart`, `recordCallEnd`, `recordReservationAction`, `recordInquiryTopic`, `recordFeedback`
    - Store call records in `CallRecords` DynamoDB table
    - Subscribe to Session Manager events for automatic recording
    - Note: Analytics querying/aggregation is in the Analytics API Lambda (task 16.1)
    - _Requirements: 17.1, 17.2, 17.3_

- [x] 16. Lambda Functions (API Gateway + Lambda, DynamoDB Streams + Lambda)
  - [x] 16.1 Implement Analytics API Lambda
    - Create `src/lambdas/analytics-api.ts` as an API Gateway Lambda handler
    - Accept `GET /api/analytics` with query params: `startDate`, `endDate`, `locationId` (optional)
    - Query `CallRecords` DynamoDB table and compute aggregations: calls by hour/day/week, reservation conversion rate, inquiry topic counts, average CSAT daily/weekly, peak call hours (top 3)
    - Return JSON response matching `AnalyticsReport` interface
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

  - [x] 16.2 Implement SMS Webhook Lambda for feedback responses
    - Create `src/lambdas/sms-webhook.ts` as an API Gateway Lambda handler
    - Accept `POST /sms/inbound` from Twilio SMS webhooks
    - Validate Twilio request signature using auth token from Secrets Manager
    - Parse CSAT score (1-5) and optional comment from SMS body
    - Match response to original Call_Session via caller phone number GSI on `FeedbackSurveys` table
    - Record feedback in `CallRecords` table, delete `FeedbackSurveys` record
    - _Requirements: 16.3_

  - [x] 16.3 Implement Feedback Timeout Lambda (DynamoDB Streams trigger)
    - Create `src/lambdas/feedback-timeout.ts` as a DynamoDB Streams Lambda handler
    - Triggered by REMOVE events on `FeedbackSurveys` table (TTL expiry)
    - Filter for TTL-deleted records (userIdentity.type === 'Service')
    - Check if feedback was already answered; if not, mark as `unanswered` in `CallRecords` table
    - _Requirements: 16.4_

  - [ ]* 16.4 Write property test for feedback response recording
    - **Property 29: Feedback response recording**
    - **Validates: Requirements 16.3**

  - [ ]* 16.5 Write property test for feedback timeout marks unanswered
    - **Property 40: Feedback timeout marks unanswered via DynamoDB Streams**
    - **Validates: Requirements 16.4**

  - [ ]* 16.6 Write property test for call volume aggregation
    - **Property 30: Call volume aggregation**
    - **Validates: Requirements 17.1**

  - [ ]* 16.7 Write property test for reservation conversion rate
    - **Property 31: Reservation conversion rate calculation**
    - **Validates: Requirements 17.2**

  - [ ]* 16.8 Write property test for inquiry topic categorization
    - **Property 32: Inquiry topic categorization**
    - **Validates: Requirements 17.3**

  - [ ]* 16.9 Write property test for average CSAT calculation
    - **Property 33: Average CSAT calculation**
    - **Validates: Requirements 17.4**

  - [ ]* 16.10 Write property test for peak call hours identification
    - **Property 34: Peak call hours identification**
    - **Validates: Requirements 17.5**

  - [ ]* 16.11 Write property test for analytics API filtering
    - **Property 35: Analytics API filtering**
    - **Validates: Requirements 17.6**

- [x] 17. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. VIP Router
  - [x] 18.1 Implement VIP Router
    - Create `src/voice-gateway/vip-router.ts` implementing `VIPRouter` interface
    - Load VIP list from DynamoDB `VIPList` table (or config file in local dev)
    - Implement `isVIP` lookup by caller phone number (E.164), `refreshList` for periodic reload
    - _Requirements: 15.1, 15.2, 15.4, 15.5_

  - [ ]* 18.2 Write property test for VIP caller routing
    - **Property 27: VIP caller routing**
    - **Validates: Requirements 15.1, 15.2, 15.5**

- [x] 19. Call Flow Evaluator
  - [x] 19.1 Implement Call Flow Evaluator
    - Create `src/voice-gateway/call-flow-evaluator.ts` implementing `CallFlowEvaluator` interface
    - Load rules from DynamoDB `CallFlowRules` table (or config file in local dev)
    - Evaluate rules in priority order, return first matching rule
    - Validate rules at startup: detect overlapping time ranges, missing transfer destinations
    - On invalid config: log validation error, fall back to default route-to-Conversation_Engine
    - _Requirements: 18.3, 18.4, 18.5, 18.6_

  - [ ]* 19.2 Write property test for call flow rule evaluation
    - **Property 38: Call flow rule evaluation**
    - **Validates: Requirements 18.3, 18.4**

  - [ ]* 19.3 Write property test for invalid call flow configuration fallback
    - **Property 39: Invalid call flow configuration fallback**
    - **Validates: Requirements 18.6**

- [x] 20. Voice Persona
  - [x] 20.1 Implement Voice Persona configuration loader
    - Create `src/voice-gateway/voice-persona.ts`
    - Load Voice Persona from DynamoDB `VoicePersonas` table (or config file in local dev)
    - Populate `VoicePersona` object with name, greeting, tone descriptors, system prompt
    - _Requirements: 18.1, 18.2, 18.5_

  - [ ]* 20.2 Write property test for Voice Persona configuration loading
    - **Property 36: Voice_Persona configuration loading**
    - **Validates: Requirements 18.1**

- [x] 21. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 22. Application wiring and Express server (Fargate task only)
  - [x] 22.1 Wire all components together in the main application entry point
    - Create `src/index.ts` that initializes and wires: Express server, WebSocket server, Session Manager, Conversation Engine, Audio Transcoder, MCP Router, VIP Router, Call Flow Evaluator, Voice Persona, SMS Service, Feedback Service, Call Analytics Service
    - Register routes: `POST /voice/inbound`, `GET /health`
    - Mount WebSocket server at `/media-stream`
    - Connect MCP Router to Reservation and Inquiry tool servers at startup
    - Subscribe services to Session Manager events
    - Load secrets from Secrets Manager and config from SSM Parameter Store at startup (cache in-process)
    - Note: Analytics API (`GET /api/analytics`) and SMS webhook (`POST /sms/inbound`) are NOT on the Fargate task — they are API Gateway + Lambda (see task 16)
    - _Requirements: 1.1, 1.2, 4.1, 6.1, 7.2_

  - [x] 22.2 Implement graceful shutdown handler (SIGTERM)
    - Stop accepting new calls, set health check to draining
    - Wait for active Call_Sessions to complete (configurable drain timeout from SSM Parameter Store)
    - Disconnect all MCP tool server connections
    - Exit cleanly
    - _Requirements: 7.4, 7.5_

  - [x] 22.3 Implement CloudWatch metrics publishing using Embedded Metric Format (EMF)
    - Use `aws-embedded-metrics` library to publish metrics via structured log lines
    - Publish `ActiveConnections` metric per task (used by auto-scaling)
    - Publish `AudioLatencyMs`, `MCPToolInvocationCount`, `MCPToolLatencyMs`, `CallSessionDuration`
    - Tag all metrics with correlation ID where applicable
    - No direct `PutMetricData` API calls — CloudWatch extracts metrics from EMF log lines automatically
    - _Requirements: 8.2_

  - [x] 22.4 Implement structured logging with correlation ID
    - Create logging utility that includes correlation ID in all log entries
    - Log call start/end with call SID, caller phone, duration, termination reason
    - Log errors with call SID and context
    - _Requirements: 8.1, 8.3, 8.4_

- [x] 23. Dockerfile and local development setup
  - [x] 23.1 Create Dockerfile for the Node.js application
    - Multi-stage build: build TypeScript, then run with minimal Node.js image
    - Expose port 8080
    - Set `SIGTERM` as stop signal
    - _Requirements: 7.1_

  - [x] 23.2 Create local development configuration
    - Create `.env.example` with all required environment variables (including placeholders for Twilio credentials that would come from Secrets Manager in prod)
    - Create `docker-compose.yml` with local DynamoDB, the application, and ngrok sidecar
    - Document single-command local startup
    - Config loader uses env vars in local dev (no Secrets Manager/SSM dependency locally)
    - _Requirements: 6.1, 6.2, 6.4_

- [x] 24. AWS CDK Infrastructure
  - [x] 24.1 Initialize CDK project and implement VPC stack with DynamoDB VPC Endpoint
    - Create `infra/` CDK project with TypeScript
    - Define VPC with 2 AZs, public/private subnets, NAT Gateway
    - Define DynamoDB Gateway VPC Endpoint (Fargate → DynamoDB without NAT traversal)
    - Define security groups for ALB and Fargate tasks
    - _Requirements: 7.1, 7.2_

  - [x] 24.2 Implement Secrets Manager and SSM Parameter Store resources
    - Define Secrets Manager secret for Twilio credentials (`voice-gateway/twilio`)
    - Define SSM Parameter Store parameters: `/voice-gateway/feedback-enabled`, `/voice-gateway/drain-timeout-ms`
    - _Requirements: 9.4_

  - [x] 24.3 Implement DynamoDB tables stack
    - Define all DynamoDB tables: `Reservations`, `AvailabilitySlots`, `Locations`, `VIPList`, `CallFlowRules`, `VoicePersonas`, `CallRecords`, `IdempotencyKeys`, `FeedbackSurveys`
    - Configure partition keys, sort keys, and GSIs per the data model design
    - Set TTL on `IdempotencyKeys` and `FeedbackSurveys` tables
    - Enable DynamoDB Streams (OLD_IMAGE) on `FeedbackSurveys` table for the Feedback Timeout Lambda
    - _Requirements: 12.1, 12.2, 12.6, 16.4, 17.1_

  - [x] 24.4 Implement ECS Fargate stack with ALB
    - Define ECR repository, ECS Cluster, Fargate Task Definition (1 vCPU, 2GB, ARM64)
    - Define container with port 8080, CloudWatch log group `/ecs/voice-gateway`, stop timeout 300s
    - Define ALB with idle timeout 3600s, HTTPS listener, target group with deregistration delay 300s and `/health` health check
    - Define Fargate Service with desired count 2, attach to target group
    - Define IAM task role with Bedrock, DynamoDB, CloudWatch Logs, Secrets Manager (`secretsmanager:GetSecretValue`), and SSM (`ssm:GetParameter`) permissions
    - Pass `SECRET_ARN` and `SSM_PREFIX` as container environment variables
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 24.5 Implement auto-scaling policies
    - CPU-based scaling: target 60%, scale-out cooldown 60s, scale-in cooldown 300s
    - Connection-based step scaling using custom `ActiveConnections` metric (published via EMF)
    - Min capacity 2, max capacity 20
    - _Requirements: 7.4_

  - [x] 24.6 Implement API Gateway + Lambda stack
    - Define API Gateway REST API (`Voice Gateway API`)
    - Define Analytics API Lambda (`src/lambdas/analytics-api.ts`): Node.js 20, ARM64, 256MB, 30s timeout
    - Define SMS Webhook Lambda (`src/lambdas/sms-webhook.ts`): Node.js 20, ARM64, 256MB, 10s timeout
    - Define Feedback Timeout Lambda (`src/lambdas/feedback-timeout.ts`): Node.js 20, ARM64, 256MB, 30s timeout
    - Wire API Gateway routes: `GET /api/analytics` → Analytics Lambda, `POST /sms/inbound` → SMS Webhook Lambda
    - Wire DynamoDB Streams event source on `FeedbackSurveys` table → Feedback Timeout Lambda (filter REMOVE events from TTL)
    - Grant Lambda IAM permissions: DynamoDB read/write, Secrets Manager read (SMS Webhook Lambda only)
    - _Requirements: 16.3, 16.4, 17.6_

- [ ] 25. Integration wiring and end-to-end tests
  - [ ]* 25.1 Write integration test for Twilio webhook → TwiML response flow
    - Test inbound call webhook returns correct TwiML for normal, VIP, and transfer scenarios
    - Test signature validation rejects invalid requests
    - _Requirements: 1.1, 9.1, 15.1, 15.2, 18.3, 18.4_

  - [ ]* 25.2 Write integration test for call session lifecycle flow
    - Test WebSocket connection → session creation → audio forwarding → stop event → session cleanup
    - Verify Session Manager events are emitted correctly
    - Verify services (SMS, Feedback, Analytics) receive events
    - _Requirements: 1.2, 5.1, 5.2, 5.3, 13.7, 16.1_

  - [ ]* 25.3 Write integration test for reservation flow through MCP
    - Test create, modify, cancel reservation via MCP Router → Reservation Tool → DynamoDB (local)
    - Verify SMS confirmation is triggered
    - Verify analytics records the reservation action
    - _Requirements: 10.1, 10.2, 10.3, 12.1, 13.1, 17.2_

  - [ ]* 25.4 Write integration test for Lambda functions
    - Test Analytics API Lambda with mock DynamoDB data, verify JSON response matches AnalyticsReport
    - Test SMS Webhook Lambda with mock Twilio payload, verify feedback recorded in CallRecords
    - Test Feedback Timeout Lambda with mock DynamoDB Streams REMOVE event, verify unanswered marking
    - _Requirements: 16.3, 16.4, 17.6_

- [x] 26. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (40 properties covered)
- The design uses TypeScript throughout — all code examples and implementations use TypeScript
- Local development uses docker-compose with DynamoDB Local; production uses ECS Fargate with CDK
- Non-latency-sensitive endpoints (analytics API, SMS webhook) run as API Gateway + Lambda, not on Fargate tasks
- Feedback 24h timeout uses DynamoDB Streams + Lambda instead of in-process timers (survives Fargate task restarts)
- Secrets (Twilio credentials) are in AWS Secrets Manager; runtime config (feature flags) is in SSM Parameter Store
- DynamoDB access from Fargate uses a VPC Gateway Endpoint (lower latency, no NAT costs)
- Custom metrics use CloudWatch Embedded Metric Format (EMF) instead of direct PutMetricData API calls
