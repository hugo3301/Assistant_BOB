import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { CalendarService } from "../src/calendars/service.mjs";
import { readTicket } from "../src/calendars/security.mjs";
import { APP_ORIGIN, GOOGLE_CALLBACK, setupPage, choosePage } from "../src/calendars/pages.mjs";
import {
  GOOGLE_SCOPES,
  GoogleCalendar,
  googleToken,
} from "../src/calendars/google.mjs";
import { YandexCalendar } from "../src/calendars/yandex.mjs";
const NOW = "2026-11-05T00:00:00.000Z",
  env = {
    CALENDAR_SECRET_KEY: "c".repeat(64),
    GOOGLE_CLIENT_ID: "synthetic.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  },
  headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: APP_ORIGIN,
  };
const queryTicket = (html) => /name="ticket" value="([^"]+)"/u.exec(html)?.[1];

test("calendar forms preserve their Origin without disclosing ticket paths in Referer", async () => {
  for (const response of [setupPage("google", "synthetic-ticket"), setupPage("yandex", "synthetic-ticket"), choosePage({}, [], "synthetic-ticket")]) {
    // Fetch Standard: no-referrer nulls Origin on navigation POST, unlike cors fetch.
    assert.equal(response.headers.get("Referrer-Policy"), "strict-origin");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Security-Policy"), /form-action 'self'/u);
    const html = await response.text();
    assert.doesNotMatch(html, /<meta[^>]+name="referrer"/iu);
    assert.match(html, /method="post"/u);
  }
  assert.match(await setupPage("yandex", "synthetic-ticket").text(), /rel="noreferrer"/u);
});

test("calendar form rejects null, absent and foreign Origin before credentials or ticket consumption", async () => {
  for (const provider of ["google", "yandex"]) {
    const { store, service, calls } = setup();
    try {
      const message = await service.message("", { data: "k|connect|" + provider }, "origin-test"),
        ticket = new URL(message.replyMarkup.inline_keyboard[0][0].url).searchParams.get("ticket"),
        page = await service.http(req("/calendars/connect", { query: "?ticket=" + ticket })),
        cookie = page.headers.get("set-cookie").split(";")[0],
        path = provider === "google" ? "/calendars/google/start" : "/calendars/yandex",
        body = { ticket, login: "synthetic@yandex.ru", password: "synthetic-app-password" };
      assert.equal(page.headers.get("Referrer-Policy"), "strict-origin");
      for (const origin of [null, "null", "https://evil.example"]) {
        const request = req(path, { method: "POST", cookie, body });
        if (origin === null) request.headers.delete("Origin"); else request.headers.set("Origin", origin);
        const response = await service.http(request);
        assert.equal(response.status, 400);
        assert.match(await response.text(), /Открой подключение через кнопку/u);
        assert.equal(calls.length, 0);
        assert.equal(store.db.prepare("SELECT used FROM calendar_setups").get().used, 0);
      }
      assert.equal((await service.http(req(path, { method: "POST", body }))).status, 400);
      assert.equal(calls.length, 0);
      // A valid same-origin form reaches the provider (synthetic only).
      if (provider === "yandex") service.fetcher = async () => { calls.push({ provider }); return new Response(null, { status: 401 }); };
      const accepted = await service.http(req(path, { method: "POST", cookie, body }));
      if (provider === "google") assert.equal(accepted.status, 303);
      else { assert.equal(calls.length, 1); assert.doesNotMatch(await accepted.text(), /Открой подключение через кнопку/u); }
    } finally { store.close(); }
  }
});
test("an expired Google refresh grant requests reconnect instead of claiming a temporary server outage", async () => {
  await assert.rejects(
    googleToken(
      async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      { clientId: "synthetic", clientSecret: "synthetic" },
      { grant_type: "refresh_token", refresh_token: "synthetic" },
    ),
    (error) =>
      error.code === "CALENDAR_AUTH" &&
      error.message.includes("Переподключить"),
  );
});
function req(path, { method = "GET", body, cookie = "", query = "" } = {}) {
  return new Request("https://internal" + path + query, {
    method,
    headers: { ...headers, "x-calendar-path": path, Cookie: cookie },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
}
function setup() {
  const store = new Store();
  store.ensureUser("123");
  const calls = [];
  const service = new CalendarService(store, "123", env, {
    clock: () => NOW,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          scope: GOOGLE_SCOPES.join(" "),
          expires_in: 3600,
        });
      if (url.includes("calendarList"))
        return Response.json({
          items: [
            { id: "chosen", summary: "Личный <calendar>", accessRole: "owner" },
            { id: "shared-readonly", summary: "Чужой", accessRole: "reader" },
          ],
        });
      throw Error("Unexpected provider call");
    },
  });
  return { store, service, calls };
}
async function start(service) {
  const message = await service.message(
      "",
      { data: "k|connect|google" },
      "connect-request",
    ),
    ticket = new URL(
      message.replyMarkup.inline_keyboard[0][0].url,
    ).searchParams.get("ticket"),
    response = await service.http(
      req("/calendars/connect", { query: "?ticket=" + ticket }),
    ),
    cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal(response.status, 200);
  const redirect = await service.http(
    req("/calendars/google/start", {
      method: "POST",
      cookie,
      body: { ticket },
    }),
  );
  assert.equal(redirect.status, 303);
  return { ticket, cookie, url: new URL(redirect.headers.get("location")) };
}

