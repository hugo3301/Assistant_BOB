import { randomBytes } from "node:crypto";
import { BobError, requireThat } from "../errors.mjs";
import { screen, nav, UI, truncate } from "../ui-kit.mjs";
import { dateHeading, localClock } from "../views.mjs";
import { dayAt, addDays } from "../dates.mjs";
import { CalendarSync } from "./engine.mjs";
import {
  seal,
  unseal,
  signTicket,
  readTicket,
  escapeHtml,
} from "./security.mjs";
import { digest } from "./model.mjs";
import { GoogleCalendar, googleAuthorization, googleToken } from "./google.mjs";
import { YandexCalendar } from "./yandex.mjs";
import {
  APP_ORIGIN,
  GOOGLE_CALLBACK,
  setupPage,
  choosePage,
  successPage,
  errorPage,
  page,
} from "./pages.mjs";
import { limitedText } from "./network.mjs";

const button = (text, action, id = "") => ({
  text,
  callback_data: `k|${action}|${id}`,
});
export class CalendarService {
  constructor(
    store,
    owner,
    env,
    {
      fetcher = fetch,
      clock = () => new Date().toISOString(),
      schedule = async () => {},
      enabled = () => true,
    } = {},
  ) {
    this.store = store;
    this.owner = owner;
    this.env = env;
    this.fetcher = fetcher;
    this.clock = clock;
    this.schedule = schedule;
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS calendar_setups(nonce TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,provider TEXT NOT NULL,connection_id TEXT,data TEXT NOT NULL,secret TEXT,cookie_hash TEXT,expires_at TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS calendar_receipts(owner TEXT NOT NULL,request_id TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(owner,request_id));`);
    this.enabled = enabled;
    this.sync = new CalendarSync(store, owner, {
      clock,
      enabled,
      adapter: (connection) => this.adapter(connection),
    });
  }
  config() {
    return {
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
    };
  }
  scope(connection) {
    return `${this.owner}|${connection.provider}|${connection.id}`;
  }
  async adapter(connection) {
    const credentials = unseal(
      this.env.CALENDAR_SECRET_KEY,
      this.scope(connection),
      connection.credentials,
    );
    return connection.provider === "google"
      ? new GoogleCalendar({
          credentials,
          configuration: this.config(),
          fetcher: this.fetcher,
          saveCredentials: async (next) => {
            const encrypted = seal(
                this.env.CALENDAR_SECRET_KEY,
                this.scope(connection),
                next,
              ),
              saved = this.store.db
                .prepare(
                  "UPDATE calendar_connections SET credentials=? WHERE owner=? AND id=? AND credentials=? AND status!='off'",
                )
                .run(
                  encrypted,
                  this.owner,
                  connection.id,
                  connection.credentials,
                );
            requireThat(
              saved.changes === 1,
              "CALENDAR_CONNECTION_CHANGED",
              "Подключение изменилось во время обновления. Повторю по актуальным настройкам.",
            );
            connection.credentials = encrypted;
          },
        })
      : new YandexCalendar({
          credentials,
          fetcher: this.fetcher,
          zone: this.store.user(this.owner).timezone,
        });
  }
  storeConnection(provider, credentials, reconnectId = null) {
    const id = reconnectId ?? this.sync.create(provider, null),
      connection = this.sync.connection(id);
    requireThat(
      connection.provider === provider && connection.status !== "off",
      "CALENDAR_CONNECTION",
      "Подключение уже отключено. Начни заново.",
    );
    this.store.db
      .prepare(
        "UPDATE calendar_connections SET credentials=?,status='choosing',next_at=NULL,lease_until=NULL WHERE owner=? AND id=?",
      )
      .run(
        seal(this.env.CALENDAR_SECRET_KEY, this.scope(connection), credentials),
        this.owner,
        id,
      );
    return this.sync.connection(id);
  }
  reusePrevious(row, calendar) {
    const current = this.sync.connection(row.connection_id);
    if (current.calendar_id) return current.id;
    const old = this.store.db
      .prepare(
        "SELECT * FROM calendar_connections WHERE owner=? AND provider=? AND calendar_id=? AND status='off' ORDER BY created_at DESC LIMIT 1",
      )
      .get(this.owner, current.provider, calendar.id);
    if (!old) return current.id;
    const credentials = unseal(
      this.env.CALENDAR_SECRET_KEY,
      this.scope(current),
      current.credentials,
    );
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET credentials=?,status='choosing' WHERE owner=? AND id=? AND status='off'",
        )
        .run(
          seal(this.env.CALENDAR_SECRET_KEY, this.scope(old), credentials),
          this.owner,
          old.id,
        );
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET credentials=NULL,status='off' WHERE owner=? AND id=?",
        )
        .run(this.owner, current.id);
      this.store.db
        .prepare(
          "UPDATE calendar_setups SET connection_id=? WHERE owner=? AND nonce=?",
        )
        .run(old.id, this.owner, row.nonce);
    });
    return old.id;
  }
  connectView(provider, reconnectId = null) {
    requireThat(
      ["google", "yandex"].includes(provider),
      "CALENDAR_CONNECTION",
      "Выбери сервис календаря.",
    );
    if (provider === "google")
      requireThat(
        this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET,
        "CALENDAR_CONFIG",
        "Владелец ещё настраивает вход через Google.",
      );
    if (!reconnectId) {
      const existing = this.sync
        .connections()
        .find(
          (value) => value.provider === provider && value.status === "active",
        );
      if (existing) return this.connectionView(existing.id);
    } else
      requireThat(
        this.sync.connection(reconnectId).status !== "off",
        "CALENDAR_CONNECTION",
        "Подключение отключено. Начни заново.",
      );
    const ticket = this.ticket("setup", provider, { data: { reconnectId } });
    return {
      ...screen(
        (reconnectId ? "Переподключить " : "Подключить ") +
          (provider === "google" ? "Google" : "Яндекс"),
        {
          sections: [
            "Открой защищённую страницу, войди в свой аккаунт и выбери один календарь. Обмен в обе стороны включится после подтверждения.",
          ],
          hint: "Ссылка личная и действует 10 минут. Пароли и ключи в чат присылать не нужно.",
        },
      ),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "Перейти к подключению",
              url:
                APP_ORIGIN +
                "/calendars/connect?ticket=" +
                encodeURIComponent(ticket),
            },
          ],
          [button("‹ Календари", "home"), nav(UI.home)],
        ],
      },
    };
  }
  ticket(
    kind,
    provider,
    { connection = null, data = {}, secret = null, cookieHash = null } = {},
  ) {
    const nonce = randomBytes(24).toString("hex"),
      now = this.clock(),
      expires = new Date(Date.parse(now) + 600000).toISOString();
    this.store.db
      .prepare("DELETE FROM calendar_setups WHERE owner=? AND expires_at<?")
      .run(this.owner, now);
    this.store.db
      .prepare(
        "INSERT INTO calendar_setups(nonce,owner,kind,provider,connection_id,data,secret,cookie_hash,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        nonce,
        this.owner,
        kind,
        provider,
        connection,
        JSON.stringify(data),
        secret
          ? seal(
              this.env.CALENDAR_SECRET_KEY,
              `${this.owner}|setup|${nonce}`,
              secret,
            )
          : null,
        cookieHash,
        expires,
      );
    return signTicket(
      this.env.CALENDAR_SECRET_KEY,
      this.owner,
      kind,
      nonce,
      now,
    );
  }
  row(ticket, kind) {
    const data = readTicket(this.env.CALENDAR_SECRET_KEY, ticket, this.clock()),
      row = this.store.db
        .prepare("SELECT * FROM calendar_setups WHERE owner=? AND nonce=?")
        .get(this.owner, data.nonce);
    requireThat(
      data.owner === this.owner &&
        data.kind === kind &&
        row?.kind === kind &&
        !row.used &&
        row.expires_at > this.clock(),
      "CALENDAR_LINK",
      "Ссылка уже использована или устарела. Открой новую из бота.",
    );
    return row;
  }
  take(row) {
    const result = this.store.db
      .prepare(
        "UPDATE calendar_setups SET used=1,secret=NULL WHERE owner=? AND nonce=? AND used=0",
      )
      .run(this.owner, row.nonce);
    requireThat(
      result.changes === 1,
      "CALENDAR_LINK",
      "Ссылка уже использована. Открой новую из бота.",
    );
  }
  cookie(request) {
    return (
      /(?:^|;\s*)bob_calendar_session=([a-f0-9]{48})(?:;|$)/u.exec(
        request.headers.get("cookie") ?? "",
      )?.[1] ?? ""
    );
  }
  checkCookie(request, row) {
    requireThat(
      row.cookie_hash && digest(this.cookie(request)) === row.cookie_hash,
      "CALENDAR_BROWSER",
      "Подключение нужно завершить в том же браузере. Открой новую ссылку из бота.",
    );
  }
  overview() {
    const connections = this.sync.connections(),
      conflicts = this.sync.pending().length;
    return {
      ...screen("📅 Календари", {
        sections: [
          connections.length
            ? connections
                .map(
                  (value) =>
                    `${value.provider === "google" ? "Google" : "Яндекс"} · ${value.label}\n${value.status === "choosing" ? "Выбор календаря не завершён" : value.last_error === "CALENDAR_BATCH" ? "Переношу большую группу изменений" : value.last_error ? "Требуется проверка подключения" : value.last_ok ? "Обмен в обе стороны включён" : "Первое обновление"}${value.is_default ? "\nДля новых встреч BOB" : ""}`,
                )
                .join("\n\n")
            : "Подключи Google и Яндекс для обмена встречами в обе стороны.",
          conflicts
            ? `Нужно выбрать версии · ${conflicts}`
            : "Обновление примерно раз в 5 минут. Задачи со сроком остаются в BOB.",
        ],
        hint: "Встречи из каждого сервиса возвращаются в исходный календарь. Между Google и Яндексом копии автоматически не создаются.",
      }),
      replyMarkup: {
        inline_keyboard: [
          ...connections.map((value) => [
            button(truncate(value.label, 32), "open", value.id),
          ]),
          [
            button("＋ Google", "connect", "google"),
            button("＋ Яндекс", "connect", "yandex"),
          ],
          ...(conflicts ? [[button("Разобрать конфликты", "conflicts")]] : []),
          [nav(UI.settings, "settings"), nav(UI.home)],
        ],
      },
    };
  }
  connectionView(id) {
    const value = this.sync.connection(id);
    return {
      ...screen(
        value.provider === "google" ? "Google Календарь" : "Яндекс Календарь",
        {
          sections: [
            value.label,
            value.status === "choosing"
              ? "Подключение ещё не завершено. Отключи его и начни заново."
              : value.last_error
                ? `Не удалось обновить календарь. ${value.last_error === "CALENDAR_AUTH" ? "Возможно, доступ истёк или отозван." : "Сохранённые дела доступны; попробую позже."}`
                : value.last_ok
                  ? "Обмен работает. Последнее обновление · " +
                    localClock(
                      value.last_ok,
                      this.store.user(this.owner).timezone,
                    )
                  : "Первое обновление ещё выполняется.",
            value.is_default
              ? "Новые встречи BOB отправляются сюда."
              : "Новые встречи BOB сюда автоматически не отправляются.",
          ],
          hint: "Отключение сохранит события в обоих приложениях.",
        },
      ),
      replyMarkup: {
        inline_keyboard: [
          ...(value.status === "active"
            ? [
                [button("Обновить сейчас", "sync", id)],
                ...(!value.is_default
                  ? [[button("Для новых встреч BOB", "default", id)]]
                  : []),
              ]
            : []),
          [
            button("Переподключить", "reconnect", id),
            button("Отключить", "off", id),
          ],
          [button("‹ Календари", "home"), nav(UI.home)],
        ],
      },
    };
  }
  conflictList() {
    const conflicts = this.sync.pending();
    return {
      ...screen("Выберем версии событий", {
        sections: [
          conflicts.length
            ? "Обе стороны изменили одно событие. Я сохранил версии и не стал выбирать за тебя."
            : "Нерешённых конфликтов нет.",
        ],
      }),
      replyMarkup: {
        inline_keyboard: [
          ...conflicts
            .slice(0, 20)
            .map((value) => [
              button(
                truncate(
                  JSON.parse(value.local_json).title ?? "Событие убрано",
                  35,
                ),
                "conflict",
                value.id,
              ),
            ]),
          [button("‹ Календари", "home"), nav(UI.home)],
        ],
      },
    };
  }
  describe(body) {
    if (body.status === "cancelled") return "Событие убрано";
    const user = this.store.user(this.owner),
      today = dayAt(this.clock(), user.timezone),
      day = body.at ? dayAt(body.at, user.timezone) : body.day,
      end = body.at
        ? new Date(Date.parse(body.at) + body.duration * 60000).toISOString()
        : null,
      lastDay = end ? dayAt(end, user.timezone) : addDays(body.end_day, -1);
    return `${body.title}\n${dateHeading(day, today)}\n${end ? localClock(body.at, user.timezone) + "–" + localClock(end, user.timezone) + (lastDay !== day ? " · " + dateHeading(lastDay, today) : "") : "Весь день" + (lastDay > day ? " · по " + dateHeading(lastDay, today) : "")}`;
  }
  conflictView(id) {
    const row = this.sync.pending().find((value) => value.id === id);
    requireThat(
      row,
      "CALENDAR_CONFLICT_GONE",
      "Этот конфликт уже разобран. Обнови список.",
    );
    const connection = this.sync.connection(row.connection_id),
      local = JSON.parse(row.local_json),
      remote = JSON.parse(row.remote_json)?.body ?? { status: "cancelled" },
      user = this.store.user(this.owner),
      describe = (body) => this.describe(body);
    return {
      ...screen("Какую версию оставить?", {
        sections: [
          { title: "BOB", text: describe(local) },
          {
            title: connection.provider === "google" ? "Google" : "Яндекс",
            text: describe(remote),
          },
        ],
        hint: "Выбранная версия будет применена в обоих приложениях. Это может убрать событие, если выбрана версия с отменой.",
      }),
      replyMarkup: {
        inline_keyboard: [
          [button("Оставить BOB", "local", id)],
          [
            button(
              "Оставить " +
                (connection.provider === "google" ? "Google" : "Яндекс"),
              "remote",
              id,
            ),
          ],
          [button("‹ Конфликты", "conflicts"), nav(UI.home)],
        ],
      },
    };
  }
  async message(text, callback, requestId) {
    if (
      this.store.db
        .prepare("SELECT onboarding FROM ui_profiles WHERE owner=?")
        .get(this.owner)?.onboarding
    )
      return null;
    const clean = text.trim().toLowerCase().replaceAll("ё", "е"),
      isCalendar =
        callback?.data?.startsWith("k|") ||
        callback?.data === "n|calendars" ||
        /^\/calendars(?:@mybob_robot)?$/u.test(clean) ||
        /^(?:календари|мои календари|подключения календарей|подключить календарь)$/u.test(
          clean,
        );
    if (!isCalendar) return null;
    const cached = this.store.db
      .prepare(
        "SELECT response FROM calendar_receipts WHERE owner=? AND request_id=?",
      )
      .get(this.owner, requestId);
    if (cached) return JSON.parse(cached.response);
    let response;
    try {
      const [, action = "home", id = ""] = (
        callback?.data?.startsWith("k|") ? callback.data : "k|home|"
      ).split("|");
      if (action === "home") response = this.overview();
      else if (action === "connect") response = this.connectView(id);
      else if (action === "reconnect") {
        const connection = this.sync.connection(id);
        response = this.connectView(connection.provider, id);
      } else if (action === "open") response = this.connectionView(id);
      else if (action === "sync") {
        requireThat(
          this.sync.connection(id).status === "active",
          "CALENDAR_CONNECTION",
          "Подключение не активно.",
        );
        this.store.db
          .prepare(
            "UPDATE calendar_connections SET next_at=? WHERE owner=? AND id=?",
          )
          .run(this.clock(), this.owner, id);
        response = {
          ...screen("Обновление запрошено", {
            sections: [
              "Проверю календарь в фоне. Можно продолжать пользоваться ботом.",
            ],
          }),
          replyMarkup: {
            inline_keyboard: [
              [
                button("Проверить состояние", "open", id),
                button("Календари", "home"),
              ],
              [nav(UI.home)],
            ],
          },
        };
        await this.schedule();
      } else if (action === "default") {
        this.sync.setDefault(id);
        response = this.connectionView(id);
      } else if (action === "off") {
        const value = this.sync.connection(id);
        response = {
          ...screen("Отключить календарь?", {
            sections: [
              value.label,
              "Обмен остановится, сохранённый ключ доступа будет удалён из BOB. События в календаре и дела в BOB останутся.",
            ],
          }),
          replyMarkup: {
            inline_keyboard: [
              [
                button("Отключить", "offconfirm", id),
                button("Оставить", "open", id),
              ],
            ],
          },
        };
      } else if (action === "offconfirm") {
        const value = this.sync.connection(id);
        if (value.status !== "off") {
          let adapter;
          try {
            adapter = await this.adapter(value);
          } catch {}
          this.sync.disconnect(id);
          if (value.provider === "google")
            try {
              await adapter?.revoke();
            } catch {}
        }
        response = this.overview();
        await this.schedule();
      } else if (action === "conflicts") response = this.conflictList();
      else if (action === "conflict") response = this.conflictView(id);
      else if (["local", "remote"].includes(action)) {
        await this.sync.resolve(id, action);
        response = {
          ...screen("Версии согласованы", {
            sections: ["Выбранная версия сохранена."],
          }),
          replyMarkup: {
            inline_keyboard: [
              [
                button("К конфликтам", "conflicts"),
                button("Календари", "home"),
              ],
              [nav(UI.home)],
            ],
          },
        };
        await this.schedule();
      } else
        throw new BobError(
          "CALENDAR_BUTTON",
          "Открой свежий экран календарей.",
        );
    } catch (error) {
      if (!(error instanceof BobError)) throw error;
      response = {
        ...screen("Календари", { sections: [error.message] }),
        status: "error",
        code: error.code,
        replyMarkup: {
          inline_keyboard: [[button("Календари", "home"), nav(UI.home)]],
        },
      };
    }
    response = { status: "ok", changed: 0, modelCalls: 0, ...response };
    this.store.db
      .prepare("INSERT OR IGNORE INTO calendar_receipts VALUES (?,?,?)")
      .run(this.owner, requestId, JSON.stringify(response));
    return response;
  }
  async http(request) {
    try {
      requireThat(
        this.enabled(),
        "CALENDAR_ACCESS",
        "Доступ к альфе отключён.",
      );
      const path = request.headers.get("x-calendar-path"),
        url = new URL(request.url),
        now = this.clock();
      let form;
      if (request.method === "POST") {
        requireThat(
          request.headers.get("origin") === APP_ORIGIN &&
            /^application\/x-www-form-urlencoded(?:;|$)/iu.test(
              request.headers.get("content-type") ?? "",
            ),
          "CALENDAR_BROWSER",
          "Открой подключение через кнопку в BOB.",
        );
        form = new URLSearchParams(
          await limitedText(
            new Response(request.body, { headers: request.headers }),
            16000,
          ),
        );
      }
      const ticket =
        path === "/calendars/google/callback"
          ? url.searchParams.get("state")
          : (form?.get("ticket") ?? url.searchParams.get("ticket"));
      if (path === "/calendars/connect" && request.method === "GET") {
        const row = this.row(ticket, "setup"),
          cookie = randomBytes(24).toString("hex");
        this.store.db
          .prepare(
            "UPDATE calendar_setups SET cookie_hash=? WHERE owner=? AND nonce=?",
          )
          .run(digest(cookie), this.owner, row.nonce);
        const response = setupPage(row.provider, ticket);
        response.headers.set(
          "Set-Cookie",
          `bob_calendar_session=${cookie}; Secure; HttpOnly; SameSite=Lax; Path=/calendars/; Max-Age=900`,
        );
        return response;
      }
      if (path === "/calendars/google/start" && request.method === "POST") {
        const row = this.row(ticket, "setup");
        requireThat(
          row.provider === "google",
          "CALENDAR_LINK",
          "Начни подключение Google заново.",
        );
        this.checkCookie(request, row);
        this.take(row);
        const verifier = randomBytes(32).toString("base64url"),
          state = this.ticket("google", "google", {
            data: JSON.parse(row.data),
            secret: { verifier },
            cookieHash: row.cookie_hash,
          }),
          location = googleAuthorization({
            clientId: this.env.GOOGLE_CLIENT_ID,
            redirectUri: GOOGLE_CALLBACK,
            state,
            verifier,
          });
        return new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (path === "/calendars/google/callback" && request.method === "GET") {
        const row = this.row(ticket, "google");
        this.checkCookie(request, row);
        const secret = unseal(
          this.env.CALENDAR_SECRET_KEY,
          `${this.owner}|setup|${row.nonce}`,
          row.secret,
        );
        this.take(row);
        requireThat(
          !url.searchParams.has("error") && url.searchParams.get("code"),
          "CALENDAR_AUTH",
          "Google не выдал разрешение. Можно начать подключение заново.",
        );
        const credentials = await googleToken(this.fetcher, this.config(), {
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
          redirect_uri: GOOGLE_CALLBACK,
          code_verifier: secret.verifier,
        });
        requireThat(
          credentials.refresh_token,
          "CALENDAR_AUTH",
          "Для фонового обмена нужно разрешить доступ без открытого браузера. Повтори подключение.",
        );
        const connection = this.storeConnection(
            "google",
            credentials,
            JSON.parse(row.data).reconnectId,
          ),
          adapter = await this.adapter(connection);
        let calendars = await adapter.calendars();
        requireThat(
          calendars.length > 0,
          "CALENDAR_PERMISSION",
          "У аккаунта нет календарей с правом записи.",
        );
        if (connection.calendar_id)
          calendars = calendars.filter(
            (value) => value.id === connection.calendar_id,
          );
        requireThat(
          calendars.length,
          "CALENDAR_PERMISSION",
          "Войди в прежний аккаунт и выбери прежний календарь. Для другого аккаунта сначала отключи старое подключение.",
        );
        const selection = this.ticket("select", "google", {
          connection: connection.id,
          data: { calendars },
          cookieHash: row.cookie_hash,
        });
        return choosePage(connection, calendars, selection, {
          defaultCalendar: !this.sync
            .connections()
            .some((value) => value.is_default),
        });
      }
      if (path === "/calendars/yandex" && request.method === "POST") {
        const row = this.row(ticket, "setup");
        requireThat(
          row.provider === "yandex",
          "CALENDAR_LINK",
          "Начни подключение Яндекса заново.",
        );
        this.checkCookie(request, row);
        this.take(row);
        const login = (form.get("login") ?? "").trim(),
          password = (form.get("password") ?? "").replace(/\s+/gu, "");
        requireThat(
          /^[^\s:@]+@[^\s@]+$/u.test(login) &&
            login.length <= 254 &&
            password.length >= 12 &&
            password.length <= 128,
          "CALENDAR_AUTH",
          "Нужны логин и отдельный пароль приложения «Календарь».",
        );
        const adapter = new YandexCalendar({
          credentials: { login, password },
          fetcher: this.fetcher,
        });
        let calendars = await adapter.calendars();
        requireThat(
          calendars.length > 0,
          "CALENDAR_PERMISSION",
          "Яндекс не вернул календарей с правом записи. Проверь пароль приложения типа «Календарь».",
        );
        const connection = this.storeConnection(
          "yandex",
          { login, password },
          JSON.parse(row.data).reconnectId,
        );
        if (connection.calendar_id)
          calendars = calendars.filter(
            (value) => value.id === connection.calendar_id,
          );
        requireThat(
          calendars.length,
          "CALENDAR_PERMISSION",
          "Войди в прежний аккаунт календаря. Для другого аккаунта сначала отключи старое подключение.",
        );
        const selection = this.ticket("select", "yandex", {
          connection: connection.id,
          data: { calendars },
          cookieHash: row.cookie_hash,
        });
        return choosePage(connection, calendars, selection, {
          defaultCalendar: !this.sync
            .connections()
            .some((value) => value.is_default),
        });
      }
      if (path === "/calendars/select" && request.method === "POST") {
        const row = this.row(ticket, "select");
        this.checkCookie(request, row);
        const index = form.get("calendar");
        requireThat(
          /^\d{1,3}$/u.test(index ?? ""),
          "CALENDAR_PERMISSION",
          "Выбери календарь.",
        );
        const calendars = JSON.parse(row.data).calendars,
          calendar = calendars[Number(index)];
        requireThat(
          calendar && form.get("consent") === "yes",
          "CALENDAR_PERMISSION",
          "Подтверди обмен для выбранного календаря.",
        );
        const connectionId = this.reusePrevious(row, calendar);
        this.sync.activate(connectionId, calendar, {
          defaultCalendar: form.get("default") === "yes",
          before: () => this.take(row),
        });
        await this.schedule();
        return successPage(calendar.label);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return errorPage(
        error instanceof BobError
          ? error.message
          : "Не получилось завершить подключение. Открой новую ссылку из BOB.",
      );
    }
  }
}
