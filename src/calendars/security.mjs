import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireThat } from "../errors.mjs";
export function calendarKey(secret) {
  requireThat(
    /^[a-f0-9]{64}$/u.test(secret ?? ""),
    "CALENDAR_CONFIG",
    "Подключение календарей ещё настраивается владельцем.",
  );
  return Buffer.from(secret, "hex");
}
export function seal(secret, scope, value) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", calendarKey(secret), iv);
  cipher.setAAD(Buffer.from(scope));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((part) => part.toString("base64url"))
    .join(".");
}
export function unseal(secret, scope, value) {
  try {
    const parts = String(value).split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[a-zA-Z0-9_-]+$/u.test(part))
    )
      throw Error();
    const [iv, tag, bytes] = parts.map((part) =>
      Buffer.from(part, "base64url"),
    );
    if (iv.length !== 12 || tag.length !== 16) throw Error();
    const cipher = createDecipheriv("aes-256-gcm", calendarKey(secret), iv);
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(bytes), cipher.final()]).toString(),
    );
  } catch {
    throw Object.assign(new Error("Calendar credentials unavailable"), {
      code: "CALENDAR_SECRET",
    });
  }
}
export function signTicket(secret, owner, kind, nonce, now, seconds = 600) {
  return seal(secret, "calendar-ticket", {
    owner,
    kind,
    nonce,
    exp: Date.parse(now) + seconds * 1000,
  });
}
export function readTicket(secret, ticket, now) {
  try {
    requireThat(
      typeof ticket === "string" && ticket.length < 2048,
      "CALENDAR_LINK",
      "Открой новую ссылку из бота.",
    );
    const data = unseal(secret, "calendar-ticket", ticket);
    requireThat(
      /^[1-9]\d{0,19}$/u.test(data.owner) &&
        ["setup", "google", "select"].includes(data.kind) &&
        /^[a-f0-9]{48}$/u.test(data.nonce) &&
        data.exp > Date.parse(now) &&
        data.exp <= Date.parse(now) + 900000,
      "CALENDAR_LINK",
      "Ссылка устарела. Открой новую из бота.",
    );
    return data;
  } catch {
    requireThat(
      false,
      "CALENDAR_LINK",
      "Ссылка подключения устарела или недействительна. Открой новую из бота.",
    );
  }
}
export const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
