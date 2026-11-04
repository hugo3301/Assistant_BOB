// Static, synthetic review artifact. Forms are disabled and contain no credentials.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setupPage, choosePage, successPage } from "../src/calendars/pages.mjs";
import { escapeHtml } from "../src/calendars/security.mjs";
const output = process.argv[2] ?? "docs/calendar-connect-preview.html";
const examples = [
  ["Google", setupPage("google", "synthetic-demo-ticket")],
  ["Яндекс", setupPage("yandex", "synthetic-demo-ticket")],
  [
    "Выбор календаря",
    choosePage(
      {},
      [{ id: "synthetic", label: "Личный календарь" }],
      "synthetic-demo-ticket",
      { defaultCalendar: true },
    ),
  ],
  ["Готово", successPage("Личный календарь")],
];
const frames = [];
for (const [title, response] of examples) {
  let html = await response.text();
  html = html
    .replace(
      /<form([^>]*)>/gu,
      '<form$1><fieldset disabled style="border:0;padding:0;margin:0;min-width:0">',
    )
    .replaceAll("</form>", "</fieldset></form>")
    .replace(
      /<a\s+[^>]*href="[^"]+"[^>]*>([\s\S]*?)<\/a>/gu,
      "<span>$1</span>",
    );
  frames.push(
    `<section><h2>${escapeHtml(title)}</h2><iframe title="${escapeHtml(title)}" srcdoc="${escapeHtml(html)}" sandbox></iframe></section>`,
  );
}
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BOB · Подключение календарей</title><style>body{font:16px/1.5 system-ui;background:#0e1621;color:#e5edf6;margin:24px}header{max-width:900px}p{color:#adbbcf}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}h2{font-size:18px}iframe{width:100%;height:1300px;border:1px solid #35455e;border-radius:16px;background:#101722}section{min-width:0}</style><header><h1>BOB · Подключение календарей</h1><p>Состояния из настоящего рендерера на вымышленных данных. Формы и ссылки отключены; это визуальный пример, не рабочее подключение.</p></header><div class="grid">${frames.join("")}</div></html>`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html);
console.log(
  JSON.stringify({
    screens: examples.length,
    synthetic: true,
    credentials: false,
    output,
  }),
);
