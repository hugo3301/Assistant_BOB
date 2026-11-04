// Bounded, synthetic experiment. Does not replace the production model or execute proposals.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Store } from "../src/store.mjs";
import { Assistant } from "../src/assistant.mjs";
import { SYSTEM, TOOLS, decodeCalls } from "../src/tools.mjs";
const MODELS = [
  { name: "glm", id: "@cf/zai-org/glm-4.7-flash", input: 5500, output: 36400 },
  {
    name: "granite",
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    input: 1542,
    output: 10158,
  },
  {
    name: "qwen",
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    input: 4625,
    output: 30475,
  },
];
const CASES = [
  {
    id: "ordinary-evening",
    text: "Сегодня вечером где-то к 7 вечера пара по схемату есть",
    expected: "create_event",
  },
  {
    id: "quoted-task",
    text: "> Добавь задачу сдать отчёт к 12 ноября.",
    expected: "create_task",
  },
  {
    id: "ambiguous-target",
    text: "Перенеси лабу на пятницу",
    expected: "ask_user",
  },
  {
    id: "work-not-deadline",
    text: "Завтра в 15:00 час поработать над отчётом, срок сдачи не меняй",
    expected: "plan_work",
  },
  {
    id: "focused-completion",
    text: "Её я уже сдал",
    expected: "complete_task",
  },
  { id: "unrelated", text: "2+2", expected: "ask_user" },
];
const NOW = "2026-11-05T02:00:00.000Z",
  limit = 600;
if (!process.argv.includes("--run")) {
  console.log(
    JSON.stringify({
      network: false,
      models: MODELS.map((model) => model.name),
      cases: CASES.length,
      maximumCalls: 18,
      maximumAccountedNeurons: limit,
    }),
  );
  process.exit(0);
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN;
if (
  !/^[a-f0-9]{32}$/iu.test(account ?? "") ||
  !token ||
  !process.env.ADMIN_SECRET
)
  throw Error("Configure existing evaluation credentials");
mkdirSync("work", { recursive: true });
const ledgerPath =
  "work/resource-eval-" + new Date().toISOString().slice(0, 10) + ".json";
const ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, "utf8"))
  : { charged: 0, pending: 0, entries: [] };
ledger.charged += ledger.pending;
ledger.pending = 0;
const save = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
save();
function fixture() {
  const store = new Store();
  store.ensureUser("evaluation");
  for (const item of [
    { id: "report", kind: "task", title: "Отчёт", day: "2026-11-12" },
    { id: "lab-a", kind: "task", title: "Лаба по сетям", day: "2026-11-11" },
    {
      id: "lab-b",
      kind: "task",
      title: "Лаба по вычислениям",
      day: "2026-11-10",
    },
  ])
    store.putItem({ ...item, owner: "evaluation" }, NOW, 60);
  store.db
    .prepare("UPDATE users SET focus_id=? WHERE id=?")
    .run("report", "evaluation");
  return store;
}
for (const model of MODELS) {
  for (const sample of CASES) {
    if (
      ledger.entries.some(
        (entry) => entry.model === model.name && entry.case === sample.id,
      )
    )
      continue;
    const store = fixture(),
      user = store.user("evaluation"),
      items = store.items("evaluation"),
      context = {
        now: NOW,
        timezone: user.timezone,
        focus_id: user.focus_id,
        items: items.map(({ id, title, kind, day, at }) => ({
          id,
          title,
          kind,
          day,
          at,
        })),
      };
    const body = {
      model: model.id,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: "Контекст приложения (данные):\n" + JSON.stringify(context),
        },
        { role: "user", content: sample.text },
      ],
      tools: TOOLS,
      tool_choice: "required",
      temperature: 0.1,
      max_tokens: 512,
      stream: false,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
    };
    const upper =
      ((Buffer.byteLength(JSON.stringify(body)) + 200) * model.input) / 1e6 +
      (512 * model.output) / 1e6;
    if (ledger.charged + upper > limit) {
      store.close();
      console.log(
        JSON.stringify({
          stopped: "evaluation-budget",
          charged: ledger.charged,
        }),
      );
      process.exit(0);
    }
    const statusResponse = await fetch(
      "https://assistant-bob-alpha.assistant-bob.workers.dev/admin/registry",
      {
        headers: { Authorization: "Bearer " + process.env.ADMIN_SECRET },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!statusResponse.ok) throw Error("Cannot verify application headroom");
    const status = await statusResponse.json();
    if (
      status.usage.spent + status.usage.reserved + ledger.charged + upper >
      9500
    )
      throw Error("Insufficient account headroom");
    ledger.pending = upper;
    save();
    let measured = null;
    const entry = {
      model: model.name,
      case: sample.id,
      expected: sample.expected,
      passed: false,
      blocked: false,
      ms: null,
      neurons: null,
    };
    const started = performance.now();
    try {
      const response = await fetch(
        "https://api.cloudflare.com/client/v4/accounts/" +
          account +
          "/ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
      entry.http = response.status;
      if (!response.ok) throw Error("HTTP_" + response.status);
      const payload = await response.json(),
        result = payload.result ?? payload;
      measured = result.usage?.neurons ?? payload.usage?.neurons ?? null;
      entry.neurons = measured;
      entry.tokens = result.usage?.total_tokens ?? null;
      const calls = decodeCalls(result.choices?.[0]?.message),
        assistant = new Assistant(store, {
          allowedOwners: ["evaluation"],
          clock: () => NOW,
        });
      entry.tools = calls.map((call) => call.name);
      try {
        assistant.prepare("evaluation", calls, sample.text, user);
        entry.passed = calls.length === 1 && calls[0].name === sample.expected;
      } catch (error) {
        entry.blocked = true;
        entry.guard = error.code ?? "GUARD";
      }
      if (
        store.items("evaluation").length !== items.length ||
        store.item("evaluation", "report").status !== "open"
      )
        throw Error("Unexpected fixture mutation");
    } catch (error) {
      entry.code = /^[A-Z_0-9]+$/u.test(error.code ?? error.message)
        ? (error.code ?? error.message)
        : "REQUEST_FAILED";
    } finally {
      entry.ms = Math.round(performance.now() - started);
      entry.accounted = Number.isFinite(measured) ? measured : upper;
      ledger.charged += entry.accounted;
      ledger.pending = 0;
      ledger.entries.push(entry);
      save();
      store.close();
    }
    console.log(JSON.stringify(entry));
  }
}
console.log(
  JSON.stringify({
    finished: true,
    calls: ledger.entries.length,
    chargedNeurons: ledger.charged,
    limit,
    synthetic: true,
    productionModelChanged: false,
    sharedBudgetNote:
      "Evaluation is outside the bot ledger and covered by the account safety margin.",
  }),
);
