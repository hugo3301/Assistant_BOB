import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { CalendarSync } from "../src/calendars/engine.mjs";
import { canonical, fromGoogle, digest } from "../src/calendars/model.mjs";
import {
  seal,
  unseal,
  signTicket,
  readTicket,
} from "../src/calendars/security.mjs";
import { davUrl } from "../src/calendars/yandex.mjs";
import { parseXml, davResponses, textAt } from "../src/calendars/xml.mjs";
import { icalEvents, writeIcal, davId } from "../src/calendars/ical-events.mjs";
const NOW = "2026-11-05T00:00:00.000Z",
  FUTURE = "2026-11-06T09:00:00.000Z";
class Calendar {
  constructor() {
    this.events = new Map();
    this.writes = [];
    this.version = 0;
    this.omit = false;
    this.failure = null;
  }
  add(id, patch = {}) {
    const value = {
      id,
      resource: id,
      etag: '"' + ++this.version + '"',
      body: canonical({ title: "Встреча", at: FUTURE, duration: 60, ...patch }),
    };
    this.events.set(id, value);
    return value;
  }
  async list() {
    if (this.failure) throw this.failure;
    return this.omit ? [] : structuredClone([...this.events.values()]);
  }
  async get(_calendar, id) {
    return structuredClone(this.events.get(id) ?? null);
  }
  async write(_calendar, remote, body, { create } = {}) {
    const current = this.events.get(remote.id);
    if (create && current) return current;
    if (!create && current?.etag !== remote.etag)
      throw Object.assign(Error("Changed"), { code: "CALENDAR_CONFLICT" });
    this.writes.push({ id: remote.id, body, create });
    return this.add(remote.id, body);
  }
}
function setup() {
  const store = new Store();
  store.ensureUser("alice");
  store.ensureUser("bob");
  const adapter = new Calendar(),
    sync = new CalendarSync(store, "alice", {
      adapter: async () => adapter,
      clock: () => NOW,
    }),
    id = sync.create("google", "synthetic encrypted credentials");
  sync.activate(
    id,
    { id: "chosen", label: "Рабочий", writable: true },
    { defaultCalendar: true },
  );
  return { store, adapter, sync, id };
}
function local(store, id = "event-local", patch = {}) {
  store.putItem(
    {
      id,
      owner: "alice",
      kind: "event",
      title: "Новая встреча",
      at: FUTURE,
      day: "2026-11-06",
      duration: 30,
      ...patch,
    },
    NOW,
    60,
  );
  return store.item("alice", id);
}
test("unchanged calendar polling does not rewrite every item or reminder", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    for (let index = 0; index < 100; index++) adapter.add("remote-" + index);
    await sync.sync(id, { force: true });
    const before = store.db.prepare("SELECT total_changes() AS n").get().n;
    await sync.sync(id, { force: true });
    const after = store.db.prepare("SELECT total_changes() AS n").get().n;
    assert.ok(after - before <= 2);
    assert.equal(store.items("alice").length, 100);
  } finally {
    store.close();
  }
});

