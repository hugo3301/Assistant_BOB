import { cleanUserText, normalize } from "./dates.mjs";
import { conversationIntent, createIntent, viewIntent } from "./conversation.mjs";

export const PLANNING_ONLY =
  "Я помогаю с задачами, встречами и напоминаниями. Справочные вопросы, рецепты и другие темы здесь не обрабатываю — берегу ресурс для дел.\n\n" +
  "Можно написать: «Завтра в 19:00 приготовить ужин» или «Покажи план на неделю».";

function sourceOf(text) {
  return normalize(cleanUserText(text))
    .replace(/^(?:(?:привет|боб|bob|бро|пожалуйста)[,!:\s]+)+/u, "")
    .replace(/^(?:можешь(?: ли)?|мог бы|не мог бы)\s+(?:ты\s+)?(?:мне\s+)?/u, "")
    .replace(/[.!?]+$/u, "")
    .trim();
}

// An explicit request to record something may legitimately contain any topic.
const RECORD = /^(?:(?:мне|я)\s+)?(?:добав[а-я]*|запиши|записать|создай|создать|заплан[а-я]*|напомни|напоминать|надо|нужно|не забыть)(?=$|[\s:])/u;
const INFORMATION = /^(?:рецепт[а-я]*|ингредиент[а-я]*|состав\s|посоветуй|порекомендуй|подскажи|дай\s|расскажи|объясни|объяснение|сочини|напиши|сгенерируй|нарисуй|переведи|перевод\s|реши|докажи|выведи\s|загугли|погугли|погода|прогноз\s|новости|курс\s+валют|анекдот|шутк|стих[а-я]*|write\s|tell\s|explain\s|recipe\b|what\s|who\s|why\s|how\s|translate\s|ignore\s)/u;
const GENERATE = /^(?:рассказать|объяснить|сочинить|написать|сгенерировать|нарисовать|перевести|решить)(?=$|\s)/u;
const CHANGE = /(?:^|[^а-я])(?:перен[а-я]*|сдвин[а-я]*|передвин[а-я]*|измени|обнови|исправь|удал[а-я]*|убери|отмен[а-я]*|сдал|сделал|готово|выполн[а-я]*|заверш[а-я]*|закончил|отмет[а-я]*|выдели)(?=$|[^а-я])/u;
const EVENT = /(?:^|[^а-я])(?:встреч[а-я]*|пара|пары|лекци[а-я]*|трениров[а-я]*|созвон[а-я]*|собеседовани[а-я]*|заняти[а-я]*|прием|экзамен[а-я]*|консультаци[а-я]*|лабораторн[а-я]*)(?=$|[^а-я])/u;

function targetChoice(source, pending) {
  return pending?.kind === "target" && pending.candidates?.some(
    (item) => source === normalize(item.title) || source === normalize(item.id),
  );
}

// Run before UI free-text fields as well: an unrelated question must not become
// a project name, diet entry, date, target selection or bulk confirmation.
export function unrelatedRequest(text, pending = null) {
  const source = sourceOf(text);
  if (targetChoice(source, pending) || RECORD.test(source) || viewIntent(source))
    return false;
  // Infinitive task titles ("написать отчёт к пятнице") are valid planning.
  // In "можешь написать рецепт?" the same verb is a request to generate text.
  const politeGeneration = /(?:можешь(?: ли)?|мог бы)\s/u.test(normalize(text)) && GENERATE.test(source);
  return conversationIntent(source, pending) || INFORMATION.test(source) || politeGeneration;
}

export function planningIntent(text) {
  const source = sourceOf(text);
  return RECORD.test(source) || viewIntent(source) || createIntent(source) ||
    CHANGE.test(source) || EVENT.test(source) ||
    /^(?:помоги\s+)?(?:организовать|распланир[а-я]*|распредел[а-я]*)\s/u.test(source);
}
