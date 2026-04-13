/**
 * seed-dynamodb.js
 *
 * Creates all 9 DynamoDB tables and seeds Delhi6 data:
 *   - Locations        (restaurant info + hours)
 *   - VoicePersonas    (Nova Sonic system prompt with full menu)
 *   - AvailabilitySlots (30-min slots for next 30 days)
 *   - Reservations, VIPList, CallFlowRules, CallRecords,
 *     IdempotencyKeys, FeedbackSurveys  (tables only, no seed data)
 *
 * Usage:
 *   node scripts/seed-dynamodb.js
 *   node scripts/seed-dynamodb.js --region us-west-2
 */

'use strict';

const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand, UpdateTimeToLiveCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const delhi6 = require('../src/data/delhi6.json');

const args = process.argv.slice(2);
const getArg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const REGION = getArg('--region') || process.env.AWS_REGION || 'us-east-1';

const raw    = new DynamoDBClient({ region: REGION });
const client = DynamoDBDocumentClient.from(raw);

// ─── Table definitions ────────────────────────────────────────────────────────

const TABLE_DEFS = [
  {
    TableName: 'Reservations',
    KeySchema: [{ AttributeName: 'reservationId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'reservationId', AttributeType: 'S' },
      { AttributeName: 'guestName',     AttributeType: 'S' },
      { AttributeName: 'date',          AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [{
      IndexName: 'guestName-date-index',
      KeySchema: [
        { AttributeName: 'guestName', KeyType: 'HASH' },
        { AttributeName: 'date',      KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'AvailabilitySlots',
    KeySchema: [
      { AttributeName: 'locationId', KeyType: 'HASH' },
      { AttributeName: 'date#time',  KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'locationId', AttributeType: 'S' },
      { AttributeName: 'date#time',  AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'Locations',
    KeySchema: [{ AttributeName: 'locationId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'locationId',        AttributeType: 'S' },
      { AttributeName: 'restaurantGroupId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [{
      IndexName: 'restaurantGroupId-index',
      KeySchema: [{ AttributeName: 'restaurantGroupId', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'VIPList',
    KeySchema: [{ AttributeName: 'phoneNumber', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'phoneNumber', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'CallFlowRules',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'VoicePersonas',
    KeySchema: [{ AttributeName: 'locationId', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'locationId', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'CallRecords',
    KeySchema: [{ AttributeName: 'correlationId', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'correlationId', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'IdempotencyKeys',
    KeySchema: [{ AttributeName: 'idempotencyKey', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'idempotencyKey', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
    ttlAttribute: 'ttl',
  },
  {
    TableName: 'FeedbackSurveys',
    KeySchema: [{ AttributeName: 'correlationId', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'correlationId', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
    ttlAttribute: 'timeoutAt',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tableExists(name) {
  try {
    await raw.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return false;
    throw e;
  }
}

async function waitForTable(name) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await raw.send(new DescribeTableCommand({ TableName: name }));
      if (r.Table.TableStatus === 'ACTIVE') return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Table ${name} did not become ACTIVE in time`);
}

async function createTable(def) {
  const { ttlAttribute, ...params } = def;
  await raw.send(new CreateTableCommand(params));
  await waitForTable(def.TableName);
  if (ttlAttribute) {
    await raw.send(new UpdateTimeToLiveCommand({
      TableName: def.TableName,
      TimeToLiveSpecification: { Enabled: true, AttributeName: ttlAttribute },
    }));
  }
}

// ─── Menu → system prompt ─────────────────────────────────────────────────────

function buildMenuText(menu) {
  const lines = [];
  for (const [category, data] of Object.entries(menu)) {
    lines.push(`\n${category}:`);
    const items = Array.isArray(data) ? data : data.items;
    if (data.note) lines.push(`  (${data.note})`);
    for (const item of items) {
      const tags = item.tags && item.tags.length ? ` [${item.tags.join(', ')}]` : '';
      const qty  = item.quantity ? ` (${item.quantity})` : '';
      const desc = item.description ? ` — ${item.description}` : '';
      lines.push(`  • ${item.name}${qty}: $${item.price.toFixed(2)}${tags}${desc}`);
    }
  }
  return lines.join('\n');
}

// ─── Availability slot generator ─────────────────────────────────────────────
// Generates 30-min slots for the next 30 days based on Delhi6 hours

function generateSlots(locationId, days = 30) {
  const schedule = {
    0: { open: '12:00', close: '22:00' }, // Sunday
    1: null,                               // Monday — closed
    2: { open: '11:00', close: '21:30' }, // Tuesday
    3: { open: '11:00', close: '21:30' }, // Wednesday
    4: { open: '11:00', close: '21:30' }, // Thursday
    5: { open: '12:00', close: '22:00' }, // Friday
    6: { open: '12:00', close: '22:00' }, // Saturday (assumed same as Fri/Sun)
  };

  const slots = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 1; d <= days; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const dow = date.getDay();
    const hours = schedule[dow];
    if (!hours) continue;

    const dateStr = date.toISOString().slice(0, 10);
    const [openH, openM]  = hours.open.split(':').map(Number);
    const [closeH, closeM] = hours.close.split(':').map(Number);
    let cur = openH * 60 + openM;
    const end = closeH * 60 + closeM;

    while (cur + 30 <= end) {
      const h = String(Math.floor(cur / 60)).padStart(2, '0');
      const m = String(cur % 60).padStart(2, '0');
      const timeStr = `${h}:${m}`;
      slots.push({
        locationId,
        'date#time': `${dateStr}#${timeStr}`,
        date: dateStr,
        time: timeStr,
        maxPartySize: 12,
        remainingCapacity: 12,
      });
      cur += 30;
    }
  }
  return slots;
}

// ─── Seed data builders ───────────────────────────────────────────────────────

function buildLocation() {
  const data = delhi6['Delhi6 Indian Kitchen & Bar']['Highland Village, TX'];
  return {
    locationId: 'delhi6-highland-village',
    restaurantGroupId: 'delhi6',
    name: 'Delhi6 Indian Kitchen & Bar',
    address: data.location.address,
    phone: data.location.phone,
    mapUrl: `https://maps.google.com/?q=${encodeURIComponent(data.location.address)}`,
    coordinates: { lat: 33.0918, lng: -97.0570 },
    operatingHours: {
      monday:    null,
      tuesday:   { open: '11:00', close: '21:30' },
      wednesday: { open: '11:00', close: '21:30' },
      thursday:  { open: '11:00', close: '21:30' },
      friday:    { open: '12:00', close: '22:00' },
      saturday:  { open: '12:00', close: '22:00' },
      sunday:    { open: '12:00', close: '22:00' },
    },
    menuUrl: 'https://mydelhi6.com/food-menu/',
    timezone: 'America/Chicago',
  };
}

function buildVoicePersona(location) {
  const data = delhi6['Delhi6 Indian Kitchen & Bar']['Highland Village, TX'];

  const systemPrompt = `You are a warm and knowledgeable phone host at Delhi6 Indian Kitchen & Bar in Highland Village, TX. Your name is Priya.

RESTAURANT DETAILS:
- Name: Delhi6 Indian Kitchen & Bar
- Address: ${data.location.address}
- Phone: ${data.location.phone}
- Website: https://mydelhi6.com

HOURS:
- Monday: Closed
- Tuesday–Thursday: 11:00 AM – 9:30 PM
- Friday: 12:00 PM – 10:00 PM
- Saturday–Sunday: 12:00 PM – 10:00 PM

YOUR ROLE:
- Help guests with questions about the menu, hours, and location
- Use the get_menu tool when asked about food, dishes, prices, or dietary options
- Use the get_hours tool when asked about opening times
- Use the get_location tool when asked for the address or directions
- Be warm, concise, and conversational — this is a phone call
- Speak naturally — use contractions, keep responses brief
- 20% gratuity is automatically added for parties of 5 or more`;

  return {
    locationId: 'delhi6-highland-village',
    name: 'Priya',
    greeting: "Thank you for calling Delhi6! This is Priya, how can I help you today?",
    toneDescriptors: ['warm', 'knowledgeable', 'concise', 'friendly'],
    systemPrompt,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSeeding DynamoDB in region: ${REGION}\n`);

  // 1. Create tables
  console.log('── Creating tables ──────────────────────────────────');
  for (const def of TABLE_DEFS) {
    if (await tableExists(def.TableName)) {
      console.log(`  ✓ ${def.TableName} (already exists)`);
    } else {
      process.stdout.write(`  + ${def.TableName} … `);
      await createTable(def);
      console.log('created');
    }
  }

  // 2. Seed Locations
  console.log('\n── Seeding Locations ────────────────────────────────');
  const location = buildLocation();
  await client.send(new PutCommand({ TableName: 'Locations', Item: location }));
  console.log(`  ✓ ${location.locationId} — ${location.name}`);

  // Also upsert a 'default' alias so DEFAULT_LOCATION_ID=default still works
  await client.send(new PutCommand({
    TableName: 'Locations',
    Item: { ...location, locationId: 'default' },
  }));
  console.log(`  ✓ default (alias for ${location.locationId})`);

  // 3. Seed VoicePersonas
  console.log('\n── Seeding VoicePersonas ────────────────────────────');
  const persona = buildVoicePersona(location);
  await client.send(new PutCommand({ TableName: 'VoicePersonas', Item: persona }));
  console.log(`  ✓ ${persona.locationId} — persona "${persona.name}"`);

  // Also seed as 'default' so the app picks it up immediately
  await client.send(new PutCommand({
    TableName: 'VoicePersonas',
    Item: { ...persona, locationId: 'default' },
  }));
  console.log(`  ✓ default (alias for ${persona.locationId})`);

  // 4. Seed AvailabilitySlots
  console.log('\n── Seeding AvailabilitySlots (next 30 days) ─────────');
  const slots = generateSlots('delhi6-highland-village');
  const defaultSlots = generateSlots('default');
  const allSlots = [...slots, ...defaultSlots];
  let count = 0;
  // Batch in groups of 25 (DynamoDB limit)
  for (let i = 0; i < allSlots.length; i += 25) {
    const batch = allSlots.slice(i, i + 25);
    await Promise.all(batch.map(slot =>
      client.send(new PutCommand({ TableName: 'AvailabilitySlots', Item: slot }))
    ));
    count += batch.length;
    process.stdout.write(`\r  ✓ ${count}/${allSlots.length} slots written`);
  }
  console.log(`\n  ✓ Done — ${slots.length} slots for delhi6-highland-village, ${defaultSlots.length} for default`);

  console.log('\n✅ Seed complete!\n');
  console.log('Tables created:', TABLE_DEFS.map(t => t.TableName).join(', '));
  console.log('locationId to use: delhi6-highland-village (or "default")');
}

main().catch(err => {
  console.error('\n❌ Seed failed:', err.message || err);
  process.exit(1);
});
