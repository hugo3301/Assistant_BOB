import {normalize,cleanUserText} from './dates.mjs';
const DATE=/сегодня|завтра|послезавтра|понедельник|вторник|сред[уае]|четверг|пятниц|суббот|воскресень|\d{1,2}\s*[./-]\s*\d{1,2}|\d+\s+(?:январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)|через\s+(?:\d+|час|полчаса|день|неделю)/u;
const CLOCK=/(?:^|\s)(?:в|к|около)\s+(?:\d{1,2}|семь|восемь|девять|десять|шесть|пять|четыре|три|два|час|пол[а-я]+)|\d{1,2}:\d{2}|вечером|утром|днем/u;
export function naturalView(text){
 const source=normalize(cleanUserText(text)).replace(/[.!?]+$/u,'').replace(/^ч[ео](?:\s+там)?\s/u,'что ');
 const find=/^(?:найди|найти|поищи|поиск)\s+(.+)$/u.exec(source);if(find)return{scope:'search',query:find[1].replace(/^(?:мне\s+)?(?:дело\s+|задачу\s+)?/u,'')};
 if(!/^(?:что(?:\s+у меня|\s+мне)?|какие|покажи|показать|мои|список|все|на|расписание|дела|задачи|пары|завтра$|сегодня$)/u.test(source))return null;
 if(/добав|удал|убери|перен|сдал|не\s+показывай/u.test(source))return null;
 const scope=/послезавтра/u.test(source)?null:/завтра/u.test(source)?'tomorrow':/недел/u.test(source)?'week':/сегодня/u.test(source)?'today':/все|общая картина|дальше|вообще|без даты/u.test(source)?'ahead':/дела|задачи|пары|занятия|расписание/u.test(source)?'today':null;
 if(!scope)return null;
 // Only a short view vocabulary is fast-routed; dates/projects and searches use their own path.
 if(/\d|понедельник|вторник|сред[уае]|четверг|пятниц|суббот|воскресень|проект/u.test(source))return null;
 if(!/^(?:(?:что|какие|там|у|меня|мне|на|сегодня|завтра|эту|этой|неделе|неделю|ближайшую|ближайшие|покажи|показать|пожалуйста|мои|все|вся|общая|картина|дела|дел|задачи|задач|пары|пар|занятия|занятий|встречи|встреч|расписание|список|нужно|сделать|делать|будет|есть|вообще|дальше|без|даты)\s*)+$/u.test(source))return null;
 return{scope,...(/пар|расписан/u.test(source)?{kind:'classes'}:/задач/u.test(source)?{kind:'tasks'}:{})};
}
function rawTitle(text){return text.replace(/(?:[,;]\s*)?(?:напомни|напоминай|без напоминани)[\s\S]*$/iu,'').replace(/(?:сегодня|послезавтра|завтра|(?:на\s+)?следующ[а-я]*\s+)?(?:в\s+)?(?:понедельник[а-я]*|вторник[а-я]*|сред[уае]|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*)/giu,' ').replace(/(?:к|до|на)?\s*\d{1,2}(?:-го|го)?\s+(?:январ[а-я]*|феврал[а-я]*|март[а-я]*|апрел[а-я]*|мая|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)(?:\s+\d{4})?/giu,' ').replace(/(?:к|до|на)?\s*\d{4}-\d{2}-\d{2}|(?:к|до|на)?\s*\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/gu,' ').replace(/(?:через|спустя)\s+(?:\d+\s*(?:минут[а-я]*|час[а-я]*|дн[а-я]*|день|недел[а-я]*)|час|полчаса|день|неделю)/giu,' ').replace(/(?:сегодня|послезавтра|завтра)/giu,' ').replace(/(?:где[ -]?то\s*)?(?:(?:в|к|около|примерно)\s+)(?:\d{1,2}(?:[:.]\d{2})?|пол[а-я]+|семь|восемь|девять|десять|шесть|пять|четыре|три|два)(?:\s+(?:утра|утром|дня|днем|вечера|вечером|ночи))?/giu,' ').replace(/вечером|утром|днем|где[ -]?то/giu,' ').replace(/^\s*(?:у меня\s+)?(?:есть\s+)?/iu,'').replace(/\s+есть\s*$/iu,'').replace(/[«»"*]/gu,'').replace(/^[\s,:.\-]+|[\s,:.!?\-]+$/gu,'').replace(/\s+/gu,' ').trim();}
function titleOf(text){const source=text.replace(/(^|[^а-я])((?:в|около)\s+\d{1,2})\.(\d{2})(?=$|[^а-я\d])/giu,'$1$2:$3'),title=rawTitle(source);return DATE.test(normalize(text))||CLOCK.test(normalize(text))?title.replace(/^(?:в|во|на|к|до)\s+|\s+(?:в|во|на|к|до)$/giu,'').trim():title;}
export function quickAction(text,store,owner){
 const original=cleanUserText(text).replace(/^(?:бро[, ]+|пожалуйста[, ]+|можешь\s+(?:мне\s+)?|давай\s+)/iu,'').replace(/^добавить\s/iu,'добавь ').replace(/^записать\s/iu,'запиши ').replace(/^перенести\s/iu,'перенеси ').replace(/^удалить\s/iu,'удали ').replace(/\?$/u,''),source=normalize(original),pending=store.user(owner).pending;
 if(original.length>500)return null;
 if(/отменя|отменили|не\s+будет|уже\s+(?:прошл|был|состоял)|не\s+нуж/u.test(source))return null;
 if(pending&&['date','target','question'].includes(pending.kind)&&! /^(?:добав|запиши|создай|надо|нужно|сдать)/u.test(source))return null;
 if(/\?|(?:^|\s)не\s+(?:добав|запис|удал|убир|отмен|сдал|сделал|готов|заверш)|^(?:как|если|можно ли|почему|расскажи|что будет)/u.test(source)||/кажд|еженед|ежеднев|раз[а]?\s+в\s+недел|\n|;|\sи\s|потом|затем/u.test(source))return null;
 let action=/^(?:удали|убери|отмени)\s+/u.test(source)?'cancel_item':/^(?:готово|сдал|сделал|завершил|закончил|отметь\s+(?:как\s+)?(?:готов|выполн))|\s(?:сдал|сделал|готово|выполнено|закончил)$/u.test(source)?'complete_task':/^(?:перенеси|перенести|передвинь|сдвинь|измени\s+(?:срок|дедлайн))/u.test(source)?'move':null;
 if(action){
  if(/(?:^|\s)все(?:х)?(?:\s|$)/u.test(source))return null;
  const numbered=/^(?:удали|убери|отмени|сдал|сделал|заверши|открой|перенеси)\s+(?:дело\s+|задачу\s+|номер\s+|№\s*)?(\d+)(?=\s|[,.!]|$)/u.exec(source);
  const state=JSON.parse(store.db.prepare('SELECT data FROM ui_state WHERE owner=?').get(owner)?.data??'{}'),numberId=numbered?state.numbers?.[numbered[1]]:null;
  let effective=numberId?original.replace(numbered[1],numberId):original;
  if(action==='move'){
   const phrase=/(?:\sна\s+)(.+)$/iu.exec(original)?.[1];if(!phrase)return null;
   action=/срок|сдач|дедлайн/u.test(source)?'change_deadline':'move_event';
   return{text:effective,calls:[{name:action,args:{target_id:numberId??null,[action==='change_deadline'?'due_text':'when_text']:phrase}}]};
  }
  return{text:effective,calls:[{name:action,args:{target_id:numberId??null}}]};
 }
 const task=/^(?:(?:добавь|запиши|создай)\s+(?:мне\s+)?(?:задачу|дело)\s*[:—-]?\s*|(?:мне\s+)?(?:надо|нужно|не забыть)\s+)(.+)$/iu.exec(original);
 const bareTask=/^(?:сдать|подготовить|сделать|купить|отправить|оплатить|закончить)\s+/u.test(source);
 const event=/встреча|пара(?:\s|$)|лекци[яю]|тренировк[ау]|созвон|собеседовани|занятие|прием|экзамен|консультаци[яю]/u.test(source);
 if(task||bareTask){const body=task?.[1]??original,title=titleOf(body);if(title.length<3)return null;return{text:original,calls:[{name:'create_task',args:{title,due_text:DATE.test(source)||CLOCK.test(source)||/(?:^|\s)(?:к|до|через|спустя)\s|дедлайн|срок|недел|месяц/u.test(source)?original:null}}]};}
 const eventPrefix=/^(?:(?:добавь|запиши|создай|запланируй)\s+)?(?:(?:у меня|есть)\s+)?(?:сегодня|завтра|послезавтра|в\s|во\s|на\s|через\s|встреча|пара|лекци[яю]|тренировк[ау]|созвон|собеседовани|занятие|прием|экзамен|консультаци[яю])/u.test(source);
 if(event&&eventPrefix&&(DATE.test(source)||CLOCK.test(source))&&!/начало|длительность|(?:^|\s)с\s+\d/u.test(source)){const body=original.replace(/^(?:добавь|запиши|создай|запланируй)\s+(?:мне\s+)?/iu,''),title=titleOf(body);if(title.length<3)return null;return{text:original,calls:[{name:'create_event',args:{title,when_text:original}}]};}
 return null;
}
