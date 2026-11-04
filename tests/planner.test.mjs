import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Script } from "node:vm";
import { Store } from "../src/store.mjs";
import { Assistant } from "../src/assistant.mjs";
import { Alpha } from "../src/alpha.mjs";
import { CalendarSync } from "../src/calendars/engine.mjs";
import { plannerOwner } from "../src/planner/auth.mjs";
import { plannerData, calendarGeometry } from "../src/planner/model.mjs";
import { PlannerService } from "../src/planner/service.mjs";
import { plannerPublic } from "../src/planner/public.mjs";
import { plannerPage } from "../src/planner/page.mjs";
import { CLIENT } from "../src/planner/client.mjs";
import { GEOMETRY_SOURCE } from "../src/planner/geometry-source.mjs";
const NOW = "2026-11-05T00:30:00.000Z",
  TOKEN = "123456789:" + "A".repeat(35);
function signed({
  owner = 123,
  date = Date.parse(NOW) / 1000,
  token = TOKEN,
  extra = {},
} = {}) {
  const params = new URLSearchParams({
    user: JSON.stringify({ id: owner, first_name: "Synthetic" }),
    auth_date: String(date),
    query_id: "synthetic",
    ...extra,
  });
  const check = [...params]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
test("Mini App authentication verifies the signed user, all fields, age, duplicates and bot key", () => {
  assert.equal(plannerOwner(signed(), TOKEN, Date.parse(NOW)), "123");
  assert.equal(
    plannerOwner(
      signed({ extra: { signature: "signed-modern-field" } }),
      TOKEN,
      Date.parse(NOW),
    ),
    "123",
  );
  for (const raw of [
    signed() + "&user=%7B%22id%22%3A456%7D",
    signed().replace("Synthetic", "Changed"),
    signed({ date: Date.parse(NOW) / 1000 - 1801 }),
    signed({ date: Date.parse(NOW) / 1000 + 31 }),
    signed({ token: TOKEN + "x" }),
    signed({ owner: "123" }),
    signed({ owner: -5 }),
    signed({ extra: { user: JSON.stringify({ id: 123, is_bot: true }) } }),
    "hash=" + "0".repeat(64),
  ])
    assert.throws(
      () => plannerOwner(raw, TOKEN, Date.parse(NOW)),
      (error) => error.code === "PLANNER_AUTH",
    );
});
const event = (id, at, duration = 60, extra = {}) => ({
  id,
  title: id,
  kind: "event",
  at,
  duration,
  day: at?.slice(0, 10),
  ...extra,
});
test("calendar geometry splits midnight, preserves all-day spans and gives exact-overlap events separate lanes", () => {
  const days = ["2026-11-05", "2026-11-06"];
  const columns = calendarGeometry(
    [
      event("night", "2026-11-05T16:30:00Z", 90),
      event("overlap", "2026-11-05T17:00:00Z", 30),
      event("all", null, null, {
        day: "2026-11-05",
        all_day: true,
        end_day: "2026-11-07",
      }),
      event("moved-all", null, null, {
        day: "2026-11-06",
        source_day: "2026-11-01",
        all_day: true,
        end_day: "2026-11-03",
      }),
      event("deadline", "2026-11-05T05:00:00Z", null, { kind: "task" }),
      event("unknown", "2026-11-05T05:00:00Z", null),
    ],
    days,
    "Asia/Tomsk",
  );
  const night = columns[0].timed.find((entry) => entry.item.id === "night");
  assert.equal(night.start, 23 * 60 + 30);
  assert.equal(night.end, 1440);
  assert.equal(night.continuesAfter, true);
  const continuation = columns[1].timed.find(
    (entry) => entry.item.id === "night",
  );
  assert.equal(continuation.start, 0);
  assert.equal(continuation.end, 60);
  assert.equal(continuation.continuesBefore, true);
  assert.equal(continuation.conflict, true);
  assert.equal(columns[0].floating.length, 1);
  assert.equal(columns[1].floating.length, 2);
  const uncertain = columns[0].timed.filter((entry) => !entry.known);
  assert.equal(uncertain.length, 2);
  assert.ok(uncertain.every((entry) => !entry.conflict));
  assert.notEqual(uncertain[0].lane, uncertain[1].lane);
});
test("adjacent intervals are not conflicts; dense clusters get stable lane counts without dropping records", () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) =>
      event("busy-" + String(i).padStart(2, "0"), "2026-11-05T02:00:00Z", 60),
    ),
    event("after", "2026-11-05T03:00:00Z", 60),
  ];
  const [column] = calendarGeometry(items, ["2026-11-05"], "Asia/Tomsk");
  assert.equal(column.timed.length, 31);
  assert.equal(column.timed[0].lanes, 30);
  assert.equal(column.timed.at(-1).lanes, 1);
  assert.equal(column.timed.at(-1).conflict, false);
});
test("timezone and DST display never turn nonoverlapping absolute appointments into factual conflicts", () => {
  const items = [
    event("before", "2026-11-01T05:00:00Z", 30),
    event("after", "2026-11-01T06:00:00Z", 30),
  ];
  const [column] = calendarGeometry(items, ["2026-11-01"], "America/New_York");
  assert.equal(column.timed.length, 2);
  assert.ok(column.timed.every((entry) => !entry.conflict));
  assert.equal(
    calendarGeometry(
      [event("local", "2026-11-04T19:00:00Z")],
      ["2026-11-05"],
      "Asia/Tomsk",
    )[0].timed.length,
    1,
  );
  assert.equal(
    calendarGeometry(
      [event("local", "2026-11-04T19:00:00Z")],
      ["2026-11-05"],
      "Europe/Moscow",
    )[0].timed.length,
    0,
  );
});
function setup() {
  const store = new Store();
  store.ensureUser("alice");
  store.ensureUser("bob");
  new CalendarSync(store, "alice", { adapter: () => {} });
  const alpha = new Alpha(
    store,
    new Assistant(store, { allowedOwners: ["alice", "bob"], clock: () => NOW }),
    { clock: () => NOW },
  );
  const service = new PlannerService(store, "alice", alpha.ui, {
    clock: () => NOW,
  });
  return { store, alpha, service };
}
test("planner returns only the signed owner, uses local dates and excludes all credential/history fields without database writes", () => {
  const { store } = setup();
  try {
    store.putItem(
      {
        id: "own",
        owner: "alice",
        kind: "task",
        title: "Отчёт",
        at: "2026-11-04T19:00:00Z",
        day: "2026-11-04",
      },
      NOW,
      60,
    );
    store.putItem(
      {
        id: "foreign",
        owner: "bob",
        kind: "task",
        title: "Foreign private title",
      },
      NOW,
      60,
    );
    store.db
      .prepare("INSERT INTO projects VALUES (?,?)")
      .run("alice", "Пустой проект");
    store.db
      .prepare("INSERT INTO projects VALUES (?,?)")
      .run("bob", "Foreign private project");
    const before = store.db
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const result = plannerData(store, "alice", NOW);
    assert.equal(result.today, "2026-11-05");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].day, "2026-11-05");
    assert.deepEqual(result.projects, ["Пустой проект"]);
    assert.equal(
      store.db.prepare("SELECT total_changes() AS count").get().count,
      before,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /Foreign private|credentials|history|owner|source_key/,
    );
  } finally {
    store.close();
  }
});
test("chat calendar entry preserves tomorrow or an explicit date and retains text/card navigation", async () => {
  const { store, alpha } = setup();
  try {
    const tomorrow = await alpha.handle("alice", "что у меня завтра", {
        requestId: "tomorrow-link",
      }),
      next = tomorrow.replyMarkup.inline_keyboard
        .flat()
        .find((button) => button.web_app);
    assert.match(next.web_app.url, /view=day&date=2026-11-06$/);
    const week = await alpha.handle("alice", "/week", {
      requestId: "week-link",
    });
    assert.match(
      week.replyMarkup.inline_keyboard.flat().find((button) => button.web_app)
        .web_app.url,
      /view=week$/,
    );
    assert.match(week.text, /Ближайшие 7 дней/);
  } finally {
    store.close();
  }
});
test("calendar-to-chat navigation is owner scoped and always opens the latest card without changing the item", async () => {
  const { store, alpha, service } = setup();
  try {
    store.putItem(
      {
        id: "own",
        owner: "alice",
        kind: "task",
        title: "Исходное",
        day: "2026-11-06",
      },
      NOW,
      60,
    );
    store.putItem(
      { id: "foreign", owner: "bob", kind: "task", title: "Чужое" },
      NOW,
      60,
    );
    const request = (id) =>
      new Request("https://internal/planner/item", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
    await assert.rejects(
      service.http(request("foreign")),
      (error) => error.code === "PLANNER_ITEM",
    );
    const response = await (await service.http(request("own"))).json(),
      payload = new URL(response.url).searchParams.get("start");
    assert.match(payload, /^p_[a-f0-9]{20}$/);
    assert.equal(
      (await alpha.handle("bob", "/start " + payload, { requestId: "foreign" }))
        .status,
      "error",
    );
    store.changeItem("alice", "own", { title: "Актуальное" }, NOW);
    const result = await alpha.handle("alice", "/start " + payload, {
      requestId: "own",
    });
    assert.match(result.text, /Актуальное/);
    assert.equal(result.changed, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(store.item("alice", "own").status, "open");
  } finally {
    store.close();
  }
});
test("revoked/onboarding users are blocked and read bursts are bounded without persistent counters", async () => {
  const { store, alpha, service } = setup();
  try {
    const req = () =>
      new Request("https://internal/planner/data", { method: "POST" });
    await assert.rejects(
      new PlannerService(store, "alice", alpha.ui, {
        enabled: () => false,
      }).http(req()),
      (error) => error.code === "PLANNER_ACCESS",
    );
    store.db
      .prepare("UPDATE ui_profiles SET onboarding=1 WHERE owner=?")
      .run("alice");
    await assert.rejects(service.http(req()));
    store.db
      .prepare("UPDATE ui_profiles SET onboarding=0 WHERE owner=?")
      .run("alice");
    for (let i = 0; i < 30; i++)
      assert.equal((await service.http(req())).status, 200);
    await assert.rejects(
      service.http(req()),
      (error) => error.code === "PLANNER_RATE",
    );
  } finally {
    store.close();
  }
});
test("public shell has no private data or demo switch, rejects unauthenticated/cross-origin reads, and browser script parses", async () => {
  assert.equal(
    GEOMETRY_SOURCE,
    calendarGeometry.toString().replaceAll("\r\n", "\n"),
    "Regenerate browser geometry with scripts/build-planner-source.mjs",
  );
  const body = await plannerPage().text();
  assert.match(body, /const DEMO=null/);
  assert.doesNotMatch(body, /initDataUnsafe|localStorage|analytics|eval\(/);
  new Script(
    "const DEMO=null;const geometry=" +
      calendarGeometry.toString() +
      ";" +
      CLIENT,
  );
  const env = { TELEGRAM_BOT_TOKEN: TOKEN };
  const shell = await plannerPublic(
    new Request("https://example.test/planner?demo=true"),
    env,
  );
  assert.match(await shell.text(), /const DEMO=null/);
  assert.match(
    shell.headers.get("Content-Security-Policy"),
    /frame-ancestors https:\/\/web.telegram.org/,
  );
  assert.equal(shell.headers.get("Cache-Control"), "no-store");
  for (const headers of [
    {},
    { Origin: "https://evil.invalid", "Content-Type": "application/json" },
    {
      Origin: "https://assistant-bob-alpha.assistant-bob.workers.dev",
      "Content-Type": "application/json",
    },
  ])
    assert.equal(
      (
        await plannerPublic(
          new Request("https://example.test/planner/data", {
            method: "POST",
            headers,
            body: "{}",
          }),
          env,
        )
      ).status,
      401,
    );
  assert.equal(
    (await plannerPublic(new Request("https://example.test/planner/data"), env))
      .status,
    405,
  );
  const preview = await plannerPage({
    demo: { items: [{ title: "</script><script>alert(1)</script>" }] },
  }).text();
  assert.doesNotMatch(preview, /<script>alert/);
  assert.match(preview, /\\u003c/);
});
