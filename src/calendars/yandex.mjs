import { requireThat } from "../errors.mjs";
import { accepted, request, limitedText } from "./network.mjs";
import { davResponses, descendants, textAt, xmlEscape } from "./xml.mjs";
import { icalEvents, writeIcal, davId, davRef } from "./ical-events.mjs";
const ROOT = "https://caldav.yandex.ru/";
export function davUrl(value, base = ROOT) {
  let url;
  try {
    url = new URL(value, base);
  } catch {}
  requireThat(
    url &&
      url.protocol === "https:" &&
      url.hostname === "caldav.yandex.ru" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !/%2f|%5c/iu.test(url.pathname),
    "CALENDAR_URL",
    "Яндекс вернул неподдерживаемый адрес CalDAV.",
  );
  return url.href;
}
const document = (tag, body) =>
  `<?xml version="1.0" encoding="utf-8"?><${tag} xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</${tag}>`;
export class YandexCalendar {
  constructor({ credentials, fetcher = fetch, zone = "Asia/Tomsk" }) {
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.zone = zone;
    this.written = new Map();
    this.requests = 0;
  }
  async api(
    url,
    { method = "PROPFIND", body, etag, create = false, depth } = {},
  ) {
    let target = davUrl(url);
    for (let redirect = 0; redirect < 3; redirect++) {
      requireThat(
        ++this.requests <= 16,
        "CALENDAR_BATCH",
        "Много изменений: продолжу синхронизацию следующим проходом.",
      );
      const response = await request(this.fetcher, target, {
        method,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              this.credentials.login + ":" + this.credentials.password,
            ).toString("base64"),
          ...(depth !== undefined ? { Depth: String(depth) } : {}),
          ...(body
            ? {
                "Content-Type":
                  method === "PUT"
                    ? "text/calendar; charset=utf-8"
                    : "application/xml; charset=utf-8",
              }
            : {}),
          ...(etag ? { "If-Match": etag } : {}),
          ...(create ? { "If-None-Match": "*" } : {}),
        },
        ...(body ? { body } : {}),
      });
      if (![301, 302, 307, 308].includes(response.status)) return response;
      requireThat(
        response.headers.get("location"),
        "CALENDAR_URL",
        "Нет адреса перенаправления календаря.",
      );
      target = davUrl(response.headers.get("location"), target);
    }
    requireThat(
      false,
      "CALENDAR_URL",
      "Календарь перенаправляет запрос слишком много раз.",
    );
  }
  async prop(url, properties, depth = 0) {
    const response = await this.api(url, {
      body: document("d:propfind", "<d:prop>" + properties + "</d:prop>"),
      depth,
    });
    accepted(response);
    return davResponses(await limitedText(response));
  }
  async calendars() {
    const principal = await this.prop(ROOT, "<d:current-user-principal/>"),
      principalHref = textAt({ children: principal[0]?.props ?? [] }, "href");
    requireThat(
      principalHref,
      "CALENDAR_AUTH",
      "Яндекс не выдал адрес пользователя. Проверь логин и пароль приложения «Календарь».",
    );
    const homes = await this.prop(
        davUrl(principalHref),
        "<c:calendar-home-set/>",
      ),
      home = textAt({ children: homes[0]?.props ?? [] }, "href");
    requireThat(home, "CALENDAR_AUTH", "Не найден домашний календарь Яндекса.");
    const calendars = await this.prop(
      davUrl(home),
      "<d:displayname/><d:resourcetype/><d:current-user-privilege-set/>",
      1,
    );
    return calendars
      .filter((value) => {
        const node = { children: value.props },
          privileges =
            ["all", "write"].some((name) => descendants(node, name).length) ||
            (descendants(node, "write-content").length &&
              descendants(node, "bind").length);
        return descendants(node, "calendar").length && privileges;
      })
      .map((value) => ({
        id: davUrl(value.href),
        label:
          textAt({ children: value.props }, "displayname") ||
          "Яндекс Календарь",
        writable: true,
      }));
  }
  async list(calendar, range) {
    const collection = davUrl(calendar);
    requireThat(
      collection.endsWith("/"),
      "CALENDAR_URL",
      "Нужна коллекция календаря.",
    );
    const compact = (instant) =>
        instant.replace(/[-:]/gu, "").replace(".000", ""),
      body = document(
        "c:calendar-query",
        `<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${compact(range.start)}" end="${compact(range.end)}"/></c:comp-filter></c:comp-filter></c:filter>`,
      ),
      response = await this.api(collection, {
        method: "REPORT",
        depth: 1,
        body,
      });
    accepted(response);
    const result = [];
    for (const row of davResponses(await limitedText(response))) {
      if (row.status && !/\s200(?:\s|$)/u.test(row.status)) continue;
      const resource = davUrl(row.href, collection);
      requireThat(
        resource.startsWith(collection),
        "CALENDAR_URL",
        "Событие вне выбранного календаря.",
      );
      const source = textAt({ children: row.props }, "calendar-data"),
        etag = textAt({ children: row.props }, "getetag");
      requireThat(
        source && etag,
        "CALENDAR_XML",
        "Не получена полная версия календаря.",
      );
      result.push(
        ...icalEvents(source, { resource, etag, range, zone: this.zone }),
      );
      requireThat(
        result.length <= 8000,
        "CALENDAR_SIZE",
        "Слишком много событий для альфы.",
      );
    }
    return result;
  }
  async get(calendar, id) {
    const ref = davRef(id),
      collection = davUrl(calendar),
      resource = davUrl(ref.resource);
    requireThat(
      resource.startsWith(collection),
      "CALENDAR_URL",
      "Событие вне выбранного календаря.",
    );
    const response = await this.api(resource, { method: "GET" });
    accepted(response, [404, 410]);
    if ([404, 410].includes(response.status)) return null;
    const source = await limitedText(response),
      etag = response.headers.get("etag");
    requireThat(etag, "CALENDAR_XML", "Яндекс не передал версию события.");
    return (
      icalEvents(source, { resource, etag, zone: this.zone, target: ref })[0] ??
      null
    );
  }
  draft(calendar, key) {
    const resource = davUrl(calendar) + key + ".ics";
    return {
      id: davId(resource, key + "@bob", "single"),
      resource,
      raw: { uid: key + "@bob", rid: "single", recurring: false },
    };
  }
  async write(
    calendar,
    remote,
    item,
    { create = false, now = new Date().toISOString() } = {},
  ) {
    const resource = davUrl(remote.resource),
      collection = davUrl(calendar);
    requireThat(
      resource.startsWith(collection),
      "CALENDAR_URL",
      "Событие вне выбранного календаря.",
    );
    let current = remote;
    const previous = this.written.get(resource);
    if (previous)
      current = {
        ...remote,
        etag: previous.etag,
        raw: { ...remote.raw, ical: previous.ical },
      };
    requireThat(
      create || current.etag,
      "CALENDAR_CONFLICT",
      "Неизвестна версия события. Сначала обнови календарь.",
    );
    const source = writeIcal(current, item, now),
      response = await this.api(resource, {
        method: "PUT",
        body: source,
        etag: create ? null : current.etag,
        create,
      });
    if (create && [412, 409].includes(response.status)) {
      const found = await this.get(calendar, remote.id);
      requireThat(
        found,
        "CALENDAR_CONFLICT",
        "Событие с таким адресом уже существует.",
      );
      return found;
    }
    accepted(response);
    const etag = response.headers.get("etag");
    if (!etag) return await this.get(calendar, remote.id);
    this.written.set(resource, { etag, ical: source });
    return (
      icalEvents(source, {
        resource,
        etag,
        zone: this.zone,
        target: davRef(remote.id),
      })[0] ?? {
        ...remote,
        etag,
        body: { status: "cancelled" },
        raw: { ...remote.raw, ical: source },
      }
    );
  }
}