test("Google connect binds state, browser cookie, PKCE, owner and a one-time ticket before selecting a writable calendar", async () => {
  const { store, service, calls } = setup();
  try {
    const first = await start(service);
    assert.equal(first.url.searchParams.get("redirect_uri"), GOOGLE_CALLBACK);
    assert.equal(first.url.searchParams.get("code_challenge_method"), "S256");
    const state = first.url.searchParams.get("state");
    assert.equal(readTicket(env.CALENDAR_SECRET_KEY, state, NOW).owner, "123");
    const callback = await service.http(
      req("/calendars/google/callback", {
        query: "?code=synthetic-code&state=" + state,
        cookie: first.cookie,
      }),
    );
    assert.equal(callback.status, 200);
    const html = await callback.text();
    assert.ok(html.includes("Личный &lt;calendar&gt;"));
    assert.ok(!html.includes("Чужой"));
    assert.ok(!html.includes("synthetic-refresh"));
    assert.equal(service.sync.connections()[0].status, "choosing");
    assert.ok(
      !service.sync.connections()[0].credentials.includes("synthetic-refresh"),
    );
    const selection = queryTicket(html);
    const accepted = await service.http(
      req("/calendars/select", {
        method: "POST",
        cookie: first.cookie,
        body: {
          ticket: selection,
          calendar: "0",
          consent: "yes",
          default: "yes",
        },
      }),
    );
    assert.equal(accepted.status, 200);
    assert.equal(service.sync.connections()[0].status, "active");
    assert.equal(service.sync.connections()[0].calendar_id, "chosen");
    assert.equal(service.sync.connections()[0].is_default, 1);
    assert.equal(
      (
        await service.http(
          req("/calendars/select", {
            method: "POST",
            cookie: first.cookie,
            body: { ticket: selection, calendar: "0", consent: "yes" },
          }),
        )
      ).status,
      400,
    );
    assert.equal(store.items("123").length, 0);
    assert.deepEqual(store.user("123").history, []);
    assert.equal(calls.length, 2);
  } finally {
    store.close();
  }
});
test("CSRF, another browser, altered state, a callback replay and an unlisted calendar are rejected before activation", async () => {
  const { store, service, calls } = setup();
  try {
    const first = await start(service),
      state = first.url.searchParams.get("state");
    const noCookie = await service.http(
      req("/calendars/google/callback", {
        query: "?code=synthetic-code&state=" + state,
      }),
    );
    assert.equal(noCookie.status, 400);
    assert.equal(calls.length, 0);
    const callback = await service.http(
      req("/calendars/google/callback", {
        query: "?code=synthetic-code&state=" + state,
        cookie: first.cookie,
      }),
    );
    const selection = queryTicket(await callback.text());
    assert.equal(
      (
        await service.http(
          req("/calendars/google/callback", {
            query: "?code=synthetic-code&state=" + state,
            cookie: first.cookie,
          }),
        )
      ).status,
      400,
    );
    const invalid = req("/calendars/select", {
      method: "POST",
      cookie: first.cookie,
      body: { ticket: selection, calendar: "1", consent: "yes" },
    });
    assert.equal((await service.http(invalid)).status, 400);
    assert.equal(service.sync.connections()[0].status, "choosing");
    const cross = req("/calendars/select", {
      method: "POST",
      cookie: first.cookie,
      body: { ticket: selection, calendar: "0", consent: "yes" },
    });
    cross.headers.set("Origin", "https://evil.example");
    assert.equal((await service.http(cross)).status, 400);
  } finally {
    store.close();
  }
});
test("setup links and service receipts stay out of model history; a repeated click returns the same link", async () => {
  const { store, service } = setup();
  try {
    const first = await service.message(
        "",
        { data: "k|connect|google" },
        "once",
      ),
      again = await service.message("", { data: "k|connect|google" }, "once");
    assert.equal(
      first.replyMarkup.inline_keyboard[0][0].url,
      again.replyMarkup.inline_keyboard[0][0].url,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM calendar_setups").get().n,
      1,
    );
    assert.deepEqual(store.user("123").history, []);
    const other = new CalendarService(store, "456", env, { clock: () => NOW });
    const ticket = new URL(
      first.replyMarkup.inline_keyboard[0][0].url,
    ).searchParams.get("ticket");
    assert.equal(
      (
        await other.http(
          req("/calendars/connect", { query: "?ticket=" + ticket }),
        )
      ).status,
      400,
    );
  } finally {
    store.close();
  }
});
test("reconnect and disconnect-then-connect reuse the same calendar mapping and keep the original activation boundary", async () => {
  const { store, service } = setup();
  try {
    const original = service.storeConnection("google", {
      refresh_token: "synthetic-first",
    });
    service.sync.activate(
      original.id,
      { id: "chosen", label: "Мой", writable: true },
      { defaultCalendar: true },
    );
    service.sync.import(service.sync.connection(original.id), {
      id: "one",
      etag: "one",
      body: {
        status: "open",
        title: "Из календаря",
        at: "2026-11-06T09:00:00.000Z",
        duration: 30,
        day: null,
        all_day: 0,
        end_day: null,
      },
    });
    const created = service.sync.connection(original.id).enabled_at;
    service.storeConnection(
      "google",
      { refresh_token: "synthetic-second" },
      original.id,
    );
    service.sync.activate(original.id, {
      id: "chosen",
      label: "Мой",
      writable: true,
    });
    assert.equal(service.sync.connection(original.id).enabled_at, created);
    service.sync.disconnect(original.id);
    const fresh = service.storeConnection("google", {
        refresh_token: "synthetic-third",
      }),
      selection = service.ticket("select", "google", {
        connection: fresh.id,
        data: { calendars: [] },
      }),
      nonce = readTicket(env.CALENDAR_SECRET_KEY, selection, NOW).nonce,
      row = store.db
        .prepare("SELECT * FROM calendar_setups WHERE nonce=?")
        .get(nonce);
    assert.equal(service.reusePrevious(row, { id: "chosen" }), original.id);
    service.sync.activate(original.id, {
      id: "chosen",
      label: "Мой",
      writable: true,
    });
    assert.equal(store.items("123").length, 1);
    assert.equal(service.sync.connection(original.id).enabled_at, created);
    assert.equal(
      service.sync.link(original.id, store.items("123")[0].id).remote_id,
      "one",
    );
  } finally {
    store.close();
  }
});
test("Google adapter preserves fields outside the edited event, sends If-Match and stable client IDs, and handles deletion", async () => {
  const calls = [];
  const adapter = new GoogleCalendar({
    credentials: {
      access_token: "synthetic-token",
      expires_at: Date.now() + 3600000,
    },
    configuration: {},
    fetcher: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({
        id: "bob001",
        etag: '"two"',
        summary: "Изменено",
        start: { dateTime: "2026-11-06T09:00:00Z" },
        end: { dateTime: "2026-11-06T10:00:00Z" },
      });
    },
  });
  const item = { title: "Изменено", at: "2026-11-06T09:00:00Z", duration: 60 };
  await adapter
    .write(
      "a@calendar",
      "ignored",
      { ...item, status: "open" },
      { create: true },
    )
    .catch(() => {});
  calls.length = 0;
  await adapter.write("a@calendar", { id: "bob001", etag: '"one"' }, item);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].headers["If-Match"], '"one"');
  assert.ok(calls[0].url.endsWith("?sendUpdates=none"));
  assert.deepEqual(Object.keys(JSON.parse(calls[0].body)).sort(), [
    "end",
    "start",
    "summary",
  ]);
  await adapter.write(
    "a@calendar",
    { id: "bob001", etag: '"two"' },
    { status: "cancelled" },
  );
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].headers["If-Match"], '"two"');
});
const multi = (rows) =>
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    rows +
    "</d:multistatus>",
  row = (href, props) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
