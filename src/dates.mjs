import { BobError, requireThat } from './errors.mjs';

const MONTHS = [/^январ[ья]$/, /^феврал[ья]$/, /^марта?$/, /^апрел[ья]$/, /^ма[йя]$/, /^июн[ья]$/, /^июл[ья]$/, /^августа?$/, /^сентябр[ья]$/, /^октябр[ья]$/, /^ноябр[ья]$/, /^декабр[ья]$/];
const WEEKDAYS = ['воскресень', 'понедельник', 'вторник', 'сред', 'четверг', 'пятниц', 'суббот'];
export const normalize = text => String(text).toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
export function partsAt(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const result = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return result;
}
export const dayAt = (instant, timezone) => { const p = partsAt(instant, timezone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
export function addDays(day, count) { return new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }
export function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day;
}
export function localToUtc(day, time, timezone) {
  requireThat(validDay(day) && /^\d{2}:\d{2}$/.test(time), 'INVALID_DATE', 'Укажи существующую дату и время.');
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  requireThat(hour <= 23 && minute <= 59, 'INVALID_TIME', 'Время должно быть от 00:00 до 23:59.');
  const target = Date.UTC(year, month - 1, date, hour, minute);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = partsAt(guess, timezone);
    const difference = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += difference;
    if (!difference) break;
  }
  const same = value => { const p = partsAt(value, timezone); return p.year === year && p.month === month && p.day === date && p.hour === hour && p.minute === minute; };
  requireThat(same(guess), 'DST_GAP', 'Это местное время не существует из-за перевода часов. Укажи другое.');
  for (const offset of [-120, -90, -60, -30, 30, 60, 90, 120]) requireThat(!same(guess + offset * 60000), 'DST_AMBIGUOUS', 'Это время повторяется при переводе часов. Укажи другое время вне повторяющегося часа.');
  return new Date(guess).toISOString();
}

