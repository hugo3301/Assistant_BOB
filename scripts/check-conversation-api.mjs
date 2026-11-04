// Synthetic, bounded integration check. Never sends Telegram messages or uses the user's database.
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { WorkersAI } from "../src/ai.mjs";
import { Assistant } from "../src/assistant.mjs";
import { Alpha } from "../src/alpha.mjs";
if (!process.argv.includes("--run")) {
  console.log(
    JSON.stringify({
      network: false,
      synthetic: true,
      maximumModelCalls: 4,
      maximumAccountedNeurons: 80,
    }),
  );
  process.exit(0);
}
const store = new Store(),
  owner = "evaluation";
store.ensureUser(owner);
try {
  const provider = new WorkersAI(store, {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    dailyBudget: 80,
  });
  const alpha = new Alpha(
    store,
    new Assistant(store, { provider, allowedOwners: [owner] }),
  );
  const math = await alpha.handle(owner, "2+2", { requestId: "math" });
  assert.equal(math.text, "2+2 = 4");
  assert.equal(math.modelCalls, 0);
  for (const [id, text] of [
    ["definition", "Что такое рекурсия?"],
    ["weather", "Какая погода сегодня?"],
  ]) {
    const started = performance.now(),
      reply = await alpha.handle(owner, text, { requestId: id });
    assert.equal(reply.status, "ok", reply.code);
    assert.equal(reply.changed, 0);
    assert.equal(store.items(owner).length, 0);
    console.log(
      JSON.stringify({
        case: id,
        modelCalls: reply.modelCalls,
        ms: Math.round(performance.now() - started),
        characters: reply.text.length,
        answer: reply.text,
      }),
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      synthetic: true,
      productionDataChanged: false,
      usage: store.usage(new Date().toISOString().slice(0, 10)),
    }),
  );
} finally {
  store.close();
}
