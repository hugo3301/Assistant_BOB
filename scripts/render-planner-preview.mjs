import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { plannerPage } from "../src/planner/page.mjs";
const output = process.argv[2] ?? "docs/planner-preview.html",
  mode = process.argv[3] ?? "normal";
const now = "2026-11-05T03:00:00.000Z";
let sequence = 0;
const item = (title, fields = {}) => ({
  id: "synthetic-" + ++sequence,
  title,
  kind: "event",
  day: "2026-11-05",
  at: null,
  duration: null,
  all_day: false,
  end_day: null,
  source_day: null,
  project: null,
  area: "Личное",
  approximate: false,
  reminder_minutes: 60,
  source: null,
  ...fields,
});
const items = [
  item("Сдать отчёт", { kind: "task", day: "2026-11-04", area: "Учёба" }),
  item("Лабораторная по программированию", {
    at: "2026-11-05T01:30:00Z",
    duration: 90,
    area: "Учёба",
    source: "Расписание .ics",
  }),
  item("Консультация по диплому", {
    at: "2026-11-05T02:15:00Z",
    duration: 45,
    area: "Учёба",
    project: "Диплом",
  }),
  item("Закончить главу", {
    kind: "task",
    day: "2026-11-05",
    project: "Диплом",
  }),
  item("Встреча команды", {
    at: "2026-11-05T06:00:00Z",
    duration: 60,
    project: "Сайт",
    source: "Google",
  }),
  item("Зал", { at: "2026-11-05T12:00:00Z", duration: 75, area: "Зал" }),
  item("Купить продукты", { at: "2026-11-05T13:45:00Z", duration: null }),
  item("Ночной рабочий интервал", {
    at: "2026-11-05T16:30:00Z",
    duration: 90,
    kind: "work",
  }),
  item("Фестиваль", {
    day: "2026-11-06",
    all_day: true,
    end_day: "2026-11-08",
    source_day: "2026-11-06",
    source: "Яндекс",
  }),
  item("Срок лабораторной", {
    kind: "task",
    day: "2026-11-06",
    at: "2026-11-06T10:00:00Z",
    area: "Учёба",
  }),
  item("Лекция", {
    day: "2026-11-09",
    at: "2026-11-09T03:25:00Z",
    duration: 90,
    area: "Учёба",
  }),
  item("Проверить план проекта", {
    day: "2026-11-10",
    at: "2026-11-10T07:00:00Z",
    duration: 30,
    project: "Сайт",
  }),
  item("Подать заявку на конференцию", {
    kind: "task",
    day: "2027-02-01",
    project: "Диплом",
  }),
  item("Продумать личное портфолио", { kind: "task", day: null }),
];
if (mode === "empty") items.length = 0;
if (mode === "busy") {
  for (let i = 0; i < 25; i++)
    items.push(
      item("Пересечение " + (i + 1) + " · длинное название занятия", {
        at: "2026-11-05T02:00:00Z",
        duration: 90,
        area: "Учёба",
      }),
    );
  for (let i = 0; i < 8; i++)
    items.push(item("Задача без времени " + (i + 1), { kind: "task" }));
}
const demo = {
  now,
  timezone: "Asia/Tomsk",
  zoneLabel: "Томск · UTC+7",
  today: "2026-11-05",
  items,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, await plannerPage({ demo }).text());
console.log(
  JSON.stringify({
    output,
    mode,
    synthetic: true,
    items: items.length,
    credentials: false,
  }),
);