test("calendar credentials and setup tickets are bound to owner, purpose, expiry and integrity", () => {
  const key = "a".repeat(64),
    encrypted = seal(key, "alice|google|one", {
      refresh_token: "synthetic-private-token",
    });
  assert.ok(!encrypted.includes("synthetic-private-token"));
  assert.deepEqual(unseal(key, "alice|google|one", encrypted), {
    refresh_token: "synthetic-private-token",
  });
  assert.throws(() => unseal(key, "bob|google|one", encrypted));
  const ticket = signTicket(key, "123", "setup", "b".repeat(48), NOW);
  assert.equal(readTicket(key, ticket, NOW).owner, "123");
  assert.throws(() => readTicket(key, ticket + "x", NOW));
  assert.throws(() => readTicket(key, ticket, "2026-11-05T00:11:00.000Z"));
});
test("initial pull isolates users and repeated sync does not duplicate events or reminders", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    const before = store.pendingReminders("alice").length;
    await sync.sync(id, { force: true });
    assert.equal(store.items("alice").length, 1);
    assert.equal(store.items("bob").length, 0);
    assert.equal(store.pendingReminders("alice").length, before);
    assert.equal(adapter.writes.length, 0);
  } finally {
    store.close();
  }
});
test("new BOB events export once, while old items, ICS imports, tasks and other providers do not get bulk-uploaded", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    local(store);
    store.putItem(
      {
        id: "event-old",
        owner: "alice",
        kind: "event",
        title: "Старое",
        at: FUTURE,
        day: "2026-11-06",
      },
      "2026-11-04T00:00:00.000Z",
      60,
    );
    local(store, "ical-import", { source_key: "uid|single" });
    store.putItem(
      {
        id: "task-one",
        owner: "alice",
        kind: "task",
        title: "Задача",
        day: "2026-11-07",
      },
      NOW,
      60,
    );
    await sync.sync(id, { force: true });
    await sync.sync(id, { force: true });
    assert.equal(adapter.writes.length, 1);
    assert.equal(store.items("alice").length, 4);
    assert.equal(adapter.writes[0].body.title, "Новая встреча");
  } finally {
    store.close();
  }
});
test("local moves and cancellations write conditional changes; remote moves update local reminder version", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    const item = store.items("alice")[0];
    store.changeItem(
      "alice",
      item.id,
      { at: "2026-11-07T09:00:00.000Z", day: "2026-11-07" },
      NOW,
    );
    await sync.sync(id, { force: true });
    assert.equal(
      adapter.events.get("remote").body.at,
      "2026-11-07T09:00:00.000Z",
    );
    adapter.add("remote", {
      title: "Новое название",
      at: "2026-11-08T09:00:00.000Z",
    });
    await sync.sync(id, { force: true });
    assert.equal(store.item("alice", item.id).title, "Новое название");
    assert.equal(
      store
        .pendingReminders("alice")
        .filter((value) => value.status === "pending").length,
      1,
    );
    store.changeItem("alice", item.id, { status: "cancelled" }, NOW);
    await sync.sync(id, { force: true });
    assert.equal(adapter.events.get("remote").body.status, "cancelled");
    assert.equal(
      store
        .pendingReminders("alice")
        .filter((value) => value.status === "pending").length,
      0,
    );
  } finally {
    store.close();
  }
});
test("missing from a range is fetched before deletion; an event moved beyond the horizon remains a real event", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    adapter.add("remote", { at: "2027-11-06T09:00:00.000Z" });
    adapter.omit = true;
    await sync.sync(id, { force: true });
    assert.equal(store.items("alice")[0].at, "2027-11-06T09:00:00.000Z");
    adapter.events.delete("remote");
    sync.clock = () => "2026-11-06T00:01:00.000Z";
    await sync.sync(id, { force: true });
    assert.equal(store.items("alice").length, 0);
  } finally {
    store.close();
  }
});
test("concurrent edits retain both versions; choosing remote resolves without an outbound overwrite", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    const item = store.items("alice")[0];
    store.changeItem("alice", item.id, { title: "BOB версия" }, NOW);
    adapter.add("remote", { title: "Версия Google" });
    await sync.sync(id, { force: true });
    assert.equal(sync.pending().length, 1);
    assert.equal(store.item("alice", item.id).title, "BOB версия");
    assert.equal(adapter.writes.length, 0);
    await sync.resolve(sync.pending()[0].id, "remote");
    assert.equal(sync.pending().length, 0);
    assert.equal(store.item("alice", item.id).title, "Версия Google");
    assert.equal(adapter.writes.length, 0);
  } finally {
    store.close();
  }
});
test("choosing local uses the latest ETag; stale conflict choices do not overwrite new edits", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    const item = store.items("alice")[0];
    store.changeItem("alice", item.id, { title: "BOB версия" }, NOW);
    adapter.add("remote", { title: "Версия календаря" });
    await sync.sync(id, { force: true });
    const conflict = sync.pending()[0].id;
    adapter.add("remote", { title: "Ещё одна версия" });
    await assert.rejects(
      sync.resolve(conflict, "local"),
      (error) => error.code === "CALENDAR_CONFLICT_STALE",
    );
    assert.equal(adapter.writes.length, 0);
    await sync.resolve(conflict, "local");
    assert.equal(adapter.events.get("remote").body.title, "BOB версия");
    assert.equal(sync.pending().length, 0);
  } finally {
    store.close();
  }
});
test("crash after remote creation is recovered by deterministic IDs, with no duplicate import", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    local(store);
    const clean = sync.clean.bind(sync);
    let interrupted = false;
    sync.clean = (...args) => {
      if (!interrupted) {
        interrupted = true;
        throw Error("simulated crash");
      }
      return clean(...args);
    };
    await assert.rejects(sync.sync(id, { force: true }));
    assert.equal(adapter.events.size, 1);
    sync.clean = clean;
    await sync.sync(id, { force: true });
    assert.equal(adapter.events.size, 1);
    assert.equal(store.items("alice").length, 1);
    assert.equal(adapter.writes.length, 1);
  } finally {
    store.close();
  }
});
test("a partial or failed remote snapshot cannot cancel the local calendar", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    adapter.failure = Error("network unavailable");
    await assert.rejects(sync.sync(id, { force: true }));
    assert.equal(store.items("alice").length, 1);
    assert.equal(adapter.writes.length, 0);
  } finally {
    store.close();
  }
});
test("disconnect clears credentials and stops sync without deleting local or external items", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("remote");
    await sync.sync(id, { force: true });
    sync.disconnect(id);
    assert.equal(sync.connection(id).credentials, null);
    assert.equal((await sync.sync(id, { force: true })).skipped, true);
    assert.equal(store.items("alice").length, 1);
    assert.equal(adapter.events.size, 1);
    assert.equal(adapter.writes.length, 0);
  } finally {
    store.close();
  }
});
test("an edit made while a remote write is in flight stays dirty for the next sync", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    local(store);
    await sync.sync(id, { force: true });
    const original = adapter.write.bind(adapter);
    let once = true;
    adapter.write = async (...args) => {
      const value = await original(...args);
      if (once) {
        once = false;
        store.changeItem("alice", "event-local", { title: "Ещё новее" }, NOW);
      }
      return value;
    };
    store.changeItem("alice", "event-local", { title: "Первая правка" }, NOW);
    await sync.sync(id, { force: true });
    await sync.sync(id, { force: true });
    assert.equal([...adapter.events.values()][0].body.title, "Ещё новее");
    assert.equal(sync.pending().length, 0);
  } finally {
    store.close();
  }
});
test("all-day multi-day events survive round trips and moves without inventing a time", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("trip", { at: null, day: "2026-11-07", end_day: "2026-11-10" });
    await sync.sync(id, { force: true });
    const item = store.items("alice")[0];
    assert.equal(item.at, null);
    assert.equal(item.end_day, "2026-11-10");
    store.changeItem("alice", item.id, { day: "2026-11-12" }, NOW);
    await sync.sync(id, { force: true });
    assert.equal(adapter.events.get("trip").body.day, "2026-11-12");
    assert.equal(adapter.events.get("trip").body.end_day, "2026-11-15");
  } finally {
    store.close();
  }
});
test("undo after a synchronized cancellation restores a single visible event with a fresh stable ID", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    local(store);
    await sync.sync(id, { force: true });
    store.changeItem("alice", "event-local", { status: "cancelled" }, NOW);
    await sync.sync(id, { force: true });
    store.db
      .prepare(
        "UPDATE items SET status='open',version=version+1 WHERE id='event-local'",
      )
      .run();
    await sync.sync(id, { force: true });
    await sync.sync(id, { force: true });
    assert.equal(
      [...adapter.events.values()].filter(
        (value) => value.body.status === "open",
      ).length,
      1,
    );
    assert.equal(store.items("alice").length, 1);
    assert.equal(sync.pending().length, 0);
  } finally {
    store.close();
  }
});
test("Google cancellation and time offsets normalize without modifying participants", () => {
  assert.deepEqual(
    fromGoogle({ id: "one", status: "cancelled", etag: "one" }).body,
    { status: "cancelled" },
  );
  const event = fromGoogle({
    id: "one",
    etag: "one",
    summary: "Встреча",
    start: { dateTime: "2026-11-06T12:00:00+03:00" },
    end: { dateTime: "2026-11-06T13:00:00+03:00" },
  });
  assert.equal(event.body.at, FUTURE);
  assert.equal(event.body.duration, 60);
});
test("CalDAV restricts hosts and paths; strict XML rejects external entities and keeps decoded calendar data", () => {
  for (const url of [
    "http://caldav.yandex.ru/a",
    "https://evil.example/a",
    "https://caldav.yandex.ru.evil.example/a",
    "https://x:y@caldav.yandex.ru/a",
    "https://caldav.yandex.ru:8443/a",
  ])
    assert.throws(() => davUrl(url));
  assert.throws(() =>
    parseXml(
      '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///private">]><x>&leak;</x>',
    ),
  );
  const rows = davResponses(
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/a.ics</d:href><d:propstat><d:prop><d:getetag>&quot;one&quot;</d:getetag><c:calendar-data><![CDATA[BEGIN:VCALENDAR]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
  );
  assert.equal(textAt({ children: rows[0].props }, "getetag"), '"one"');
  assert.equal(
    textAt({ children: rows[0].props }, "calendar-data"),
    "BEGIN:VCALENDAR",
  );
});
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic tests//EN\r\nBEGIN:VEVENT\r\nUID:series-one\r\nSUMMARY:Серия\r\nDTSTART:20261106T090000Z\r\nDTEND:20261106T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR";
test("cancelled CalDAV tombstones and exceptions may omit DTSTART without breaking the rest of the calendar", () => {
  const options = {
      resource: "https://caldav.yandex.ru/cal/series.ics",
      etag: "one",
      range: { start: NOW, end: "2026-11-10T00:00:00.000Z" },
    },
    single =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:gone\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR";
  assert.equal(icalEvents(single, options)[0].body.status, "cancelled");
  const changed = ICS.replace(
    "END:VCALENDAR",
    "BEGIN:VEVENT\r\nUID:series-one\r\nRECURRENCE-ID:20261107T090000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR",
  );
  assert.equal(
    icalEvents(changed, {
      ...options,
      target: { uid: "series-one", rid: "2026-11-07T09:00:00Z" },
    })[0].body.status,
    "cancelled",
  );
  assert.equal(
    icalEvents(changed, options).filter((value) => value.body.status === "open")
      .length,
    2,
  );
});
test("finished all-day events stay as history and never become overdue appointments", async () => {
  const { store, adapter, sync, id } = setup();
  try {
    adapter.add("yesterday", {
      at: null,
      day: "2026-11-04",
      end_day: "2026-11-05",
    });
    await sync.sync(id, { force: true });
    assert.equal(store.items("alice").length, 0);
    assert.equal(
      store.items("alice", { includeClosed: true })[0].status,
      "elapsed",
    );
    await sync.sync(id, { force: true });
    assert.equal(adapter.writes.length, 0);
  } finally {
    store.close();
  }
});
test("CalDAV changes one recurring occurrence and preserves the master and other occurrences", () => {
  const options = {
    resource: "https://caldav.yandex.ru/cal/series.ics",
    etag: '"one"',
    range: { start: NOW, end: "2026-11-10T00:00:00.000Z" },
  };
  const original = icalEvents(ICS, options);
  assert.equal(original.length, 3);
  const body = {
      ...original[1].body,
      title: "Перенос",
      at: "2026-11-07T12:00:00.000Z",
    },
    updated = writeIcal(original[1], body, NOW),
    events = icalEvents(updated, options);
  assert.equal(events.length, 3);
  assert.equal(events[1].body.at, "2026-11-07T12:00:00.000Z");
  assert.equal(events[0].body.at, original[0].body.at);
  assert.equal(events[2].body.at, original[2].body.at);
  assert.match(updated, /RRULE:FREQ=DAILY;COUNT=3/);
  const cancelled = writeIcal(events[1], { status: "cancelled" }, NOW);
  assert.equal(
    icalEvents(cancelled, {
      ...options,
      target: { uid: "series-one", rid: "2026-11-07T09:00:00Z" },
    })[0].body.status,
    "cancelled",
  );
});
test("a distant moved exception does not hide the rest of its series, and an exception moved into the window is included", () => {
  const options = {
      resource: "https://caldav.yandex.ru/cal/series.ics",
      etag: "one",
      range: { start: NOW, end: "2026-11-10T00:00:00.000Z" },
    },
    original = icalEvents(ICS, options),
    updated = writeIcal(
      original[0],
      { ...original[0].body, at: "2027-11-06T09:00:00.000Z" },
      NOW,
    ),
    near = icalEvents(updated, options);
  assert.equal(near.length, 2);
  const earlier = {
      ...options,
      range: {
        start: "2026-11-01T00:00:00.000Z",
        end: "2026-11-04T00:00:00.000Z",
      },
    },
    movedIn = writeIcal(
      original[2],
      { ...original[2].body, at: "2026-11-02T09:00:00.000Z" },
      NOW,
    );
  assert.equal(icalEvents(movedIn, earlier).length, 1);
});
