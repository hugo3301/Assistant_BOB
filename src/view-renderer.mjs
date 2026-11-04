import {dayAt,addDays} from './dates.mjs';
export const PAGE_SIZE=6;
export function displayTitle(title){return String(title).replace(/\s*\((ЛБ|ЛК|ПР)\)\s*/giu,' ').replace(/\s+/g,' ').trim().slice(0,180);}
export function itemType(item){if(/\(ЛБ\)/iu.test(item.title))return '🧪 Лабораторная';if(/\(ЛК\)/iu.test(item.title))return '📖 Лекция';if(/\(ПР\)/iu.test(item.title))return '✍️ Практика';return item.kind==='task'?'📌 Задача':item.kind==='work'?'🛠 Работа':'📅 Событие';}
export function localClock(at,zone){return new Intl.DateTimeFormat('ru',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));}
export function dateHeading(day,today){if(!day)return 'Без срока';const label=new Intl.DateTimeFormat('ru',{timeZone:'UTC',weekday:'short',day:'numeric',month:'long'}).format(new Date(day+'T12:00:00Z'));return(day===today?'Сегодня · ':day===addDays(today,1)?'Завтра · ':'')+label;}
export function selectItems(store,owner,filter,now){
 const scope=typeof filter==='string'?filter:filter.scope??'all',options=typeof filter==='object'?filter:{};
 const today=dayAt(now,store.user(owner).timezone),end=scope==='today'?today:scope==='tomorrow'?addDays(today,1):scope==='week'?addDays(today,6):'9999-12-31';
 return store.items(owner).filter(item=>{if(options.project&&item.project!==options.project)return false;if(options.area&&item.area!==options.area)return false;if(options.query&&!item.title.toLocaleLowerCase('ru').includes(options.query.toLocaleLowerCase('ru')))return false;if(options.date)return item.day===options.date;if(scope==='all'||scope==='ahead'||scope==='project'||scope==='search')return true;if(!item.day)return false;return scope==='tomorrow'?item.day===end:item.day<=end;});
}
export function renderList(items,{scope='all',now,timezone,page=0,pageSize=PAGE_SIZE}={}){
 const today=dayAt(now,timezone),pages=Math.max(1,Math.ceil(items.length/pageSize));page=Math.max(0,Math.min(page,pages-1));
 const labels={today:'📅 Сегодня',tomorrow:'📅 Завтра',week:'🗓 Ближайшие 7 дней',ahead:'🔭 Общая картина',all:'📝 Все дела',search:'🔎 Найденные дела',project:'📂 Проект'};
 const visible=items.slice(page*pageSize,(page+1)*pageSize),lines=[labels[scope]??labels.all];let previousDay;
 const conflicts=new Set(),timed=items.filter(item=>item.kind!=='task'&&item.at).sort((a,b)=>a.at.localeCompare(b.at));let longest=null,end=0;
 for(const item of timed){const start=Date.parse(item.at),finish=start+(item.duration??1)*60000;if(start<end){conflicts.add(item.id);conflicts.add(longest.id);}if(finish>end){longest=item;end=finish;}}
 for(const[index,item]of visible.entries()){
  if(item.day!==previousDay){lines.push('',dateHeading(item.day,today).toLocaleUpperCase('ru'));previousDay=item.day;}
  let time=item.kind==='task'?'Срок':item.at?localClock(item.at,timezone):'Время не указано';
  if(item.at){time=(item.kind==='task'?'До ':'')+localClock(item.at,timezone);if(item.duration&&item.kind!=='task')time+='–'+localClock(new Date(Date.parse(item.at)+item.duration*60000).toISOString(),timezone);if(item.approximate)time='Около '+time;}
  if(item.kind==='task'&&item.day&&(item.at?item.at<now:item.day<today))time='❗ Просрочено · '+time;
  else if(item.kind!=='task'&&item.at&&item.at<=now&&item.duration&&Date.parse(item.at)+item.duration*60000>Date.parse(now))time='Сейчас · '+time;
  lines.push('',`${page*pageSize+index+1}. ${time}${conflicts.has(item.id)?' · ⚠ совпадение':''}`,displayTitle(item.title));
  const type=itemType(item);if(type!=='📌 Задача'&&type!=='📅 Событие')lines.push(type);if(item.project)lines.push('↳ '+item.project);
 }
 if(!items.length)lines.push('',scope==='today'?'На сегодня дел нет.':scope==='tomorrow'?'На завтра дел нет.':'Здесь пока нет дел.');
 if(visible.some(item=>conflicts.has(item.id)))lines.push('','⚠ Есть занятия в одно время. Проверь, какие пары твои.');
 if(items.length>pageSize)lines.push('',`Страница ${page+1} из ${pages} · всего ${items.length}`);
 return{text:lines.join('\n'),visible,page,pages,total:items.length};
}
export function cardText(item,user,now){const status={open:'',completed:'✅ Выполнено',cancelled:'Отменено',elapsed:'Событие уже прошло'}[item.status]??item.status;const lines=[itemType(item),displayTitle(item.title),''];lines.push(item.day?dateHeading(item.day,dayAt(now,user.timezone)):'Без срока');if(item.at){let time=localClock(item.at,user.timezone);if(item.duration)time+='–'+localClock(new Date(Date.parse(item.at)+item.duration*60000).toISOString(),user.timezone);lines.push((item.approximate?'Около ':'')+time);}if(item.project)lines.push('Проект: '+item.project);if(item.reminder_minutes!==null&&item.at)lines.push('Напоминание: за '+item.reminder_minutes+' мин.');if(status)lines.push('',status);return lines.join('\n');}
export function friendlyResponse(response){const messages={TOOL_COUNT:'Не понял действие. Напиши, что нужно сделать: добавить, перенести, завершить или убрать.',TOOL_JSON:'Не смог разобрать просьбу. Попробуй сказать короче — данные не изменены.',TOOL_SCHEMA:'Не хватает деталей. Уточни, что и когда нужно сделать.',UNKNOWN_TOOL:'Такого действия пока нет. Напиши, какого результата ты хочешь.',AI_TIMEOUT:'Не дождался ответа. Попробуй ещё раз; сохранённые дела и напоминания работают.',AI_TRUNCATED:'Слишком много действий за раз. Пришли их несколькими сообщениями.',AI_BUDGET:'Сегодня лимит ИИ исчерпан. Обзоры, кнопки и сохранённые напоминания продолжают работать.'};return{...response,text:messages[response.code]??String(response.text).replace(/\s*\[(?:task|event|work|ical|series)-[\w:.-]+\]/gu,'').replace(/Укажи название или id\.?/giu,'Выбери дело в списке или напиши его название.').replace(/Нужно указать id/giu,'Выбери дело в списке')};}
