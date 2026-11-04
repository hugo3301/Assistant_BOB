import ICAL from 'ical.js';
import { createHash } from 'node:crypto';
import { BobError, requireThat } from './errors.mjs';
import { localToUtc, dayAt } from './dates.mjs';
const clean = value => String(value ?? '').replace(/[\u0000-\u001f]/g,' ').trim();
function parse(body) {
  requireThat(typeof body === 'string' && new TextEncoder().encode(body).length <= 200000, 'ICAL_SIZE', 'Для альфы .ics должен быть не больше 200 КБ.');
  let calendar;
  try { calendar = new ICAL.Component(ICAL.parse(body)); } catch { throw new BobError('ICAL_PARSE', 'Не получилось прочитать iCalendar. Пришли корректный .ics.'); }
  requireThat(calendar.name === 'vcalendar', 'ICAL_PARSE', 'Нужен файл VCALENDAR.');
  ICAL.TimezoneService.reset();
  for (const zone of calendar.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
  const components = calendar.getAllSubcomponents('vevent');
  requireThat(components.length > 0 && components.length <= 500, 'ICAL_SIZE', 'Нужен календарь от 1 до 500 исходных событий.');
  const groups = [], events = [];
  for (const component of components) {
    if (component.hasProperty('recurrence-id')) continue;
    const title = clean(component.getFirstPropertyValue('summary')) || 'Занятие', description = clean(component.getFirstPropertyValue('description')), location = clean(component.getFirstPropertyValue('location'));
    const key = JSON.stringify([title,description,location]); let group = groups.findIndex(group => group.key === key);
    if (group < 0) { group = groups.length; groups.push({key,title,description,location}); }
    const event = new ICAL.Event(component); requireThat(event.uid && event.startDate, 'ICAL_EVENT', 'В событии отсутствует UID или DTSTART.');
    events.push({ event, group: group + 1 });
  }
  return { groups, events };
}
function instant(time, event, userZone, property = 'dtstart') {
  requireThat(!time.isDate, 'ICAL_DATE_ONLY', 'В расписании есть занятие без точного времени. Для него нужен отдельный ввод задачи, а не встреча.');
  const zone = event.component.getFirstProperty(property)?.getParameter('tzid') ?? time.zone?.tzid;
  if (time.zone === ICAL.Timezone.utcTimezone || (zone && zone !== 'floating' && ICAL.TimezoneService.has(zone))) return time.toJSDate().toISOString();
  const day = `${time.year}-${String(time.month).padStart(2,'0')}-${String(time.day).padStart(2,'0')}`, clock = `${String(time.hour).padStart(2,'0')}:${String(time.minute).padStart(2,'0')}`;
  try { return localToUtc(day,clock,!zone || zone === 'floating' ? userZone : zone); }
  catch { throw new BobError('ICAL_ZONE', `Не удалось определить время занятия: ${zone ?? userZone}. Укажи корректный часовой пояс в файле.`); }
}
export function calendarPreview(body, timezone, now) {
  const parsed = parse(body);
  const example = parsed.groups.length === 1 ? '1' : parsed.groups.length === 2 ? '1,2' : '1,3';
  return { ...parsed, text: `Нашёл ${parsed.groups.length} групп занятий. Ничего не импортировано. Выбери только свои: /ical keep ${example}\nВремя без TZID будет прочитано как ${timezone}. Горизонт — 90 дней от ${dayAt(now,timezone)}.\n\n${parsed.groups.map((group,index) => `${index+1}. ${group.title}\n${[group.description.slice(0,240),group.location].filter(Boolean).join(' · ')}`).join('\n\n')}` };
}
export function calendarImport(store, owner, body, selected, now, dryRun = false) {
  const {groups,events} = parse(body), timezone = store.user(owner).timezone;
  requireThat(selected.length > 0 && selected.every(number => Number.isInteger(number) && number >= 1 && number <= groups.length), 'ICAL_SELECTION', 'Укажи номера групп из списка через запятую.');
  const horizon = new Date(Date.parse(now) + 90*86400000).toISOString(), planned = []; let steps = 0;
  for (const {event,group} of events.filter(entry => selected.includes(entry.group))) {
    const iterator = event.iterator();
    while (true) {
      requireThat(++steps <= 5000, 'ICAL_LIMIT', 'Слишком сложная или длинная серия. Нужен экспорт текущего семестра.');
      const next = iterator.next(); if (!next) break;
      const details = event.getOccurrenceDetails(next), current = details.item;
      if (String(current.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') continue;
      const at = instant(details.startDate,current,timezone), end = instant(details.endDate,current,timezone,'dtend');
      if (at >= horizon) break;
      if (at <= now) continue;
      const duration = (Date.parse(end)-Date.parse(at))/60000;
      requireThat(Number.isInteger(duration) && duration > 0 && duration <= 1440, 'ICAL_DURATION', 'Для каждого занятия нужны корректные начало и конец (до суток).');
      const source = `${event.uid}|${next.toString()}`, id = `ical-${createHash('sha256').update(owner+'|'+source).digest('hex').slice(0,24)}`;
      const title = clean(current.summary) || groups[group-1].title;
      planned.push({id,owner,kind:'event',title:title.slice(0,300),day:dayAt(at,timezone),at,duration,area:'Учёба',project:null,source_key:source});
      requireThat(planned.length <= 1000, 'ICAL_LIMIT', 'В выбранном расписании больше 1000 вхождений. Сократи выбор.');
    }
  }
  let added = 0, skipped = 0, updated = 0;
  for (const item of planned) {
    const existing = store.item(owner,item.id);
    if (existing) {
      if (existing.status === 'open' && (existing.at !== item.at || existing.duration !== item.duration || existing.title !== item.title)) { updated++; if (!dryRun) store.changeItem(owner,item.id,{title:item.title,day:item.day,at:item.at,duration:item.duration},now); }
      else skipped++;
    } else { added++; if (!dryRun) store.putItem(item,now,store.user(owner).reminder_minutes); }
  }
  return {added,skipped,updated};
}
