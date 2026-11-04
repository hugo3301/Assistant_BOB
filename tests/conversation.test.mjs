import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Assistant } from "../src/assistant.mjs";
import { Alpha } from "../src/alpha.mjs";
import { WorkersAI } from "../src/ai.mjs";
import {
  calculate,
  mathSource,
  conversationIntent,
} from "../src/conversation.mjs";
import { selectItems } from "../src/views.mjs";
import { transcription } from "../src/voice.mjs";
import { refreshDelivery } from "../src/delivery-view.mjs";
const NOW = "2026-11-05T00:30:00.000Z";
const call = (name, args) => ({
  id: "one",
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(steps = [], clock = () => NOW) {
  const store = new Store();
  store.ensureUser("alice");
  let calls = 0,
    sequence = 0;
  const inputs = [];
  const provider = {
    async complete(input) {
      inputs.push(input);
      if (!steps[calls]) throw Error("Unexpected model call");
      return { message: { tool_calls: steps[calls++] }, usage: { neurons: 1 } };
    },
  };
  const assistant = new Assistant(store, {
      provider,
      allowedOwners: ["alice"],
      clock,
    }),
    alpha = new Alpha(store, assistant, { clock });
  return {
    store,
    assistant,
    alpha,
    inputs,
    run: (text, id = "chat-" + ++sequence) =>
      alpha.handle("alice", text, { requestId: id }),
    get calls() {
      return calls;
    },
  };
}
for (const [source, answer] of [
  ["2+2", 4],
  ["2+2*3", 8],
  ["(2+2)*3", 12],
  ["-2^2", -4],
  ["2^-2", 0.25],
  ["0,1+0,2", 0.3],
  ["Сколько будет 12 разделить на 3?", 4],
  ["два плюс два", 4],
])
  test("calculator has a bounded non-eval path: " + source, () =>
    assert.equal(calculate(mathSource(source)), answer),
  );
test("calculator rejects dangerous syntax, zero division, huge powers and confusion with clock/date/task text", () => {
  for (const source of [
    "1/0",
    "2^10000",
    "(".repeat(30) + "2" + ")".repeat(30),
    "1+".repeat(100) + "1",
  ])
    assert.throws(() => calculate(source));
  assert.equal(mathSource("07:30"), null);
  assert.equal(mathSource("2026-11-12"), null);
  assert.equal(mathSource("купить 2+2 тетради"), null);
  assert.equal(mathSource("2+process.exit()"), null);
  assert.equal(conversationIntent("05/11", { kind: "date" }), false);
});
test("arithmetic, greetings and current clock use no model, never touch tasks and are idempotent", async () => {
  const f = fixture();
  try {
    f.store.putItem(
      {
        id: "keep",
        owner: "alice",
        kind: "task",
        title: "Сохранить",
        day: "2026-11-05",
      },
      NOW,
      60,
    );
    for (const text of [
      "2+2",
      "Привет",
      "Как дела?",
      "Спасибо",
      "Сколько сейчас времени?",
      "Какой сегодня день?",
    ]) {
      const reply = await f.run(text);
      assert.equal(reply.changed, 0);
      assert.equal(reply.modelCalls, 0);
      assert.doesNotMatch(reply.text, /Сегодня:\n|Ближайшие 7 дней/);
    }
    const a = await f.run("2+2", "same"),
      b = await f.run("2+2", "same");
    assert.equal(a.text, "2+2 = 4");
    assert.equal(b.replayed, true);
    assert.equal(f.calls, 0);
    assert.equal(f.store.item("alice", "keep").status, "open");
  } finally {
    f.store.close();
  }
});
test("independent questions preserve date/target/UI/calendar/bulk clarification and focus", async () => {
  const f = fixture();
  try {
    for (const kind of [
      "date",
      "target",
      "question",
      "ui_input",
      "ui_move",
      "calendar_choice",
      "bulk",
    ]) {
      const pending = {
        kind,
        field: "morning",
        originalText: "Ожидаемое уточнение",
        referenceAt: NOW,
        expiresAt: "2026-11-06T00:00:00.000Z",
      };
      f.store.db
        .prepare("UPDATE users SET pending=?,focus_id=? WHERE id=?")
        .run(JSON.stringify(pending), "kept-focus", "alice");
      assert.equal((await f.run("2+2")).text, "2+2 = 4");
      assert.deepEqual(f.store.user("alice").pending, pending);
      assert.equal(f.store.user("alice").focus_id, "kept-focus");
    }
    const pending = {
      kind: "ui_input",
      field: "morning",
      expiresAt: "2026-11-06T00:00:00Z",
    };
    f.store.db
      .prepare("UPDATE users SET pending=? WHERE id=?")
      .run(JSON.stringify(pending), "alice");
    await f.run("Сколько сейчас времени?");
    await f.run("07:30");
    assert.equal(f.store.user("alice").morning_time, "07:30");
  } finally {
    f.store.close();
  }
});
test("a general question gets an answer without task context or changing the pending operation", async () => {
  const f = fixture([
    [
      call("reply_user", {
        answer: "Рекурсия — когда функция вызывает саму себя.",
      }),
    ],
  ]);
  try {
    const pending = {
      kind: "date",
      originalText: "Завтра встреча",
      expiresAt: "2026-11-06T00:00:00Z",
      referenceAt: NOW,
    };
    f.store.db
      .prepare("UPDATE users SET pending=? WHERE id=?")
      .run(JSON.stringify(pending), "alice");
    const result = await f.run("Что такое рекурсия?");
    assert.equal(result.changed, 0);
    assert.match(result.text, /функция/);
    assert.equal(f.inputs[0].conversation, true);
    assert.deepEqual(Object.keys(f.inputs[0].context).sort(), [
      "now",
      "timezone",
    ]);
    assert.equal(f.inputs[0].text, "Что такое рекурсия?");
    assert.deepEqual(f.store.user("alice").pending, pending);
  } finally {
    f.store.close();
  }
});
test("a model cannot replace a general question with a read, a creation or an action claim", async () => {
  for (const bad of [
    call("list_items", { scope: "today" }),
    call("create_task", { title: "Не должно появиться" }),
    call("reply_user", { answer: "Готово, удалил все дела." }),
  ]) {
    const f = fixture([[bad], [bad]]);
    try {
      const response = await f.run("Что такое рекурсия?");
      assert.equal(response.changed, 0);
      assert.equal(response.status, "error");
      assert.equal(f.store.items("alice").length, 0);
      assert.doesNotMatch(response.text, /Сегодня:\n/);
    } finally {
      f.store.close();
    }
  }
});
test("unrecognized chatter cannot become a task or overview even outside the dedicated question route", async () => {
  const f = fixture([
    [call("create_task", { title: "шушушу" })],
    [call("list_items", { scope: "today" })],
  ]);
  try {
    const result = await f.run("шушушу");
    assert.equal(result.changed, 0);
    assert.equal(result.status, "error");
    assert.equal(f.store.items("alice").length, 0);
  } finally {
    f.store.close();
  }
});
test("conversation API receives only the answer tool and bounded output; personal items/history are absent", async () => {
  const store = new Store();
  store.ensureUser("alice");
  try {
    let body;
    const provider = new WorkersAI(store, {
      accountId: "a".repeat(32),
      token: "synthetic-ai-token-not-a-secret",
      fetcher: async (_url, options) => {
        body = JSON.parse(options.body);
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [call("reply_user", { answer: "Ответ" })],
              },
            },
          ],
          usage: { neurons: 1 },
        });
      },
    });
    await provider.complete({
      context: { now: NOW, timezone: "Asia/Tomsk" },
      text: "Что такое рекурсия?",
      conversation: true,
    });
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ["reply_user"],
    );
    assert.equal(body.max_tokens, 400);
    assert.ok(
      body.messages.every((message) => !message.content.includes("items")),
    );
  } finally {
    store.close();
  }
});
test("today excludes old unknown-duration events, keeps overdue tasks and real overnight/all-day spans", async () => {
  const f = fixture();
  try {
    for (const item of [
      {
        id: "yesterday",
        kind: "event",
        title: "Вчерашнее событие",
        at: "2026-11-04T10:00:00Z",
        day: "2026-11-04",
      },
      {
        id: "overdue",
        kind: "task",
        title: "Просроченная задача",
        day: "2026-11-04",
      },
      {
        id: "night",
        kind: "event",
        title: "Ночная работа",
        at: "2026-11-04T16:30:00Z",
        day: "2026-11-04",
        duration: 600,
      },
      {
        id: "festival",
        kind: "event",
        title: "Несколько дней",
        day: "2026-11-04",
      },
    ])
      f.store.putItem({ ...item, owner: "alice" }, NOW, 60);
    f.store.db
      .prepare("INSERT INTO calendar_item_meta VALUES (?,?,?,?,?)")
      .run("festival", "synthetic", 1, "2026-11-07", "2026-11-04");
    const selection = selectItems(f.store, "alice", "today", NOW);
    assert.ok(!selection.some((item) => item.id === "yesterday"));
    assert.ok(
      ["overdue", "night", "festival"].every((id) =>
        selection.some((item) => item.id === id),
      ),
    );
    const response = await f.run("/today");
    assert.doesNotMatch(response.text, /Вчерашнее событие/);
    assert.match(response.text, /Просроченные задачи/);
    assert.match(response.text, /Сейчас/);
    assert.match(response.text, /началось/);
  } finally {
    f.store.close();
  }
});
test("period buttons rebuild their snapshot after local midnight, and use the current timezone", async () => {
  let now = "2026-11-04T16:50:00.000Z";
  const f = fixture([], () => now);
  try {
    for (let i = 0; i < 8; i++)
      f.store.putItem(
        {
          id: "old-" + i,
          owner: "alice",
          kind: "event",
          title: "Старый день " + i,
          day: "2026-11-04",
          at: "2026-11-04T08:00:00Z",
        },
        now,
        60,
      );
    f.store.putItem(
      {
        id: "next",
        owner: "alice",
        kind: "event",
        title: "Новый день",
        day: "2026-11-05",
        at: "2026-11-04T18:00:00Z",
      },
      now,
      60,
    );
    const old = await f.run("/today"),
      next = old.replyMarkup.inline_keyboard
        .flat()
        .find((button) => button.text.includes("Дальше")).callback_data;
    now = "2026-11-04T17:01:00.000Z";
    const response = await f.alpha.handle("alice", "", {
      requestId: "late-next",
      callback: { id: "cb", data: next },
    });
    assert.match(response.text, /Новый день/);
    assert.doesNotMatch(response.text, /Старый день/);
    assert.match(response.text, /5 ноября/);
    f.store.db
      .prepare("UPDATE users SET timezone=? WHERE id=?")
      .run("Europe/Moscow", "alice");
    const moscow = await f.run("/today");
    assert.match(moscow.text, /Старый день/);
    assert.doesNotMatch(moscow.text, /Новый день/);
  } finally {
    f.store.close();
  }
});
test("clear numeric or spoken arithmetic transcripts are allowed but isolated digits still need clarification", () => {
  assert.equal(
    transcription({
      text: "2+2",
      segments: [{ no_speech_prob: 0.01, avg_logprob: -0.1 }],
    }).uncertain,
    false,
  );
  assert.equal(transcription({ text: "два плюс два" }).uncertain, false);
  assert.equal(transcription({ text: "123" }).uncertain, true);
});
test("a period view delayed in the outbox refreshes after midnight; mutation receipts never rerun", () => {
  let now = "2026-11-04T16:59:00.000Z";
  const f = fixture([], () => now);
  try {
    f.store.putItem(
      {
        id: "new-day",
        owner: "alice",
        kind: "event",
        title: "После полуночи",
        day: "2026-11-05",
        at: "2026-11-04T18:00:00Z",
      },
      now,
      60,
    );
    const view = f.alpha.ui.list("alice", { scope: "today" });
    view.persist();
    const original = {
      text: view.text,
      entities: view.entities,
      replyMarkup: view.replyMarkup,
      viewMeta: view.viewMeta,
      editMessageId: 123,
    };
    now = "2026-11-04T17:02:00.000Z";
    const fresh = refreshDelivery(f.alpha.ui, "alice", original, now);
    assert.equal(fresh.changed, true);
    fresh.persist();
    assert.match(fresh.payload.text, /После полуночи/);
    assert.match(fresh.payload.text, /5 ноября/);
    assert.equal(fresh.payload.editMessageId, 123);
    assert.equal(
      refreshDelivery(f.alpha.ui, "alice", fresh.payload, now).changed,
      false,
    );
    const receipt = { text: "Добавил: задача" };
    assert.equal(
      refreshDelivery(f.alpha.ui, "alice", receipt, now).payload,
      receipt,
    );
    assert.equal(f.store.items("alice").length, 1);
  } finally {
    f.store.close();
  }
});
