import { createHash } from "node:crypto";
import { BobError, requireThat } from "../errors.mjs";
import { fromGoogle, googleBody } from "./model.mjs";
import { accepted, request, limitedText } from "./network.mjs";
import {assertPrivateInput} from '../privacy.mjs';
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export function googleAuthorization({
  clientId,
  redirectUri,
  state,
  verifier,
}) {
  requireThat(
    clientId,
    "CALENDAR_CONFIG",
    "Владелец ещё настраивает вход через Google.",
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return url.href;
}
export async function googleToken(fetcher, configuration, fields) {
  const response = await request(
    fetcher,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        ...fields,
      }),
    },
  );
  let data;
  try {
    data = JSON.parse(await limitedText(response, 64000));
  } catch {
    accepted(response);
    throw new BobError(
      "CALENDAR_AUTH",
      "Google вернул непонятный ответ. Повтори подключение.",
    );
  }
  if (data.error === "invalid_grant")
    throw new BobError(
      "CALENDAR_AUTH",
      "Вход в Google истёк или отозван. Нажми «Переподключить» в настройках календаря.",
    );
  if (data.error === "invalid_client")
    throw new BobError(
      "CALENDAR_CONFIG",
      "Владелец должен проверить настройки входа через Google.",
    );
  accepted(response);
  requireThat(
    typeof data.access_token === "string" && data.expires_in > 0,
    "CALENDAR_AUTH",
    "Google не выдал доступ к календарю. Повтори подключение.",
  );
  if (data.scope)
    requireThat(
      GOOGLE_SCOPES.every((scope) => data.scope.split(" ").includes(scope)),
      "CALENDAR_AUTH",
      "Для обмена нужны разрешения на список календарей и изменение событий.",
    );
  return { ...data, expires_at: Date.now() + data.expires_in * 1000 };
}
export class GoogleCalendar {
  constructor({
    credentials,
    configuration,
    saveCredentials = async () => {},
    fetcher = fetch,
    privateInput=assertPrivateInput,
  }) {
    this.credentials = credentials;
    this.configuration = configuration;
    this.saveCredentials = saveCredentials;
    this.fetcher = fetcher;
    this.privateInput=privateInput;
    this.requests = 0;
  }
  async token() {
    if (this.credentials.expires_at > Date.now() + 60000)
      return this.credentials.access_token;
    requireThat(
      this.credentials.refresh_token,
      "CALENDAR_AUTH",
      "Вход в Google истёк. Подключи календарь заново.",
    );
    const next = await googleToken(this.fetcher, this.configuration, {
      grant_type: "refresh_token",
      refresh_token: this.credentials.refresh_token,
    });
    this.credentials = { ...this.credentials, ...next };
    await this.saveCredentials(this.credentials);
    return this.credentials.access_token;
  }
  async api(path, { method = "GET", body, etag } = {}) {
    requireThat(
      ++this.requests <= 16,
      "CALENDAR_BATCH",
      "Много изменений: продолжу синхронизацию следующим проходом.",
    );
    const response = await request(
      this.fetcher,
      "https://www.googleapis.com/calendar/v3/" + path,
      {
        method,
        headers: {
          Authorization: "Bearer " + (await this.token()),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(etag ? { "If-Match": etag } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return response;
  }
  async calendars() {
    const result = [];
    let page = "";
    for (let count = 0; count < 4; count++) {
      const query = new URLSearchParams({
          minAccessRole: "writer",
          maxResults: "250",
          ...(page ? { pageToken: page } : {}),
        }),
        response = await this.api("users/me/calendarList?" + query);
      accepted(response);
      const data = JSON.parse(await limitedText(response));
      for (const item of data.items ?? [])
        if (["owner", "writer"].includes(item.accessRole) && !item.deleted)
          result.push({
            id: item.id,
            label: item.summary ?? "Календарь",
            writable: true,
          });
      page = data.nextPageToken;
      if (!page) return result;
    }
    requireThat(false, "CALENDAR_SIZE", "Слишком много календарей для альфы.");
  }
  path(calendar) {
    return "calendars/" + encodeURIComponent(calendar) + "/events";
  }
  async list(calendar, range) {
    const events = [];
    let page = "";
    for (let count = 0; count < 8; count++) {
      const query = new URLSearchParams({
          timeMin: range.start,
          timeMax: range.end,
          singleEvents: "true",
          showDeleted: "true",
          maxResults: "1000",
          ...(page ? { pageToken: page } : {}),
        }),
        response = await this.api(this.path(calendar) + "?" + query);
      accepted(response);
      const data = JSON.parse(await limitedText(response));
      events.push(
        ...(data.items ?? [])
          .filter((item) => item.eventType !== "birthday")
          .map(fromGoogle),
      );
      page = data.nextPageToken;
      if (!page) return events;
    }
    requireThat(
      false,
      "CALENDAR_SIZE",
      "Слишком много событий. Старые данные сохранены; подключи отдельный календарь.",
    );
  }
  async get(calendar, id) {
    const response = await this.api(
      this.path(calendar) + "/" + encodeURIComponent(id),
    );
    accepted(response, [404, 410]);
    return [404, 410].includes(response.status)
      ? null
      : fromGoogle(JSON.parse(await limitedText(response)));
  }
  async write(calendar, remote, item, { create = false } = {}) {
    this.privateInput(item.title);
    const base = this.path(calendar),
      query = "?sendUpdates=none";
    if (item.status === "cancelled") {
      if (create) return null;
      const response = await this.api(
        base + "/" + encodeURIComponent(remote.id) + query,
        { method: "DELETE", etag: remote.etag },
      );
      accepted(response, [404, 410]);
      return { ...remote, body: { status: "cancelled" } };
    }
    const response = await this.api(
      create
        ? base + query
        : base + "/" + encodeURIComponent(remote.id) + query,
      {
        method: create ? "POST" : "PATCH",
        body: { ...(create ? { id: remote.id } : {}), ...googleBody(item) },
        etag: create ? null : remote.etag,
      },
    );
    if (create && response.status === 409) {
      const found = await this.get(calendar, remote.id);
      requireThat(
        found,
        "CALENDAR_CONFLICT",
        "Не удалось подтвердить созданное событие.",
      );
      return found;
    }
    accepted(response);
    return fromGoogle(JSON.parse(await limitedText(response)));
  }
  async revoke() {
    const token =
      this.credentials.refresh_token ?? this.credentials.access_token;
    if (token)
      await request(this.fetcher, "https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
  }
}
