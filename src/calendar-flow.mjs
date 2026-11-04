import {normalize,cleanUserText} from './dates.mjs';
import {requireThat} from './errors.mjs';
import {calendarPreview,calendarImport} from './calendar.mjs';

function selection(text,groups,previous=[]) {
  const source=normalize(cleanUserText(text)).replace(/[«»".!?]/gu,'');
  const all=groups.map((_,index)=>index+1);
  if(!/(?:^|\s)не(?:\s|$)|кроме|без/u.test(source)&&(/все\s+(?:мои|мое|пары мои|занятия мои|расписание мое)/u.test(source)||/^(?:да[, ]*)?(?:все|весь файл|добавь все|импортируй все|расставь все|все пары|все занятия|все расписание)$/u.test(source)))return all;
  const subgroup=/подгрупп[а-я]*\s*(\d+)/u.exec(source);
  if(subgroup) {
    const found=groups.flatMap((group,index)=>new RegExp(`подгр(?:упп)?[а-я.]*\\s*${subgroup[1]}(?=$|[^0-9])`,'u').test(normalize(group.title+' '+group.description))?[index+1]:[]);
    requireThat(found.length,'ICAL_SELECTION','Не нашёл эту подгруппу в файле. Напиши её название так, как оно указано в списке.');return found;
  }
  let numbered=source;
  const ordinal={первую:1,первая:1,первый:1,вторую:2,вторая:2,второй:2,третью:3,третья:3,третий:3,четвертую:4,четвертая:4,пятую:5,пятая:5};
  numbered=numbered.replace(/[а-я]+/gu,word=>ordinal[word]??word);
  const words=numbered.replace(/\d+/g,' ').replace(/[\s,;:№+-]/gu,' ').trim().split(/\s+/).filter(Boolean);
  if(/\d/u.test(numbered)&&words.every(word=>['только','и','пары','пара','группы','группу','группа','номера','номер','оставь','выбери','добавь','нужны','мне','мои','все','кроме','без','убери','исключи'].includes(word))) {
    const numbers=[...new Set((numbered.match(/\d+/g)??[]).map(Number))];
    requireThat(numbers.length&&numbers.every(number=>number>0&&number<=groups.length),'ICAL_SELECTION',`В списке ${groups.length} групп. Выбери нужные номера или напиши «все мои».`);
    return /кроме|без|убери|исключи/u.test(source)?(previous.length?previous:all).filter(number=>!numbers.includes(number)):numbers;
  }
  const titleQuery=/^(?:только|оставь|мне нужны|мне нужна|нужны|мои пары[: ]+)\s+(.+)$/u.exec(source)?.[1];
  if(titleQuery&&titleQuery.length>=3) {
    const words=titleQuery.split(/\s+/).filter(word=>word.length>=2);
    const found=groups.flatMap((group,index)=>words.every(word=>normalize(group.title+' '+group.description+' '+group.location).includes(word))?[index+1]:[]);
    requireThat(found.length,'ICAL_SELECTION','Не нашёл такие занятия в этом файле. Можно написать номера из списка.');return found;
  }
  return null;
}
function summary(result) { return result.added+result.updated+result.skipped+result.cancelled?`📅 Расписание расставлено\nБлижайшие 90 дней\n\n${[result.added?`Добавлено · ${result.added}`:'',result.updated?`Обновлено · ${result.updated}`:'',result.skipped?`Уже было · ${result.skipped}`:'',result.cancelled?`Отменено · ${result.cancelled}`:''].filter(Boolean).join('\n')}\n\nНапоминания настроены. Открой «Неделю», чтобы проверить занятия.`:'В выбранных группах нет будущих занятий на ближайшие 90 дней. Ничего не добавлено; проверь период экспорта.'; }
function showGroups(preview,selected=[]) {
  const rows=preview.groups.slice(0,30).map((group,index)=>`${selected.includes(index+1)?'✓ ':''}${index+1}. ${group.title}\n${[group.description.slice(0,240),group.location].filter(Boolean).join(' · ')}`);
  return `${rows.join('\n\n')}${preview.groups.length>30?`\nЕщё ${preview.groups.length-30} групп. Можешь выбрать по названию или подгруппе обычным текстом.`:''}`;
}
function persistChoice(store,owner,body,preview,selected,now) {
  const hashes=selected.map(index=>preview.groups[index-1].hash);
  const result=calendarImport(store,owner,body,selected,now);
  for(const row of store.db.prepare('SELECT item_id,filter_key FROM calendar_items WHERE owner=? AND calendar_id=? AND excluded=0').all(owner,preview.calendarId)) {
    if(hashes.includes(row.filter_key))continue;
    const item=store.item(owner,row.item_id);
    if(item?.status==='open'&&item.at>now){store.changeItem(owner,item.id,{status:'cancelled'},now);store.db.prepare('UPDATE calendar_items SET excluded=1 WHERE item_id=? AND owner=?').run(item.id,owner);}
  }
  store.db.prepare('INSERT INTO calendar_filters VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET calendar_id=excluded.calendar_id,selected_keys=excluded.selected_keys,known_keys=excluded.known_keys').run(owner,preview.calendarId,JSON.stringify(hashes),JSON.stringify(preview.groups.map(group=>group.hash)));
  store.db.prepare('INSERT INTO calendar_previews VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,selected=excluded.selected,created_at=excluded.created_at').run(owner,body,JSON.stringify(selected),now);
  return result;
}
export function prepareCalendarUpload(store,owner,body,caption,now) {
  const preview=calendarPreview(body,store.user(owner).timezone,now);
  if(/не\s+(?:добавляй|импортируй|расставляй)|ничего\s+не|только\s+(?:покажи|посмотри|прочитай)|без\s+импорт/u.test(normalize(caption??'')))return {text:`Прочитал календарь. Ничего не импортировано, как ты попросил. Когда захочешь добавить пары, напиши «все мои» или выбери свои группы.\n\n${showGroups(preview)}`,pending:null,mutate:()=>store.db.prepare('INSERT INTO calendar_previews VALUES (?,?,NULL,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,selected=NULL,created_at=excluded.created_at').run(owner,body,now)};
  const saved=store.db.prepare('SELECT * FROM calendar_filters WHERE owner=?').get(owner);
  const previous=saved?.calendar_id===preview.calendarId?JSON.parse(saved.selected_keys):[];
  const known=saved?.calendar_id===preview.calendarId?JSON.parse(saved.known_keys):[];
  const explicit=selection(caption??'',preview.groups);
  let selected=explicit??preview.groups.flatMap((group,index)=>previous.includes(group.hash)?[index+1]:[]);
  const unknown=preview.groups.filter(group=>!known.includes(group.hash));
  if(explicit===null&&!previous.length&&preview.groups.length===1)selected=[1];
  if(explicit===null&&previous.length&&unknown.length===0&&!selected.length)return {text:'В этом файле нет выбранных тобой групп. Чужие пары не добавлял, твой прежний выбор сохранил.',pending:null,mutate:()=>store.db.prepare('INSERT INTO calendar_previews VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,selected=excluded.selected,created_at=excluded.created_at').run(owner,body,'[]',now)};
  if(selected.length) {
    const result=calendarImport(store,owner,body,selected,now,true);
    const needsChoice=explicit===null&&previous.length>0&&unknown.length>0;
    return {text:summary(result)+(needsChoice?`\n\nЕсть новые группы, я не стал добавлять их молча. Если нужны, напиши полный новый выбор, например «только 1 и 3» или «все мои».\n${showGroups(preview,selected)}`:'\nВыбор запомнил: следующие файлы с известными группами обработаю автоматически.'),pending:null,mutate:()=>{
      if(needsChoice) {
        calendarImport(store,owner,body,selected,now);
        store.db.prepare('INSERT INTO calendar_previews VALUES (?,?,NULL,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,selected=NULL,created_at=excluded.created_at').run(owner,body,now);
      } else persistChoice(store,owner,body,preview,selected,now);
    }};
  }
  return {text:`📅 Выберем твои пары\n\nНашёл ${preview.groups.length} групп занятий. Ничего не импортировано.\n\nНапиши «все мои», «только 1 и 3» или «моя подгруппа 2». Выбор запомню, затем сам расставлю даты, повторы и напоминания.\n\n${showGroups(preview)}`,pending:null,mutate:()=>store.db.prepare('INSERT INTO calendar_previews VALUES (?,?,NULL,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body,selected=NULL,created_at=excluded.created_at').run(owner,body,now)};
}
export function isCalendarAnswer(store,owner,text,now) {
  const staged=store.db.prepare('SELECT * FROM calendar_previews WHERE owner=?').get(owner);
  if(!staged || Date.parse(now)-Date.parse(staged.created_at)>86400000 || store.user(owner)?.pending)return false;
  if(staged.selected!==null&&!/пары|групп|расписан|^только|^оставь/u.test(normalize(text)))return false;
  try {return selection(text,calendarPreview(staged.body,store.user(owner).timezone,now).groups,staged.selected?JSON.parse(staged.selected):[])!==null;} catch{return true;}
}
export function prepareCalendarChoice(store,owner,text,now) {
  const staged=store.db.prepare('SELECT * FROM calendar_previews WHERE owner=?').get(owner);
  requireThat(staged,'CALENDAR','Сначала пришли расписание файлом .ics.');
  const preview=calendarPreview(staged.body,store.user(owner).timezone,now);
  const previous=staged.selected?JSON.parse(staged.selected):[];
  const selected=selection(text.replace(/^keep\s+/iu,''),preview.groups,previous);
  requireThat(selected&&selected.length,'ICAL_SELECTION','Какие пары оставить? Можно написать «все мои», номера или свою подгруппу.');
  const result=calendarImport(store,owner,staged.body,selected,now,true);
  return {text:summary(result)+'\nВыбор запомнил. Следующий файл с этими группами обработаю сам.',pending:null,mutate:()=>persistChoice(store,owner,staged.body,preview,selected,now)};
}
