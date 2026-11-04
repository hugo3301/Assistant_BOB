import ICAL from 'ical.js';
import { createHash } from 'node:crypto';
import { BobError, requireThat } from './errors.mjs';
import { localToUtc, dayAt } from './dates.mjs';
const clean = value => String(value ?? '').replace(/[\u0000-\u001f]/g,' ').trim();
function parse(body) {
  requireThat(typeof body === 'string' && new TextEncoder().encode(body).length <= 1000000, 'ICAL_SIZE', 'Пришли .ics размером до 1 МБ.');
  let calendar;
  try { calendar = new ICAL.Component(ICAL.parse(body)); } catch { throw new BobError('ICAL_PARSE', 'Не получилось прочитать iCalendar. Пришли корректный .ics.'); }
  requireThat(calendar.name === 'vcalendar', 'ICAL_PARSE', 'Нужен файл VCALENDAR.');
  ICAL.TimezoneService.reset();
  for (const zone of calendar.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
  const components = calendar.getAllSubcomponents('vevent');
  requireThat(components.length > 0 && components.length <= 2500, 'ICAL_SIZE', 'Нужен календарь от 1 до 2500 исходных событий.');
  const groups = [], events = [];
  for (const component of components) {
    if (component.hasProperty('recurrence-id')) continue;
    const title = clean(component.getFirstPropertyValue('summary')) || 'Занятие', description = clean(component.getFirstPropertyValue('description')), location = clean(component.getFirstPropertyValue('location'));
    const key = JSON.stringify([title,description,location]); let group = groups.findIndex(group => group.key === key);
    if (group < 0) { group = groups.length; groups.push({key,hash:createHash('sha256').update(key).digest('hex').slice(0,32),title,description,location}); }
    const event = new ICAL.Event(component); requireThat(event.uid && event.startDate, 'ICAL_EVENT', 'В событии отсутствует UID или DTSTART.');
    events.push({ event, group: group + 1 });
  }
  requireThat(events.length>0,'ICAL_EVENT','Файл содержит только изменения отдельных занятий. Пришли полный календарь, чтобы правильно применить их.');
  const identity=JSON.stringify([calendar.getFirstPropertyValue('x-wr-calname')??'',calendar.getFirstPropertyValue('prodid')??'']);
  return { groups, events,calendarId:createHash('sha256').update(identity).digest('hex').slice(0,32) };
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
  const {groups,events,calendarId} = parse(body), timezone = store.user(owner).timezone;
  requireThat(selected.length > 0 && selected.every(number => Number.isInteger(number) && number >= 1 && number <= groups.length), 'ICAL_SELECTION', 'Укажи номера групп из списка через запятую.');
  const horizon = new Date(Date.parse(now) + 90*86400000).toISOString(), planned = []; let steps = 0;
  const previousByUid=new Map(),previousBySource=new Map(),previousByDay=new Map(),cancellations=new Set();
  for(const row of store.db.prepare("SELECT items.id,item_context.source_key FROM items JOIN item_context ON item_context.item_id=items.id WHERE items.owner=? AND items.id LIKE 'ical-%'").all(owner)) {
    if(!row.source_key)continue;previousBySource.set(row.source_key,row);const uid=row.source_key.slice(0,row.source_key.lastIndexOf('|'));const rows=previousByUid.get(uid)??[];rows.push(row);previousByUid.set(uid,rows);
    const key=uid+'|'+row.source_key.slice(row.source_key.lastIndexOf('|')+1, row.source_key.lastIndexOf('|')+11);const daily=previousByDay.get(key)??[];daily.push(row);previousByDay.set(key,daily);
  }
  for (const {event,group} of events.filter(entry => selected.includes(entry.group))) {
    if(String(event.component.getFirstPropertyValue('status')).toUpperCase()==='CANCELLED'){for(const row of previousByUid.get(event.uid)??[])cancellations.add(row.id);continue;}
    for(const property of event.component.getAllProperties('exdate'))for(const date of property.getValues()){const prior=previousBySource.get(`${event.uid}|${date.toString()}`);if(prior)cancellations.add(prior.id);}
    const iterator = event.iterator();
    while (true) {
      requireThat(++steps <= 20000, 'ICAL_LIMIT', 'Слишком сложная или длинная серия. Пришли экспорт текущего семестра.');
      const next = iterator.next(); if (!next) break;
      const details = event.getOccurrenceDetails(next), current = details.item;
      if (String(current.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') {const prior=previousBySource.get(`${event.uid}|${next.toString()}`);if(prior)cancellations.add(prior.id);continue;}
      const at = instant(details.startDate,current,timezone), end = instant(details.endDate,current,timezone,'dtend');
      if (at >= horizon) break;
      if (at <= now) continue;
      const duration = (Date.parse(end)-Date.parse(at))/60000;
      requireThat(Number.isInteger(duration) && duration > 0 && duration <= 1440, 'ICAL_DURATION', 'Для каждого занятия нужны корректные начало и конец (до суток).');
      const source = `${event.uid}|${event.isRecurring()?next.toString():'single'}`;
      const rule=event.component.getFirstPropertyValue('rrule');
      const oncePerDay=event.component.getAllProperties('rrule').length===1&&['DAILY','WEEKLY'].includes(rule?.freq)&&(!rule.parts.BYHOUR||rule.parts.BYHOUR.length===1)&&(!rule.parts.BYMINUTE||rule.parts.BYMINUTE.length===1)&&!event.component.hasProperty('rdate');
      const daily=oncePerDay?previousByDay.get(event.uid+'|'+next.toString().slice(0,10)):null;
      const legacy=!event.isRecurring()&&previousByUid.get(event.uid)?.length===1?previousByUid.get(event.uid)[0]:daily?.length===1?daily[0]:null;
      const id = legacy?.id??`ical-${createHash('sha256').update(owner+'|'+source).digest('hex').slice(0,24)}`;
      const title = clean(current.summary) || groups[group-1].title;
      planned.push({id,owner,kind:'event',title:title.slice(0,300),day:dayAt(at,timezone),at,duration,area:'Учёба',project:null,source_key:source,filter_key:groups[group-1].hash});
      requireThat(planned.length <= 5000, 'ICAL_LIMIT', 'В выбранном расписании больше 5000 вхождений. Сократи выбор.');
    }
  }
  let added = 0, skipped = 0, updated = 0,cancelled=0;
  const unique=new Map();for(const item of planned){const previous=unique.get(item.id);requireThat(!previous||previous.at===item.at&&previous.title===item.title,'ICAL_DUPLICATE','В файле два разных занятия с одинаковым UID и временем повторения. Нужен исправленный экспорт.');unique.set(item.id,item);}
  for (const item of unique.values()) {
    const existing = store.item(owner,item.id);
    const mapping=store.db.prepare('SELECT excluded FROM calendar_items WHERE item_id=? AND owner=?').get(item.id,owner);
    if (existing) {
      if(existing.status==='cancelled'&&mapping?.excluded) {updated++;if(!dryRun){store.db.prepare("UPDATE items SET status='open' WHERE owner=? AND id=?").run(owner,item.id);store.changeItem(owner,item.id,{title:item.title,day:item.day,at:item.at,duration:item.duration,approximate:false},now);}}
      else if (existing.status === 'open' && (existing.at !== item.at || existing.duration !== item.duration || existing.title !== item.title)) { updated++; if (!dryRun) store.changeItem(owner,item.id,{title:item.title,day:item.day,at:item.at,duration:item.duration,approximate:false},now); }
      else skipped++;
    } else { added++; if (!dryRun) store.putItem(item,now,store.user(owner).reminder_minutes); }
    if(!dryRun)store.db.prepare('INSERT INTO calendar_items VALUES (?,?,?,?,0) ON CONFLICT(item_id) DO UPDATE SET calendar_id=excluded.calendar_id,filter_key=excluded.filter_key,excluded=0').run(item.id,owner,calendarId,item.filter_key);
    if(!dryRun)store.db.prepare('UPDATE item_context SET source_key=? WHERE item_id=?').run(item.source_key,item.id);
  }
  for(const id of cancellations){const item=store.item(owner,id);if(item?.status==='open'&&item.at>now){cancelled++;if(!dryRun){store.changeItem(owner,id,{status:'cancelled'},now);store.db.prepare('UPDATE calendar_items SET excluded=2 WHERE item_id=? AND owner=?').run(id,owner);}}}
  return {added,skipped,updated,cancelled};
}
