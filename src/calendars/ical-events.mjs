import ICAL from "ical.js";
import { requireThat } from "../errors.mjs";
import { localToUtc } from "../dates.mjs";
import { canonical } from "./model.mjs";

function calendarOf(source) {
  try {
    const calendar = new ICAL.Component(ICAL.parse(source));
    requireThat(
      calendar.name === "vcalendar",
      "CALENDAR_ICS",
      "Нужен календарь iCalendar.",
    );
    ICAL.TimezoneService.reset();
    for (const zone of calendar.getAllSubcomponents("vtimezone"))
      ICAL.TimezoneService.register(zone);
    return calendar;
  } catch {
    requireThat(
      false,
      "CALENDAR_ICS",
      "Не удалось прочитать событие календаря. Изменения не применены.",
    );
  }
}
function utc(time, component, property, zone) {
  const tz =
    component.getFirstProperty(property)?.getParameter("tzid") ??
    time.zone?.tzid;
  if (
    time.zone === ICAL.Timezone.utcTimezone ||
    (tz && ICAL.TimezoneService.has(tz))
  )
    return time.toJSDate().toISOString();
  return new Date(
    Date.parse(
      localToUtc(
        time.toString().slice(0, 10),
        time.toString().slice(11, 16),
        !tz || tz === "floating" ? zone : tz,
      ),
    ) +
      time.second * 1000,
  ).toISOString();
}
function bodyOf(details, zone) {
  const component = details.item.component,
    start = details.startDate,
    end = details.endDate;
  return canonical({
    title: component.getFirstPropertyValue("summary") ?? "Событие",
    status:
      String(component.getFirstPropertyValue("status") ?? "").toUpperCase() ===
      "CANCELLED"
        ? "cancelled"
        : "open",
    ...(start.isDate
      ? { day: start.toString(), end_day: end.toString() }
      : {
          at: utc(start, component, "dtstart", zone),
          duration:
            (Date.parse(utc(end, component, "dtend", zone)) -
              Date.parse(utc(start, component, "dtstart", zone))) /
            60000,
        }),
  });
}
export const davId = (resource, uid, rid) =>
  resource +
  "#" +
  Buffer.from(JSON.stringify([uid, rid])).toString("base64url");
