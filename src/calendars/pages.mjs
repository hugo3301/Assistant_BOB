import { escapeHtml as h } from "./security.mjs";
export const APP_ORIGIN =
  "https://assistant-bob-alpha.assistant-bob.workers.dev";
export const GOOGLE_CALLBACK = APP_ORIGIN + "/calendars/google/callback";
export function page(title, content, { status = 200, cookie } = {}) {
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${h(title)} · BOB</title><style>:root{font:16px/1.5 system-ui,sans-serif;color:#e8edf6;background:#101722;color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:520px;margin:3vh auto}header{color:#96a8c2;font-weight:700;letter-spacing:.12em;font-size:13px}h1{font-size:28px;line-height:1.2;margin:14px 0 20px}p{margin:12px 0;color:#becade}section,form{padding:20px;background:#1b2636;border:1px solid #304159;border-radius:18px;margin:16px 0}label{display:block;font-weight:600;margin:18px 0 6px}input,select,button,.button{font:inherit;width:100%;padding:12px;border-radius:12px;border:1px solid #456084;background:#111c2b;color:#f0f5ff}button,.button{display:block;text-align:center;font-weight:650;text-decoration:none;cursor:pointer;background:#9ddcd4;color:#082421;border:0;margin-top:20px}a{color:#a9ddf1}input[type=checkbox]{width:auto;margin-right:9px}small{display:block;color:#9fadc2;margin-top:8px}footer{font-size:13px;color:#94a4bb;margin:24px 0}.warn{border-left:3px solid #d5b46b;padding-left:12px}.error{color:#ffd1ca}.row{display:flex;align-items:baseline;gap:9px}input:focus,select:focus,button:focus,a:focus{outline:3px solid #84b9e8;outline-offset:3px}</style></head><body><main><header>BOB · КАЛЕНДАРИ</header><h1>${h(title)}</h1>${content}<footer>Личное подключение. Ключи не отправляются в Telegram-чат или модель ИИ.</footer></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // HTML form POSTs with no-referrer carry Origin:null. Keep the origin
        // for CSRF checks, but never disclose a path/query containing a ticket.
        "Referrer-Policy": "strict-origin",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
        ...(cookie ? { "Set-Cookie": cookie } : {}),
      },
    },
  );
}
export function consentText() {
  return "<p>Подключаем один выбранный календарь. Встречи и их изменения передаются в обе стороны. Одновременные правки потребуют выбора версии в BOB.</p><p>Загрузим встречи на ближайшие 90 дней. Новые встречи BOB отправляются только в календарь по умолчанию. Старые дела, задачи со сроком и импортированное расписание массово не выгружаются. Встреча без длительности займёт в календаре 30 минут.</p><p>В альфе обновление — примерно раз в 5 минут. Отключение сохраняет дела в BOB и события в календаре.</p>";
}
export function setupPage(provider, ticket) {
  const google = provider === "google";
  return page(
    google ? "Подключить Google" : "Подключить Яндекс",
    "<p>Сначала войди в аккаунт, затем выбери один календарь. Обмен встречами начнётся после твоего подтверждения.</p>" +
      (google
        ? `<form action="/calendars/google/start" method="post"><input type="hidden" name="ticket" value="${h(ticket)}"><p>Разрешение на список календарей и изменение событий выдаётся на странице Google. BOB не получает пароль Google.</p><p class="warn">Если Google запрещает вход во встроенном браузере Telegram, открой эту страницу во внешнем браузере.</p><button>Продолжить через Google</button></form>`
        : `<form action="/calendars/yandex" method="post" autocomplete="off"><input type="hidden" name="ticket" value="${h(ticket)}"><p>Создай отдельный пароль приложения типа «Календарь» в <a href="https://id.yandex.ru/security/app-passwords" target="_blank" rel="noreferrer">Яндекс ID</a>. Основной пароль аккаунта здесь не нужен.</p><label for="login">Логин Яндекса</label><input id="login" name="login" type="email" autocomplete="username" placeholder="name@yandex.ru" maxlength="254" required><label for="password">Пароль приложения «Календарь»</label><input id="password" name="password" type="password" autocomplete="off" maxlength="128" required><button>Найти мои календари</button></form>`),
  );
}
export function choosePage(
  connection,
  calendars,
  ticket,
  { defaultCalendar = false } = {},
) {
  return page(
    "Выбери календарь",
    `<p>Аккаунт подключён. Обмен начнётся после выбора календаря.</p>${consentText()}<form action="/calendars/select" method="post"><input type="hidden" name="ticket" value="${h(ticket)}"><label for="calendar">Календарь</label><select id="calendar" name="calendar" required>${calendars.map((calendar, index) => `<option value="${index}">${h(calendar.label)}</option>`).join("")}</select><label class="row"><input type="checkbox" name="default" value="yes"${defaultCalendar ? " checked" : ""}>Сюда добавлять новые встречи BOB</label><label class="row"><input type="checkbox" name="consent" value="yes" required>Включить обмен в обе стороны для выбранного календаря</label><button>Включить синхронизацию</button></form>`,
  );
}
export const successPage = (label) =>
  page(
    "Календарь подключён",
    `<section><p><strong>${h(label)}</strong></p><p>Синхронизация включена. Проверить состояние и разрешить конфликты можно в BOB: «Настройки → Календари».</p><a class="button" href="https://t.me/mybob_robot">Вернуться в BOB</a></section>`,
  );
export const errorPage = (text) =>
  page(
    "Не удалось подключить",
    `<section><p class="error">${h(text)}</p><p>Вернись в бот и открой новую ссылку подключения. Существующие дела сохранены.</p><a class="button" href="https://t.me/mybob_robot">В BOB</a></section>`,
    { status: 400 },
  );
