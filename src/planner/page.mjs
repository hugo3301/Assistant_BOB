import { randomBytes } from "node:crypto";
import { GEOMETRY_SOURCE } from "./geometry-source.mjs";
import { STYLES } from "./styles.mjs";
import { CLIENT } from "./client.mjs";

const json = (value) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
export function plannerPage({ demo = null } = {}) {
  const nonce = randomBytes(18).toString("base64");
  const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>BOB · Календарь</title><style>${STYLES}</style>${demo ? "" : `<script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js"></script>`}</head><body><header><div><div class="brand">BOB · ЛИЧНЫЙ ПЛАН</div><h1>Календарь</h1></div><div class="top-actions"><div id="zone" class="zone"></div><button id="refresh" class="icon" aria-label="Обновить дела">↻</button></div></header><main>${demo ? '<p class="preview-tag">Пример · вымышленные дела, изменения отключены</p>' : ""}<div class="tabs" role="tablist" aria-label="Вид плана"><button role="tab" id="tab-day" data-view="day" aria-selected="true">День</button><button role="tab" id="tab-week" data-view="week" aria-selected="false">Неделя</button><button role="tab" id="tab-ahead" data-view="ahead" aria-selected="false">Обзор</button></div><div id="message" role="status" aria-live="polite"></div><div id="content" role="tabpanel" aria-labelledby="tab-day"><p class="pending">Загружаю твой план…</p></div><div id="status" class="status" aria-live="polite"></div><noscript>Для наглядного календаря нужен JavaScript. Текстовый план доступен в BOB: /today и /week.</noscript></main><dialog id="details" aria-labelledby="detail-title"><button id="close-details" class="icon close" aria-label="Закрыть карточку">×</button><div id="detail-content"></div></dialog><script nonce="${nonce}" type="module">const DEMO=${json(demo)};const geometry=${GEOMETRY_SOURCE};${CLIENT}</script></body></html>`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org/js/telegram-web-app.js; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org`,
    },
  });
}