export function davRef(id) {
  const index = id.lastIndexOf("#");
  requireThat(
    index > 0,
    "CALENDAR_EVENT",
    "Некорректный идентификатор календаря.",
  );
  try {
    const [uid, rid] = JSON.parse(
      Buffer.from(id.slice(index + 1), "base64url").toString(),
    );
    requireThat(
      typeof uid === "string" && typeof rid === "string",
      "CALENDAR_EVENT",
      "Некорректная ссылка на событие.",
    );
    return { resource: id.slice(0, index), uid, rid };
  } catch {
    requireThat(false, "CALENDAR_EVENT", "Некорректная ссылка на событие.");
  }
}
export function icalEvents(
  source,
  { resource, etag, range, zone = "Asia/Tomsk", target = null },
) {
  const calendar = calendarOf(source),
    components = calendar.getAllSubcomponents("vevent"),
    result = [];
  let steps = 0;
  requireThat(
    components.length <= 2500,
    "CALENDAR_SIZE",
    "Слишком большой календарь для альфы.",
  );
  for (const component of components.filter(
    (value) => !value.hasProperty("recurrence-id"),
  )) {
    const event = new ICAL.Event(component);
    requireThat(event.uid, "CALENDAR_EVENT", "В событии отсутствует UID.");
    if (target && event.uid !== target.uid) continue;
    const recurring = event.isRecurring();
    if (
      String(component.getFirstPropertyValue("status") ?? "").toUpperCase() ===
      "CANCELLED"
    ) {
      if (target || !recurring)
        result.push({
          id: davId(resource, event.uid, target?.rid ?? "single"),
          resource,
          etag,
          body: { status: "cancelled" },
          raw: {
            ical: source,
            uid: event.uid,
            rid: target?.rid ?? "single",
            recurring,
          },
        });
      continue;
    }
    requireThat(
      event.startDate,
      "CALENDAR_EVENT",
      "В событии отсутствует дата.",
    );
    const exceptions = components.filter(
      (value) =>
        value.getFirstPropertyValue("uid") === event.uid &&
        value.hasProperty("recurrence-id"),
    );
    const cancelled = new Set(
      exceptions
        .filter(
          (value) =>
            String(
              value.getFirstPropertyValue("status") ?? "",
            ).toUpperCase() === "CANCELLED",
        )
        .map((value) =>
          value.getFirstPropertyValue("recurrence-id").toString(),
        ),
    );
    for (const exception of exceptions)
      if (
        !cancelled.has(
          exception.getFirstPropertyValue("recurrence-id").toString(),
        )
      )
        event.relateException(exception);
    const iterator = event.iterator();
    while (true) {
      requireThat(
        ++steps <= 20000,
        "CALENDAR_SIZE",
        "Серия слишком длинная для альфы.",
      );
      const next = iterator.next();
      if (!next) break;
      const rid = recurring ? next.toString() : "single";
      if (target && rid !== target.rid) {
        if (!recurring || rid > target.rid) break;
        continue;
      }
      const original = next.isDate
        ? next.toString() + "T00:00:00.000Z"
        : utc(next, component, "dtstart", zone);
      if (!target && original >= range.end) break;
      const body = cancelled.has(rid)
          ? { status: "cancelled" }
          : bodyOf(event.getOccurrenceDetails(next), zone),
        at = body.at ?? (body.day ? body.day + "T00:00:00.000Z" : original),
        end = body.at
          ? new Date(Date.parse(body.at) + body.duration * 60000).toISOString()
          : body.end_day
            ? body.end_day + "T00:00:00.000Z"
            : original;
      if (target || (at < range.end && end >= range.start))
        result.push({
          id: davId(resource, event.uid, rid),
          resource,
          etag,
          body,
          raw: {
            ical: source,
            uid: event.uid,
            rid,
            recurring,
            recurrence: recurring ? next.toJSON() : null,
          },
        });
      if (target || !recurring) break;
    }
    if (!target)
      for (const exception of exceptions) {
        const next = exception.getFirstPropertyValue("recurrence-id"),
          rid = next.toString(),
          id = davId(resource, event.uid, rid);
        if (result.some((value) => value.id === id) || cancelled.has(rid))
          continue;
        const details = event.getOccurrenceDetails(next),
          body = bodyOf(details, zone),
          at = body.at ?? body.day + "T00:00:00.000Z",
          end = body.at
            ? new Date(
                Date.parse(body.at) + body.duration * 60000,
              ).toISOString()
            : body.end_day + "T00:00:00.000Z";
        if (at < range.end && end >= range.start)
          result.push({
            id,
            resource,
            etag,
            body,
            raw: {
              ical: source,
              uid: event.uid,
              rid,
              recurring: true,
              recurrence: next.toJSON(),
            },
          });
      }
  }
  return result;
}
export function writeIcal(remote, item, now) {
  const body = canonical(item),
    source = remote?.raw?.ical,
    calendar = source
      ? calendarOf(source)
      : new ICAL.Component(["vcalendar", [], []]);
  if (!source) {
    calendar.addPropertyWithValue("version", "2.0");
    calendar.addPropertyWithValue(
      "prodid",
      "-//Assistant BOB//Calendar sync//RU",
    );
  }
  let component;
  if (remote?.raw?.recurring) {
    component = calendar
      .getAllSubcomponents("vevent")
      .find(
        (value) =>
          value.getFirstPropertyValue("uid") === remote.raw.uid &&
          value.getFirstPropertyValue("recurrence-id")?.toString() ===
            remote.raw.rid,
      );
    if (!component) {
      const master = calendar
        .getAllSubcomponents("vevent")
        .find(
          (value) =>
            value.getFirstPropertyValue("uid") === remote.raw.uid &&
            !value.hasProperty("recurrence-id"),
        );
      requireThat(
        master,
        "CALENDAR_CONFLICT",
        "Серия изменилась. Обнови календарь.",
      );
      component = new ICAL.Component(
        JSON.parse(JSON.stringify(master.toJSON())),
      );
      for (const name of ["rrule", "rdate", "exdate"])
        component.removeAllProperties(name);
      const recurrence = new ICAL.Property("recurrence-id"),
        start = master.getFirstProperty("dtstart");
      if (start.getParameter("tzid"))
        recurrence.setParameter("tzid", start.getParameter("tzid"));
      recurrence.setValue(ICAL.Time.fromString(remote.raw.rid));
      component.addProperty(recurrence);
      calendar.addSubcomponent(component);
    }
  } else
    component = calendar
      .getAllSubcomponents("vevent")
      .find((value) => value.getFirstPropertyValue("uid") === remote?.raw?.uid);
  if (!component) {
    component = new ICAL.Component("vevent");
    component.addPropertyWithValue("uid", remote.raw.uid);
    calendar.addSubcomponent(component);
  }
  component.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(now), true),
  );
  component.updatePropertyWithValue(
    "sequence",
    Number(component.getFirstPropertyValue("sequence") ?? 0) + 1,
  );
  if (body.status === "cancelled")
    component.updatePropertyWithValue("status", "CANCELLED");
  else {
    component.updatePropertyWithValue("summary", body.title);
    component.updatePropertyWithValue("status", "CONFIRMED");
    for (const name of ["dtstart", "dtend", "duration"])
      component.removeAllProperties(name);
    const start = body.at
        ? ICAL.Time.fromJSDate(new Date(body.at), true)
        : ICAL.Time.fromString(body.day),
      end = body.at
        ? ICAL.Time.fromJSDate(
            new Date(Date.parse(body.at) + body.duration * 60000),
            true,
          )
        : ICAL.Time.fromString(body.end_day);
    component.addPropertyWithValue("dtstart", start);
    component.addPropertyWithValue("dtend", end);
  }
  return calendar.toString();
}
