import { createHash } from "node:crypto";
import { requireThat } from "../errors.mjs";
import { addDays, dayAt, validDay } from "../dates.mjs";

export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const remoteKey = (owner, connection, item) =>
  "bob" + digest(`${owner}|${connection}|${item}`).slice(0, 48);
export function syncRange(now) {
  const start = now.slice(0, 10);
  return {
    start: addDays(start, -1) + "T00:00:00.000Z",
    end: addDays(start, 91) + "T00:00:00.000Z",
  };
}
export function canonical(value) {
  if (value.status === "cancelled" || value.status === "completed")
    return { status: "cancelled" };
  const at = value.at ? new Date(value.at).toISOString() : null,
    day = at ? null : value.day,
    allDay = !at;
  requireThat(
    at || validDay(day),
    "CALENDAR_EVENT",
    "В событии не удалось определить дату.",
  );
  const duration = at ? (value.duration ?? 30) : null,
    span =
      value.all_day && validDay(value.source_day) && validDay(value.end_day)
        ? Math.max(
            1,
            Math.round(
              (Date.parse(value.end_day) - Date.parse(value.source_day)) /
                86400000,
            ),
          )
        : null,
    endDay = allDay
      ? span
        ? addDays(day, span)
        : value.end_day && value.end_day > day
          ? value.end_day
          : addDays(day, 1)
      : null;
  requireThat(
    !at || (Number.isFinite(duration) && duration > 0 && duration <= 10080),
    "CALENDAR_EVENT",
    "Некорректная длительность события календаря.",
  );
  return {
    status: "open",
    title: [...String(value.title ?? "Событие")].slice(0, 300).join(""),
    at,
    day,
    duration,
    all_day: allDay ? 1 : 0,
    end_day: endDay,
  };
}
export function localPatch(body, zone) {
  return {
    title: body.title,
    at: body.at,
    day: body.at ? dayAt(body.at, zone) : body.day,
    duration: body.duration,
    status: body.status,
  };
}
export function googleBody(item) {
  const body = canonical(item);
  return {
    summary: body.title,
    start: body.at ? { dateTime: body.at } : { date: body.day },
    end: body.at
      ? {
          dateTime: new Date(
            Date.parse(body.at) + body.duration * 60000,
          ).toISOString(),
        }
      : { date: body.end_day },
  };
}
export function fromGoogle(event) {
  requireThat(
    typeof event.id === "string" && event.id.length <= 1024,
    "CALENDAR_EVENT",
    "В событии нет идентификатора.",
  );
  if (event.status === "cancelled")
    return {
      id: event.id,
      etag: event.etag,
      body: { status: "cancelled" },
      raw: event,
    };
  const at = event.start?.dateTime,
    end = event.end?.dateTime,
    body = canonical({
      title: event.summary ?? "Событие",
      at,
      day: event.start?.date,
      end_day: event.end?.date,
      duration: at ? (Date.parse(end) - Date.parse(at)) / 60000 : null,
      status: "open",
    });
  return {
    id: event.id,
    etag: event.etag,
    body,
    raw: event,
    resource: event.id,
  };
}
