import { normalize, cleanUserText } from "./dates.mjs";
import { zoneLabel } from "./zones.mjs";
import { naturalView } from "./natural.mjs";

const clean = (text) =>
  normalize(cleanUserText(text))
    .replace(/[.!?]+$/u, "")
    .trim();
const SMALL =
  /^(?:привет(?:ик)?|здравствуй(?:те)?|доброе утро|добрый (?:день|вечер)|хай|йо|боб|bob|как (?:ты|дела)|ты как|как жизнь|спасибо(?: большое)?|благодарю|спс|пожалуйста|доброй ночи|спокойной ночи|пока|до (?:связи|встречи))$/u;
const MATH_PREFIX =
  /^(?:(?:ну\s+)?(?:сколько(?: будет| равно)?|чему равно|посчитай|вычисли|реши)\s*[:=]?\s*)/u;
export function mathSource(text) {
  const original = clean(text);
  if (
    !MATH_PREFIX.test(original) &&
    (/^\d{1,2}:\d{2}$/u.test(original) || /^\d{4}-\d{2}-\d{2}$/u.test(original))
  )
    return null;
  let source = original
    .replace(MATH_PREFIX, "")
    .replace(/(?:^|\s)пожалуйста(?:\s|$)/gu, " ")
    .replace(/\s*=\s*\??$/u, "")
    .replace(/умножить на|помножить на/gu, "*")
    .replace(/разделить на|поделить на/gu, "/")
    .replace(/плюс/gu, "+")
    .replace(/минус/gu, "-")
    .replace(
      /[а-я]+/gu,
      (word) =>
        ({
          ноль: 0,
          один: 1,
          одна: 1,
          два: 2,
          две: 2,
          три: 3,
          четыре: 4,
          пять: 5,
          шесть: 6,
          семь: 7,
          восемь: 8,
          девять: 9,
          десять: 10,
          одиннадцать: 11,
          двенадцать: 12,
        })[word] ?? word,
    )
    .replace(/[×хx]/gu, "*")
    .replace(/[÷:]/gu, "/")
    .replace(/,/gu, ".")
    .trim();
  return /\d/u.test(source) &&
    /[+*/^%()-]/u.test(source) &&
    /^[\d.\s+*/^%()-]+$/u.test(source)
    ? source
    : null;
}

