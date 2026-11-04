import { createHmac, timingSafeEqual } from "node:crypto";
import { requireThat } from "../errors.mjs";

// initData is a short-lived read credential. Never log it or accept user IDs from the client.
export function plannerOwner(raw, botToken, now = Date.now()) {
  const denied =
    "Открой календарь кнопкой в личном чате BOB. Если он уже открыт, закрой и открой заново.";
  requireThat(
    typeof raw === "string" &&
      raw.length > 0 &&
      raw.length <= 16000 &&
      typeof botToken === "string" &&
      botToken.length > 20,
    "PLANNER_AUTH",
    denied,
  );
  const values = new URLSearchParams(raw),
    keys = [...values.keys()];
  requireThat(
    keys.length <= 24 &&
      keys.length === new Set(keys).size &&
      keys.every((key) => /^[a-z_]+$/u.test(key)),
    "PLANNER_AUTH",
    denied,
  );
  const hash = values.get("hash");
  requireThat(/^[a-f0-9]{64}$/u.test(hash ?? ""), "PLANNER_AUTH", denied);
  values.delete("hash");
  const data = [...values]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(data).digest();
  requireThat(
    timingSafeEqual(expected, Buffer.from(hash, "hex")),
    "PLANNER_AUTH",
    denied,
  );
  const date = values.get("auth_date");
  requireThat(
    /^\d{10}$/u.test(date ?? "") &&
      Number(date) * 1000 <= now + 30000 &&
      Number(date) * 1000 >= now - 1800000,
    "PLANNER_AUTH",
    denied,
  );
  let user;
  try {
    user = JSON.parse(values.get("user"));
  } catch {}
  requireThat(
    user && Number.isSafeInteger(user.id) && user.id > 0 && !user.is_bot,
    "PLANNER_AUTH",
    denied,
  );
  return String(user.id);
}
