# Production Deployment & Demo Checklist

## Phase 1: Local Testing (ngrok)

- [ ] Copy `.env.example` to `.env` and fill in Twilio credentials
- [ ] Set `USE_LOCAL_DB=true` and `NODE_ENV=development`
- [ ] Run `npm run dev` in `maitre-ts/`
- [ ] Start ngrok: `ngrok http 8080`
- [ ] Set `HOST=<your-ngrok-subdomain>.ngrok.io` in `.env` and restart server
- [ ] Set Twilio webhook URL to `https://<ngrok-url>/voice/inbound` (HTTP POST)
- [ ] Call your Twilio number — confirm webhook hits in server logs
- [ ] Confirm WebSocket media stream connects (look for `[media-stream] Session started` in logs)
- [ ] Confirm Nova Sonic stub warning appears (expected — AI not wired yet)

---

## Phase 2: Wire Nova Sonic (AI Conversation)

- [ ] Implement real `NovaSonicClientFactory` in `src/conversation-engine/nova-sonic-client.ts`
  - Use `@aws-sdk/client-bedrock-runtime` with `InvokeModelWithBidirectionalStreamCommand`
  - Model ID: `amazon.nova-sonic-v1:0`
  - Region: `us-east-1`
- [ ] Replace `stubNovaSonicFactory` in `src/index.ts` with the real factory
- [ ] Test locally: call the number and have a conversation
- [ ] Confirm interruption handling works (talk over the AI)

---

## Phase 3: Seed Demo Data

- [ ] Create a `scripts/seed-demo-data.ts` script that populates local in-memory store (or DynamoDB) with:
  - Restaurant location (name, address, hours, menu URL, map link)
  - Sample availability slots for the next 7 days
  - Voice persona (restaurant name, greeting, tone)
- [ ] Run seed script before demo: `npx ts-node scripts/seed-demo-data.ts`
- [ ] Verify reservation creation works end-to-end (call → make reservation → get SMS)
- [ ] Verify inquiry tools work (ask about hours, menu, location)

---

## Phase 4: Production Infrastructure

- [ ] Register a domain (Route53 or external registrar, ~$3–12/yr)
- [ ] Create ACM certificate for the domain in `us-east-1`
- [ ] Update CDK stack (`maitre/infra/lib/maitre-stack.ts`):
  - Add HTTPS listener (port 443) to ALB with ACM cert
  - Add Route53 A record pointing domain to ALB
  - Update Fargate task to use `maitre-ts` Docker image instead of `maitre-java`
- [ ] Build and push `maitre-ts` Docker image to ECR:
  ```bash
  aws codebuild start-build --project-name maitre-docker-build
  ```
- [ ] Deploy updated CDK stack: `cdk deploy`
- [ ] Update Twilio webhook to `https://<your-domain>/voice/inbound`
- [ ] Update `HOST` env var in ECS task definition to `<your-domain>`
- [ ] Seed production DynamoDB tables with restaurant data
- [ ] Verify ECS service is healthy (`aws ecs describe-services --cluster maitre --services maitre`)
- [ ] Tail CloudWatch logs and make a test call

---

## Phase 5: Pre-Demo Testing Checklist

Test each of these scenarios by calling the Twilio number:

- [ ] **Basic call connects** — AI greets caller with restaurant name
- [ ] **Make a reservation** — "I'd like to book a table for 4 on Friday at 7pm"
  - Confirm AI collects name, party size, date, time
  - Confirm SMS confirmation is received
- [ ] **Modify a reservation** — "I need to change my reservation to 6 people"
  - Confirm AI finds the booking and updates it
  - Confirm SMS update is received
- [ ] **Cancel a reservation** — "I need to cancel my reservation"
  - Confirm AI cancels and sends SMS confirmation
- [ ] **Ask about hours** — "What time do you close on Sundays?"
- [ ] **Ask about the menu** — "Do you have vegetarian options?"
- [ ] **Ask for directions** — "Where are you located?"
  - Confirm SMS with address and map link is received
- [ ] **Interruption handling** — Talk over the AI mid-sentence
  - Confirm AI stops and listens
- [ ] **No availability** — Request a fully booked time
  - Confirm AI offers alternatives
- [ ] **Post-call feedback** — Wait 60 seconds after hanging up
  - Confirm feedback SMS is received
  - Reply with a rating (1–5) and confirm it's recorded

---

## Demo Script (for restaurant client)

**Setup before demo:**
- Have the Twilio number ready to call
- Have a phone that can receive SMS (the caller's number)
- Seed the demo data with the restaurant's actual name, hours, and address

**Demo flow (5 minutes):**

1. "I'm going to call the number right now — watch what happens"
2. Call → AI greets with restaurant name
3. "I'd like to make a reservation for 2 people this Saturday at 7pm, name is [name]"
   → AI confirms, SMS arrives
4. "Actually can I change that to 4 people?"
   → AI modifies, SMS arrives
5. "What are your hours on Sunday?"
   → AI reads back hours
6. "Can you send me the menu?"
   → SMS with menu link arrives
7. Hang up → 60 seconds later, feedback SMS arrives
8. Reply "5" → show that it's recorded

**Key talking points:**
- Works on any phone, no app needed
- Handles reservations 24/7 without staff
- SMS confirmations keep guests informed
- Post-call feedback helps track satisfaction
- Scales automatically — handles multiple calls at once
- All data in your AWS account, you own it
