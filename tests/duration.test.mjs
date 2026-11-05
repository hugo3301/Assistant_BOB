import test from "node:test";
import assert from "node:assert/strict";
import {
  durationFromText,
  reminderFromText,
  Assistant,
} from "../src/assistant.mjs";
import { Store } from "../src/store.mjs";
const NOW = "2026-11-05T00:00:00.000Z";
for (const [text, expected] of [
  ["Завтра в 15:00 час поработать над отчётом", 60],
  ["полчаса поработать", 30],
  ["два часа поработать", 120],
  ["поработать час", 60],
  ["поработать полтора часа", 90],
  ["на два часа", 120],
  ["на 1,5 часа", 90],
  ["на 2 часа 30 минут", 150],
  ["на 2ч 30мин", 150],
  ["на 45 мин", 45],
  ["Выдели три часа на проект", 180],
  ["на час, напомни за полчаса", 60],
  ["Уточнение: полтора часа", 90],
  ["двадцать два часа поработать", 1320],
  ["на сто двадцать пять минут", 125],
  ["тридцать пять минут поработать", 35],
  ["20 2 часа поработать", null],
  ["на один два часа", null],
  ["в час поработать", null],
  ["через час поработать", null],
  ["за час поработать", null],
  ["поработать через час", null],
  ["на час раньше", null],
  ["на час-полтора", null],
  ["на час или на два часа", null],
  ["час и полчаса поработать", null],
  ["поработать без длительности", null],
])
  test("duration preserves the meaning of: " + text, () =>
    assert.equal(durationFromText(text), expected),
  );
test("start/delay/reminder are distinct from explicit work duration", () => {
  assert.equal(durationFromText("В час поработать час"), 60);
  assert.equal(durationFromText("Через час поработать на полчаса"), 30);
  assert.equal(durationFromText("Напомни за час поработать"), null);
  assert.equal(
    reminderFromText("На полчаса поработать, напомни за час", null),
    60,
  );
});
test("a spoken duration creates one synthetic work interval and never changes the external deadline", async () => {
  const store = new Store();
  store.ensureUser("alice");
  store.putItem(
    {
      id: "report",
      owner: "alice",
      kind: "task",
      title: "Отчёт",
      day: "2026-11-12",
    },
    NOW,
    60,
  );
  try {
    const bot = new Assistant(store, {
      allowedOwners: ["alice"],
      clock: () => NOW,
    });
    const result = await bot.handle(
      "alice",
      "Завтра в 15:00 час поработать над отчётом, срок сдачи не меняй",
      {
        requestId: "hour-work",
        applicationCalls: [
          {
            name: "plan_work",
            args: {
              target_id: "report",
              when_text: "завтра в 15:00",
              duration_minutes: 999,
            },
          },
        ],
      },
    );
    assert.equal(result.status, "ok", result.text);
    assert.equal(result.changed, 1);
    assert.equal(result.modelCalls, 0);
    const work = store.items("alice").find((item) => item.kind === "work");
    assert.equal(work.duration, 60);
    assert.equal(work.at, "2026-11-06T08:00:00.000Z");
    assert.equal(work.parent_id, "report");
    assert.equal(store.item("alice", "report").day, "2026-11-12");
    const repeat = await bot.handle(
      "alice",
      "Завтра в 15:00 час поработать над отчётом, срок сдачи не меняй",
      { requestId: "hour-work", applicationCalls: [] },
    );
    assert.equal(repeat.replayed, true);
    assert.equal(store.items("alice").length, 2);
  } finally {
    store.close();
  }
});
test("a time of day alone still asks for effort; fractional minutes and huge durations cannot be written", async () => {
  for (const [phrase, when] of [
    ["Завтра в час поработать над отчётом", "завтра в час"],
    ["Завтра в 15:00 на 100 часов поработать над отчётом", "завтра в 15:00"],
    ["Завтра в 15:00 на 1,5 минуты поработать над отчётом", "завтра в 15:00"],
  ]) {
    const store = new Store();
    store.ensureUser("alice");
    store.putItem(
      {
        id: "report",
        owner: "alice",
        kind: "task",
        title: "Отчёт",
        day: "2026-11-12",
      },
      NOW,
      60,
    );
    try {
      const bot = new Assistant(store, {
        allowedOwners: ["alice"],
        clock: () => NOW,
        maxCalls: 1,
      });
      const response = await bot.handle("alice", phrase, {
        requestId: "missing",
        applicationCalls: [
          {
            name: "plan_work",
            args: {
              target_id: "report",
              when_text: when,
              duration_minutes: 60,
            },
          },
        ],
      });
      assert.equal(response.changed, 0);
      assert.equal(store.items("alice").length, 1);
      assert.equal(store.item("alice", "report").day, "2026-11-12");
    } finally {
      store.close();
    }
  }
});
