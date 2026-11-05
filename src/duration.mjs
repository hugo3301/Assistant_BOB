import { normalize, cleanUserText } from "./dates.mjs";

const NUMBERS = {
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
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
  тысяча: 1000,
  полтора: 1.5,
  полторы: 1.5,
};
const wordNames = Object.keys(NUMBERS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const wordSequence = new RegExp(
  `(?<![а-я])(?:${wordNames})(?:\\s+(?:${wordNames}))*(?![а-я])`,
  "gu",
);
const NUMBER = "-?\\d+(?:[.,]\\d+)?",
  HOUR = "(?:час(?:а|ов)?|ч\\.?)",
  MINUTE = "(?:мин(?:ут[а-я]*)?\\.?)";
const EXPRESSION = `(?:полчаса|(?:${NUMBER}\\s*${HOUR}|час)(?:\\s*(?:и\\s+)?${NUMBER}\\s*${MINUTE})?|${NUMBER}\\s*${MINUTE})`;
const WORK =
  "(?:поработать|работать|позаниматься|заниматься|учиться|готовиться|порешать|решать|пописать|писать|потренироваться|тренироваться)";
function minutes(text) {
  if (text === "полчаса") return 30;
  const source = text.replaceAll(",", ".");
  const hour = new RegExp(`^(${NUMBER})?\\s*${HOUR}(?=$|[^а-я])`, "u").exec(
    source,
  );
  if (hour) {
    const tail = source
      .slice(hour[0].length)
      .replace(/^\s*и\s+/u, "")
      .trim();
    return Number(hour[1] ?? 1) * 60 + (tail ? Number.parseFloat(tail) : 0);
  }
  return Number.parseFloat(source);
}

export function readDuration(text) {
  let ambiguous = false;
  const source = normalize(cleanUserText(text)).replace(
    wordSequence,
    (phrase) => {
      const values = phrase.split(/\s+/u).map((word) => NUMBERS[word]);
      for (let i = 1; i < values.length; i++) {
        const previous = values[i - 1],
          next = values[i],
          ceiling =
            previous >= 1000
              ? 1000
              : previous >= 100
                ? 100
                : previous >= 20 && previous % 10 === 0
                  ? 10
                  : 0;
        if (next >= ceiling || !Number.isInteger(next)) ambiguous = true;
      }
      return String(values.reduce((sum, value) => sum + value, 0));
    },
  );
  if (ambiguous) return null;
  if (new RegExp(`^${EXPRESSION}$`, "u").test(source)) return minutes(source);
  const candidates = [];
  const accept = (value, index, end, { checkBefore = false } = {}) => {
    const before = source.slice(0, index),
      after = source.slice(end);
    if (
      checkBefore &&
      /(?:^|\s)(?:в|к|через|спустя|за|до|после|около)\s*$/u.test(before)
    )
      return;
    if (
      checkBefore &&
      /(?:час(?:а|ов)?|полчаса|мин(?:ут[а-я]*)?)\s+(?:и|или)\s*$/u.test(before)
    )
      return;
    if (
      checkBefore &&
      /^-?\d/u.test(value) &&
      /(?:^|[^\d:])-?\d+(?:[.,]\d+)?\s+(?:(?:и|или)\s+)?$/u.test(before)
    )
      return;
    if (
      /^\s*(?:раньше|позже|назад|до|после|спустя)(?=$|\s)/u.test(after) ||
      /^\s*(?:[-–—]|или|и)\s*(?:\d|полтора|час|полчаса)/u.test(after)
    )
      return;
    candidates.push(minutes(value));
  };
  const explicit = new RegExp(
    `(?:^|[^а-я])(?:на|выдели(?:ть)?|длительностью|продолжительностью|в течение|нужно|надо|нужен|займет|длится|длительность\\s*[:—-]?|уточнение:)\\s+(${EXPRESSION})(?=$|[^а-я])`,
    "gu",
  );
  for (const match of source.matchAll(explicit))
    accept(match[1], match.index, match.index + match[0].length);
  const beforeWork = new RegExp(
    `(^|[^а-я0-9.,:-])(${EXPRESSION})(?=$|[^а-я])\\s+${WORK}(?=$|[^а-я])`,
    "gu",
  );
  for (const match of source.matchAll(beforeWork)) {
    const index = match.index + match[1].length;
    accept(match[2], index, index + match[2].length, { checkBefore: true });
  }
  const afterWork = new RegExp(
    `(?:^|[^а-я])${WORK}\\s+(${EXPRESSION})(?=$|[^а-я])`,
    "gu",
  );
  for (const match of source.matchAll(afterWork))
    accept(match[1], match.index, match.index + match[0].length);
  const values = [...new Set(candidates)];
  return values.length === 1 ? values[0] : null;
}