test("Yandex discovers only writable calendars through authenticated CalDAV and never follows a foreign URL", async () => {
  const calls = [];
  let step = 0;
  const responses = [
    multi(
      row(
        "/",
        "<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>",
      ),
    ),
    multi(
      row(
        "/principals/me/",
        "<c:calendar-home-set><d:href>/calendars/me/</d:href></c:calendar-home-set>",
      ),
    ),
    multi(
      row(
        "/calendars/me/one/",
        "<d:displayname>Мой</d:displayname><d:resourcetype><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>",
      ) +
        row(
          "/calendars/me/two/",
          "<d:displayname>Чтение</d:displayname><d:resourcetype><c:calendar/></d:resourcetype>",
        ),
    ),
  ];
  const adapter = new YandexCalendar({
    credentials: {
      login: "synthetic@yandex.ru",
      password: "synthetic-app-password",
    },
    fetcher: async (url, options) => {
      calls.push({ url, ...options });
      return new Response(responses[step++], { status: 207 });
    },
  });
  assert.deepEqual(await adapter.calendars(), [
    {
      id: "https://caldav.yandex.ru/calendars/me/one/",
      label: "Мой",
      writable: true,
    },
  ]);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) =>
        call.method === "PROPFIND" &&
        call.headers.Authorization.startsWith("Basic "),
    ),
  );
  adapter.fetcher = async () =>
    new Response(
      multi(
        row(
          "/",
          "<d:current-user-principal><d:href>https://evil.example/principal</d:href></d:current-user-principal>",
        ),
      ),
      { status: 207 },
    );
  await assert.rejects(
    adapter.calendars(),
    (error) => error.code === "CALENDAR_URL",
  );
});
test("a revoked member cannot import or write after an in-flight remote read", async () => {
  const { store, service } = setup();
  try {
    const id = service.sync.create("google", "synthetic");
    service.sync.activate(id, { id: "one", label: "one", writable: true });
    let enabled = true,
      writes = 0;
    service.sync.enabled = () => enabled;
    service.sync.adapter = async () => ({
      list: async () => {
        enabled = false;
        return [
          {
            id: "one",
            etag: "one",
            body: {
              status: "open",
              title: "Встреча",
              at: "2026-11-06T09:00:00.000Z",
              duration: 30,
              day: null,
              all_day: 0,
              end_day: null,
            },
          },
        ];
      },
      write: async () => {
        writes++;
      },
    });
    await assert.rejects(service.sync.sync(id, { force: true }));
    assert.equal(store.items("123").length, 0);
    assert.equal(writes, 0);
  } finally {
    store.close();
  }
});
