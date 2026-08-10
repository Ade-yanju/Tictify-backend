/* Browse pagination + event-name search.

   Drives the real handleIncoming with a stub transport, so what these
   tests assert is exactly what a guest would see in WhatsApp. Runs
   against a throwaway mongod (TEST_MONGO_URI, default port 27055) and
   never touches the app database.

   Skips itself if no test mongod is reachable, so `npm test` stays
   green on a machine without one. */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27055/tictify_bot_test";

let handleIncoming, Event, WhatsAppSession, live = false;

const PHONE = "2348000000001";

/* Captures what the bot sent. `rows` is what matters for a list —
   it's the set of options a guest can actually tap. */
function stubTransport() {
  const sent = [];
  return {
    sent,
    send: async (to, body) => {
      sent.push({ kind: "text", to, body });
      return { success: true };
    },
    /* uiList/uiButtons only treat a send as delivered when it resolves
       { success: true } — returning undefined makes the bot fall back
       to plain text and the rows vanish. Mirror the real transport. */
    sendList: async (to, body, buttonText, rows) => {
      sent.push({ kind: "list", to, body, buttonText, rows });
      return { success: true };
    },
    sendButtons: async (to, body, buttons) => {
      sent.push({ kind: "buttons", to, body, buttons });
      return { success: true };
    },
    last() {
      return sent[sent.length - 1];
    },
  };
}

async function say(text) {
  const t = stubTransport();
  /* handleIncoming takes a PLAIN STRING for typed input; the object
     form is reserved for { type: "image", imageId } gate scans. */
  await handleIncoming(PHONE, text, t);
  return t;
}

/* A valid Event needs organizer/banner/location/endDate/capacity —
   one factory so every test seeds schema-valid docs. */
const ORGANIZER = new mongoose.Types.ObjectId();

function eventDoc(overrides = {}) {
  const start = overrides.date || new Date(Date.now() + 86400000);
  return {
    organizer: ORGANIZER,
    title: "Seeded Event",
    description: "seeded",
    location: "Victoria Island",
    city: "Lagos",
    date: start,
    endDate: new Date(new Date(start).getTime() + 10800000),
    banner: "https://example.test/banner.jpg",
    capacity: 500,
    status: "LIVE",
    ticketTypes: [{ name: "Regular", price: 5000, quantity: 100 }],
    ...overrides,
  };
}

/* n live events, dated so sort("date") order is deterministic. */
async function seedLive(n, prefix = "Event") {
  const base = Date.now() + 86400000;
  await Event.insertMany(
    Array.from({ length: n }, (_, i) =>
      eventDoc({
        title: `${prefix} ${String(i + 1).padStart(2, "0")}`,
        date: new Date(base + i * 3600000),
      }),
    ),
  );
}

before(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 1500 });
    live = true;
  } catch {
    console.log("• no test mongod reachable — skipping bot browse tests");
    return;
  }
  ({ handleIncoming } = await import("../src/services/whatsappBot.service.js"));
  Event = (await import("../src/models/Event.js")).default;
  WhatsAppSession = (await import("../src/models/WhatsAppSession.js")).default;
});

after(async () => {
  if (live) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(async () => {
  if (!live) return;
  await Event.deleteMany({});
  await WhatsAppSession.deleteMany({});
});

test("browse: 25 live events are ALL reachable by paging", async (t) => {
  if (!live) return t.skip();
  await seedLive(25);

  const seen = new Set();
  let page = await say("1"); // Browse events

  for (let i = 0; i < 5; i++) {
    const msg = page.last();
    assert.equal(msg.kind, "list", "browse should render an interactive list");
    assert.ok(msg.rows.length <= 10, "WhatsApp hard-caps lists at 10 rows");

    for (const r of msg.rows) {
      if (!r.title.includes("More events")) seen.add(r.title);
    }
    const more = msg.rows.find((r) => r.title.includes("More events"));
    if (!more) break;
    page = await say(more.id);
  }

  assert.equal(seen.size, 25, `every event reachable — saw ${seen.size}/25`);
});

test("browse: no phantom 'More' row on the last page", async (t) => {
  if (!live) return t.skip();
  await seedLive(9); // exactly one full page

  const msg = (await say("1")).last();
  assert.equal(msg.rows.length, 9);
  assert.ok(
    !msg.rows.some((r) => r.title.includes("More events")),
    "9 events fit one page, so no More row should be offered",
  );
});

test("browse: row numbers on page 2 map to page 2's events", async (t) => {
  if (!live) return t.skip();
  await seedLive(12);

  const p1 = (await say("1")).last();
  const more = p1.rows.find((r) => r.title.includes("More events"));
  const p2 = (await say(more.id)).last();

  assert.equal(p2.rows[0].title, "Event 10", "page 2 starts at the 10th event");

  /* Tapping "1" on page 2 must open Event 10, not Event 01 — this is
     the bug a naive global-index implementation would ship. */
  const detail = (await say("1")).last();
  assert.match(detail.body, /Event 10/);
});

test("search: typing an event name jumps straight to that event", async (t) => {
  if (!live) return t.skip();
  await seedLive(20);
  await Event.create(eventDoc({ title: "Afrobeats Night Lagos" }));

  const msg = (await say("afrobeats")).last();
  assert.match(msg.body, /Afrobeats Night Lagos/, "should land on the event itself");
});

test("search: works from inside the browse list too", async (t) => {
  if (!live) return t.skip();
  await seedLive(12);
  await Event.create(eventDoc({ title: "Detty December", city: "Abuja" }));

  await say("1"); // now BROWSING
  const msg = (await say("detty")).last();
  assert.match(msg.body, /Detty December/);
});

test("search: multiple matches offer a pick-list", async (t) => {
  if (!live) return t.skip();
  await seedLive(4, "Gospel Fest");

  const msg = (await say("gospel")).last();
  assert.equal(msg.kind, "list");
  assert.equal(msg.rows.length, 4);
  assert.match(msg.body, /match/i);
});

test("search: row numbers are never hijacked as search terms", async (t) => {
  if (!live) return t.skip();
  /* An event literally named "2" must not shadow menu option 2. */
  await Event.create(eventDoc({ title: "2" }));

  const msg = (await say("2")).last(); // menu option 2 = My tickets
  assert.doesNotMatch(
    JSON.stringify(msg),
    /Regular/,
    "digits must stay menu navigation, not a search",
  );
});

test("search: ended and draft events never surface", async (t) => {
  if (!live) return t.skip();
  await Event.insertMany([
    eventDoc({ title: "Ghost Concert", status: "DRAFT" }),
    eventDoc({ title: "Ghost Reunion", date: new Date(Date.now() - 86400000) }),
  ]);

  const msg = (await say("ghost")).last();
  assert.doesNotMatch(msg.body, /Ghost/, "only LIVE + future events are sellable");
});

test("search: regex metacharacters in input can't crash the query", async (t) => {
  if (!live) return t.skip();
  await seedLive(3);
  const msg = (await say("(((*bad[regex")).last();
  assert.ok(msg, "should answer rather than throw");
});