export function resolveDate(phrase, { now, timezone = 'Asia/Tomsk', requireTime = false, allowPast = false } = {}) {
  const text = normalize(phrase);
  requireThat(!/кажд|еженед|ежеднев|раз[а]?\s+в\s+недел/u.test(text), 'REPEAT_UNSUPPORTED', 'Повторяющиеся серии пока не подключены к этому ядру. Можно добавить разовое занятие с точной датой.');
  requireThat(text.length > 0 && text.length <= 160, 'DATE_MISSING', 'На какую дату?', { append: true });
  requireThat(!/следующ|ближайш|вечер|утр|после\s+пар|после\s+обеда|через\s+недел/.test(text), 'DATE_UNSUPPORTED', 'Укажи точную дату и, если нужно, время. Например: «6 ноября в 15:00».');
  const zone = /моск|мск/.test(text) ? 'Europe/Moscow' : timezone;
  const today = dayAt(now, zone);
  let date = null;
  let hasYear = false;
  let clock = null;
  const clockMatch = /(?:^|\s)(?:в\s*)?(\d{1,2}):(\d{2})(?!\d)/.exec(text) ?? /(?:^|\s)в\s+(\d{1,2})(?:\s*(?:час(?:а|ов)?))?(?=\s|$)/.exec(text);
  if (clockMatch) {
    const hour = Number(clockMatch[1]), minute = Number(clockMatch[2] ?? 0);
    requireThat(hour < 24 && minute < 60, 'INVALID_TIME', 'Укажи время от 00:00 до 23:59.');
    clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const relativeWords = text.match(/послезавтра|завтра|сегодня|завтрашн[а-я]*/gu) ?? [];
  requireThat(new Set(relativeWords.map(word => word === 'послезавтра' ? 2 : word === 'сегодня' ? 0 : 1)).size <= 1, 'DATE_CONFLICT', 'В сообщении разные даты. Какую использовать?');
  let relative = null;
  if (/послезавтра/.test(text)) relative = 2;
  else if (/завтра|завтрашн/.test(text)) relative = 1;
  else if (/сегодня/.test(text)) relative = 0;
  if (relative !== null) date = addDays(today, relative);
  const iso = /(?:^|\s)(\d{4}-\d{2}-\d{2})(?=\s|$)/.exec(text);
  const dotted = /(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?=\s|$)/.exec(text);
  const named = /(?:^|\s)(\d{1,2})\s+([а-я]+)(?:\s+(\d{4}))?/.exec(text);
  let explicit = null;
  if (iso) { explicit = iso[1]; hasYear = true; }
  else if (dotted) { explicit = `${dotted[3] ?? today.slice(0, 4)}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`; hasYear = Boolean(dotted[3]); }
  else if (named) {
    const month = MONTHS.findIndex(pattern => pattern.test(named[2]));
    if (month >= 0) { explicit = `${named[3] ?? today.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}`; hasYear = Boolean(named[3]); }
  }
  if (explicit) {
    requireThat(validDay(explicit), 'INVALID_DATE', 'Такой даты нет в календаре. Укажи правильную дату.');
    requireThat(!date || date === explicit, 'DATE_CONFLICT', 'В сообщении разные даты. Какую использовать?');
    if (!hasYear && explicit < today) throw new BobError('YEAR_AMBIGUOUS', 'Эта дата уже прошла в текущем году. Укажи год.');
    date = explicit;
  }
  const weekdayWord = /(?:^|[^а-я])(понедельник(?:а|у|ом)?|вторник(?:а|у|ом)?|сред(?:а|у|е|ой)|четверг(?:а|у|ом)?|пятниц(?:а|у|е|ей|ы)|суббот(?:а|у|е|ой|ы)|воскресень(?:е|я|ю|ем))(?=$|[^а-я])/u.exec(text);
  const weekday = weekdayWord ? WEEKDAYS.findIndex(stem => weekdayWord[1].startsWith(stem)) : -1;
  if (weekday >= 0) {
    const current = new Date(`${today}T12:00:00Z`).getUTCDay();
    const nearest = addDays(today, (weekday - current + 7) % 7);
    if (date) requireThat(new Date(`${date}T12:00:00Z`).getUTCDay() === weekday, 'WEEKDAY_CONFLICT', 'Дата и день недели не совпадают. Уточни дату.');
    else date = nearest;
  }
  let remainder = text;
  for (const match of [clockMatch, iso, dotted, explicit && !iso && !dotted ? named : null, weekdayWord]) if (match) remainder = remainder.replace(match[0], ' ');
  remainder = remainder.replace(/послезавтра|завтра|сегодня|завтрашн[а-я]*/gu, ' ');
  const allowedWords = new Set(['в', 'на', 'к', 'до', 'с', 'по', 'москве', 'москвы', 'московскому', 'времени', 'мск', 'день', 'дня', 'года', 'г', 'начиная']);
  const leftovers = remainder.replace(/[.,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  requireThat(leftovers.every(word => allowedWords.has(word)), 'DATE_UNSUPPORTED', 'Не удалось однозначно разобрать дату. Укажи её явно, например: «6 ноября в 15:00».');
  requireThat(date, 'DATE_MISSING', 'На какой день?', { append: true });
  requireThat(!requireTime || clock, 'TIME_MISSING', 'Во сколько?', { append: true });
  const at = clock ? localToUtc(date, clock, zone) : null;
  requireThat(allowPast || (at ? Date.parse(at) > Date.parse(now) : date >= today), 'DATE_IN_PAST', 'Это время уже прошло. Укажи новую дату.');
  return { day: date, at, precision: clock ? 'minute' : 'day', timezone: zone, source: String(phrase) };
}

export function verifyDatePhrase(phrase, source) {
  const text = normalize(phrase), evidence = normalize(source);
  const ignored = new Set(['в', 'на', 'к', 'до', 'с', 'дня', 'день', 'по', 'начиная']);
  const tokens = text.match(/[а-яa-z]+|\d{1,4}(?::\d{2})?/g) ?? [];
  requireThat(tokens.length > 0 && tokens.every(token => ignored.has(token) || evidence.includes(token)), 'UNGROUNDED_DATE', 'Дата должна происходить из твоего сообщения. Уточни её обычным текстом.');
}
export function formatDate(day, at, timezone) {
  if (!at) return `${day} (без точного времени)`;
  return new Intl.DateTimeFormat('ru', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
}