// Recursive descent, with explicit size/depth/work limits; no eval/Function.
export function calculate(expression) {
  if (expression.length > 240)
    throw Error("Пример слишком длинный для простого калькулятора.");
  const tokens =
    expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|\*\*|[()+*/^%\-]/gu) ?? [];
  if (
    tokens.length > 100 ||
    tokens.join("") !== expression.replace(/\s+/gu, "")
  )
    throw Error("Запись примера не распознана.");
  let index = 0,
    depth = 0,
    steps = 0;
  const bounded = (value) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15)
      throw Error("Результат слишком большой для простого калькулятора.");
    return value;
  };
  const primary = () => {
    if (++steps > 200 || ++depth > 16) throw Error("Пример слишком сложный.");
    let value;
    if (tokens[index] === "(") {
      index++;
      value = sum();
      if (tokens[index++] !== ")") throw Error("Проверь скобки.");
    } else {
      const token = tokens[index++];
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(token ?? ""))
        throw Error("Проверь запись примера.");
      value = bounded(Number(token));
    }
    depth--;
    return value;
  };
  const power = () => {
    let value = primary();
    if (["^", "**"].includes(tokens[index])) {
      index++;
      const exponent = unary();
      if (Math.abs(exponent) > 1000) throw Error("Слишком большая степень.");
      value = bounded(value ** exponent);
    }
    return value;
  };
  const unary = () =>
    tokens[index] === "+"
      ? (index++, unary())
      : tokens[index] === "-"
        ? (index++, -unary())
        : power();
  const product = () => {
    let value = unary();
    while (["*", "/", "%"].includes(tokens[index])) {
      const operation = tokens[index++],
        right = unary();
      if ((operation === "/" || operation === "%") && right === 0)
        throw Error("На ноль делить нельзя.");
      value = bounded(
        operation === "*"
          ? value * right
          : operation === "/"
            ? value / right
            : value % right,
      );
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (["+", "-"].includes(tokens[index])) {
      const operation = tokens[index++],
        right = product();
      value = bounded(operation === "+" ? value + right : value - right);
    }
    return value;
  };
  const result = sum();
  if (index !== tokens.length) throw Error("Проверь запись примера.");
  return Object.is(result, -0) ? 0 : Number(result.toPrecision(12));
}
export function viewIntent(text) {
  const source = clean(text);
  if (
    /^\/(?:today|week|ahead|tasks|find)(?:\s|$)/u.test(source) ||
    naturalView(text)
  )
    return true;
  return (
    /^(?:покажи|показать|найди|найти|поищи|список|какие|что\s+(?:у меня|мне)|когда|сколько\s+у меня|какой\s+у меня|мой|мои|мое)/u.test(
      source,
    ) &&
    /(?:дел[аоу]?|задач|пар[аыу]?|расписан|встреч|заняти|срок|дедлайн|сдавать|сдать|план|проект)/u.test(
      source,
    )
  );
}
export function conversationIntent(text, pending = null) {
  const source = clean(text);
  if (
    pending &&
    ["date", "ui_move"].includes(pending.kind) &&
    /^\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?$/u.test(source)
  )
    return false;
  if (mathSource(text) || SMALL.test(source)) return true;
  if (/^\//u.test(source)) return false;
  if (viewIntent(text)) return false;
  return /^(?:что такое|кто (?:такой|такая|ты)|почему|зачем|как(?:\s|$)|сколько(?:\s|$)|расскажи|объясни|можно ли|что (?:ты умеешь|умеешь|значит|означает)|какая (?:(?:сегодня )?погода|сегодня дата)|какой сегодня день|какое сегодня число|который час|сколько времени|что нового|ты (?:живой|бот|человек)|ты меня (?:слышишь|понимаешь)|чем (?:поможешь|занимаешься))/u.test(
    source,
  );
}
export function createIntent(text) {
  const source = clean(text);
  return (
    /(?:^|[^а-я])(?:добав[а-я]*|запиши|записать|создай|создать|заплан[а-я]*|напомни|надо|нужно|не забыть)(?=$|[^а-я])/u.test(
      source,
    ) ||
    /(?:^|\s)[а-я]{2,}(?:ть(?:ся)?|ти(?:сь)?|чь(?:ся)?)(?:\s|[,.!?]|$)/u.test(
      source,
    ) ||
    /(?:сегодня|завтра|послезавтра|через\s|(?:к|до|на)\s+(?:пятниц|понедельник|вторник|сред|четверг|суббот|воскресень)|\d{1,2}\s+(?:январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)|(?:^|\s)(?:в|к)\s+(?:\d|семь|восемь|девять|десять|шесть|пять|четыре|три|два)|\d{1,2}:\d{2})/u.test(
      source,
    )
  );
}
export function fastConversation(text, { now, timezone }) {
  const source = clean(text),
    math = mathSource(text);
  if (math) {
    try {
      const result = calculate(math);
      return (
        math.replaceAll("*", "×") +
        " = " +
        new Intl.NumberFormat("ru", { maximumSignificantDigits: 12 }).format(
          result,
        )
      );
    } catch (error) {
      return error.message;
    }
  }
  if (/^(?:спасибо(?: большое)?|благодарю|спс|пожалуйста)$/u.test(source))
    return "Пожалуйста! Если есть ещё дело — напиши или отправь голосовое.";
  if (
    /^(?:пока|до (?:связи|встречи)|доброй ночи|спокойной ночи)$/u.test(source)
  )
    return "До связи! О сохранённых делах напомню в назначенное время.";
  if (/^(?:как (?:ты|дела)|ты как|как жизнь)$/u.test(source))
    return "На связи. Помогаю держать дела в порядке — напиши дело или посмотри план кнопками ниже.";
  if (SMALL.test(source))
    return "Привет! Можно написать дело обычными словами, отправить голосовое или открыть план кнопками ниже.";
  if (
    /^(?:какой сегодня день|какая сегодня дата|какое сегодня число)$/u.test(
      source,
    )
  )
    return (
      new Intl.DateTimeFormat("ru", {
        timeZone: timezone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(now)) +
      " · " +
      zoneLabel(timezone, now)
    );
  if (/^(?:который час|сколько (?:сейчас )?времени)$/u.test(source))
    return (
      new Intl.DateTimeFormat("ru", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(now)) +
      " · " +
      zoneLabel(timezone, now)
    );
  if (/^(?:что ты умеешь|что умеешь|чем поможешь|кто ты)$/u.test(source))
    return "Я BOB. Записываю задачи и встречи, напоминаю, понимаю голос и .ics. День, неделю и дальние сроки можно посмотреть кнопками; Google и Яндекс подключаются в настройках.";
  if (
    /^(?:как|можно ли)\s+(?:мне\s+)?(?:добавить|создать|записать)\s+(?:дело|задачу|встречу)/u.test(
      source,
    )
  )
    return "Напиши, например: «Сдать отчёт к пятнице» или «Завтра в семь вечера встреча». Я запишу дело и покажу результат. Если ошибусь — есть «Вернуть как было».";
  if (
    /^(?:как|можно ли)\s+(?:мне\s+)?(?:перенести|удалить|отменить|завершить)\s+(?:дело|задачу|встречу)/u.test(
      source,
    )
  )
    return "Открой дело в плане и выбери действие в карточке. Можно и словами: «Перенеси встречу на пятницу» или «Сдал отчёт». Этот вопрос сам по себе дела не меняет.";
  return null;
}
