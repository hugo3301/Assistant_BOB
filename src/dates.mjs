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

const NUMBER_WORDS = {
  один:1,одного:1,одной:1,одну:1,первого:1,первому:1,два:2,две:2,двух:2,второго:2,второму:2,три:3,трех:3,третьего:3,третьему:3,четыре:4,четырех:4,четвертого:4,четвертому:4,пять:5,пяти:5,пятого:5,пятому:5,шесть:6,шести:6,шестого:6,шестому:6,семь:7,семи:7,седьмого:7,седьмому:7,восемь:8,восьми:8,восьмого:8,восьмому:8,девять:9,девяти:9,девятого:9,девятому:9,десять:10,десяти:10,десятого:10,одиннадцать:11,одиннадцати:11,одиннадцатого:11,двенадцать:12,двенадцати:12,двенадцатого:12,тринадцать:13,тринадцати:13,тринадцатого:13,четырнадцать:14,четырнадцати:14,четырнадцатого:14,пятнадцать:15,пятнадцати:15,пятнадцатого:15,шестнадцать:16,шестнадцати:16,шестнадцатого:16,семнадцать:17,семнадцати:17,семнадцатого:17,восемнадцать:18,восемнадцати:18,восемнадцатого:18,девятнадцать:19,девятнадцати:19,девятнадцатого:19,двадцать:20,двадцати:20,двадцатого:20,тридцать:30,тридцати:30,тридцатого:30,
};
const MONTH_WORDS = ['январь','января','янв','февраль','февраля','фев','март','марта','мар','апрель','апреля','апр','май','мая','июнь','июня','июль','июля','август','августа','авг','сентябрь','сентября','сент','сен','октябрь','октября','окт','ноябрь','ноября','ноя','нояб','декабрь','декабря','дек'];
const monthNumber = word => MONTHS.findIndex(pattern => pattern.test(word)) + 1 || ({янв:1,фев:2,мар:3,апр:4,авг:8,сен:9,сент:9,окт:10,ноя:11,нояб:11,дек:12}[word] ?? 0);
function languageText(value) {
  return normalize(value).replace(/пол(?=(?:перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят|одиннадц|двенадц))/gu, 'пол ').replace(/[а-я]+/gu, word => NUMBER_WORDS[word] ?? word).replace(/\b(20|30)\s+([1-9])\b/g,(_all,tens,ones)=>String(Number(tens)+Number(ones)));
}
export function cleanUserText(value) {
  return String(value).replace(/^\s*```(?:text|markdown|md)?\s*\n/iu,'').replace(/\n\s*```\s*$/u,'').replace(/^\s*>+\s?/gmu,'').trim();
}
const RANGE_WORDS=Object.keys(NUMBER_WORDS).sort((a,b)=>b.length-a.length).join('|');
const RANGE_NUMBER=`(?:\\d{1,2}|(?:${RANGE_WORDS})(?:\\s+(?:${RANGE_WORDS}))?)`;
const RANGE_PART='(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)';
const RANGE_CLOCK=`(?:\\d{1,2}[:.]\\d{2}|(?:пол\\s*|половин[ауы]\\s+)${RANGE_NUMBER}|без\\s+(?:четверти|${RANGE_NUMBER}\\s+минут[а-я]*)\\s+${RANGE_NUMBER}|${RANGE_NUMBER}|час(?:а|у)?)(?:\\s+час(?:а|ов)?)?(?:\\s+${RANGE_PART})?`;
const RANGE_PATTERN=new RegExp(`(?<![а-я\\d])(?:с|от)\\s*(${RANGE_CLOCK})\\s*(?:до|[-–—])\\s*(${RANGE_CLOCK})(?![а-я\\d:.])|(?<![\\d.])((?:\\d{1,2}[:.]\\d{2}))\\s*[-–—]\\s*((?:\\d{1,2}[:.]\\d{2}))(?![\\d.])`,'giu');
const NON_CLOCK_UNIT=/^\s*(?:руб|тыс|кг|км|страниц|штук|минут|числа|январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/iu;
export function timeRanges(value){const source=String(value);return [...source.matchAll(RANGE_PATTERN)].filter(match=>!NON_CLOCK_UNIT.test(source.slice(match.index+match[0].length))).map(match=>({text:match[0],from:match[1]??match[3],to:match[2]??match[4],index:match.index,end:match.index+match[0].length}));}
export function stripTimeRanges(value){let source=String(value);for(const range of timeRanges(source).reverse())source=source.slice(0,range.index)+' '+source.slice(range.end);return source;}
export function hasTimeRange(value){const source=String(value).replace(/(?:с|от)\s*\d+(?:[.,]\d+)?\s*(?:до|[-–—])\s*\d+(?:[.,]\d+)?\s*(?:тыс[а-я]*|руб[а-я]*|минут[а-я]*|кг|км|штук[а-я]*)/giu,' ');if([...source.matchAll(RANGE_PATTERN)].length)return timeRanges(source).length>0;return new RegExp(`(?:^|[^а-я])(?:с|от)\\s*${RANGE_CLOCK}\\s*до(?=$|[^а-я])`,'iu').test(source);}

function resolveTimeRange(source,options){
 const ranges=timeRanges(source);
 requireThat(ranges.length<=1,'TIME_RANGE_MULTIPLE','Здесь несколько интервалов. Укажи для каждого отдельное дело.');
 if(!ranges.length){requireThat(!/(?:^|[^а-я])с\s+(?:утра|вечера|обеда)\s+до\s/iu.test(source),'TIME_RANGE_START','Во сколько начинается это дело? Например: «с09:00до16:00».',{append:true});requireThat(!hasTimeRange(source),'TIME_RANGE_END','Во сколько заканчивается это дело? Например: «с15:30до16:00».',{append:true});return null;}
 const range=ranges[0],remainder=stripTimeRanges(source),tail=source.slice(range.end);
 // A numeric interval of prices, counts or dates is not a clock interval.
 requireThat(!/^\s*(?:руб|тыс|кг|км|страниц|штук|числа|январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/iu.test(tail),'TIME_RANGE_AMBIGUOUS','Это диапазон времени? Уточни часы начала и окончания.');
 const dotClocks=[range.from,range.to].every(value=>/^\d{1,2}\.\d{2}$/u.test(value));
 if(dotClocks&&[range.from,range.to].every(value=>{const [h,m]=value.split('.').map(Number);return h>=1&&h<=31&&m>=1&&m<=12;}))requireThat(/сегодня|завтра|послезавтра|понедельник|вторник|сред[уае]|четверг|пятниц|суббот|воскресень|\d{4}-\d{2}-\d{2}|\d+\s+[а-я]+/iu.test(remainder),'TIME_RANGE_AMBIGUOUS','Это даты или часы? Для времени можно написать «с05:11до06:11».');
 const parts=[...new Set([...languageText(source).matchAll(new RegExp(`(?<![а-я])(${RANGE_PART})(?![а-я])`,'gu'))].map(match=>match[1]))];
 function endpoint(value,isEnd=false){const normalized=languageText(value).replace(/^час(?:а|у)?(?=$|\s)/u,'1');if(isEnd&&/^24(?:[:.]00)?$/u.test(normalized))return{hour:0,minute:0,clock:'00:00',endOfDay:true};return clockCandidates('в '+normalized+(parts.length===1&&!new RegExp(RANGE_PART,'u').test(normalized)?' '+parts[0]:''));}
 const from=endpoint(range.from),to=endpoint(range.to,true);requireThat(from&&to,'TIME_RANGE_CLOCK','Уточни часы начала и окончания.');
 const explicitNext=/следующ(?:его|ий)\s+(?:дня|день)|на\s+следующий\s+день/iu.test(tail);
 const cleanRemainder=remainder.replace(/следующ(?:его|ий)\s+(?:дня|день)|на\s+следующий\s+день/giu,' ');
 const context=stripTimeRanges(options.contextText??''),start=resolveDate(cleanRemainder+' в '+from.clock,{...options,contextText:context,requireTime:true});
 let offset=explicitNext||to.endOfDay?1:0;
 if(!offset&&to.clock<from.clock){requireThat(from.hour>=18&&to.hour<=8,'TIME_RANGE_ORDER','Конец раньше начала. Это переход через полночь? Укажи окончание на следующий день.');offset=1;}
 const endDay=addDays(start.day,offset),endAt=localToUtc(endDay,to.clock,start.timezone),duration=(Date.parse(endAt)-Date.parse(start.at))/60000;
 requireThat(Number.isInteger(duration)&&duration>0&&duration<=1440,'TIME_RANGE_DURATION','Интервал должен длиться от1минуты до24часов. Уточни начало и конец.');
 const other=clockCandidates(cleanRemainder);requireThat(!other||other.clock===from.clock,'TIME_RANGE_CONFLICT','Кроме диапазона указано другое время. Какой интервал сохранить?');
 return {...start,source,timeRange:true,endAt,endDay,duration};
}
function clockCandidates(value) {
  const text = languageText(value).replace(/(?:через|спустя|за)\s+(?:\d+\s*(?:дн[а-я]*|день|сут[а-я]*|недел[а-я]*)|неделю|день)/gu,' '), found = [];
  const periods = [...text.matchAll(/(?:^|[^а-я])(утра|утром|дня|днем|вечера|вечером|ночи|ночью)(?=$|[^а-я])/gu)].map(match=>match[1]);
  function add(hour,minute,part) {
    requireThat(hour>=0 && hour<24 && minute>=0 && minute<60,'INVALID_TIME','Проверь время: часы от 0 до 23, минуты от 0 до 59.');
    part ??= periods.length===1 ? periods[0] : null;
    if (part) {
      if (/вечер|дня|днем/u.test(part) && hour>=1 && hour<12) hour+=12;
      if (/ноч/u.test(part) && hour===12) hour=0;
      if (/утр/u.test(part) && hour===12) hour=0;
    }
    found.push({hour,minute,clock:`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`});
  }
  const fractional = [...text.matchAll(/(?:^|[^а-я\d])(?:пол\s*|половин[ауы]\s+)(\d{1,2})(?:\s*(утра|утром|дня|днем|вечера|вечером|ночи|ночью))?/gu)];
  for (const match of fractional) { let hour=Number(match[1])-1; if(hour<0)hour=11;add(hour,30,match[2]); }
  let simple = text;
  for(const match of fractional) simple=simple.replace(match[0],' ');
  const without = [...simple.matchAll(/(?:^|[^а-я\d])без\s+(?:(четверти)|(\d{1,2})\s*(?:минут[а-я]*)?)\s+(\d{1,2})(?:\s*(утра|утром|дня|днем|вечера|вечером|ночи|ночью))?/gu)];
  for(const match of without) {const minutes=match[1]?15:Number(match[2]);requireThat(minutes>0 && minutes<60,'INVALID_TIME','Уточни минуты.');add((Number(match[3])+23)%24,60-minutes,match[4]);simple=simple.replace(match[0],' ');}
  const expression=/(?:^|[^а-я\d])(?:(в|к|до|около)\s*)?(\d{1,2})(?:([:.])(\d{2}))?(?:\s*час(?:а|ов)?)?(?:\s*(утра|утром|дня|днем|вечера|вечером|ночи|ночью))?(?=$|[^а-я\d])/gu;
  for(const match of simple.matchAll(expression)) {
    const following=simple.slice(match.index+match[0].length).trimStart();
    if (MONTH_WORDS.some(month=>new RegExp(`^${month}(?:[^а-я]|$)`,'u').test(following)) || /^(?:числа|число|[-–]?го)(?:[^а-я]|$)/u.test(following)) continue;
    if(!match[1] && !match[3] && !match[5])continue;
    if(match[3]==='.' && Number(match[4])>=1 && Number(match[4])<=12 && match[1]!=='в' && !match[5])continue;
    // A bare day in ISO/DD.MM is not a clock.
    if(match[1] && /^[-/]\d/u.test(following))continue;
    add(Number(match[2]),Number(match[4]??0),match[5]);
  }
  const unique=[...new Map(found.map(entry=>[entry.clock,entry])).values()];
  requireThat(unique.length<=1,'TIME_CONFLICT','Здесь несколько разных времён. Во сколько именно?');
  return unique[0]??null;
}
function calendarCandidates(value, today) {
  const text=languageText(value), candidates=[];
  const push=(day,kind,hasYear=true)=>{
    requireThat(validDay(day),'INVALID_DATE','Такой даты нет в календаре. На какой день записать?');
    if(!hasYear && day<today)throw new BobError('YEAR_AMBIGUOUS','Эта дата уже прошла в текущем году. Какой год ты имеешь в виду?');
    candidates.push({day,kind});
  };
  for(const match of text.matchAll(/(?:^|[^а-я])(послезавтра|завтра|сегодня|завтрашн[а-я]*)(?=$|[^а-я])/gu))push(addDays(today,match[1]==='послезавтра'?2:match[1]==='сегодня'?0:1),'relative');
  for(const match of text.matchAll(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=$|[^\d])/gu))push(match[1],'explicit');
  for(const match of text.matchAll(/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?(?=$|[^\d])/gu)) {
    const before=text.slice(0,match.index+1);
    if (/(?:^|\s)в\s*$/u.test(before) || Number(match[2])===0 || Number(match[2])>12)continue;
    push(`${match[3]??today.slice(0,4)}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`,'explicit',Boolean(match[3]));
  }
  const named=new RegExp(`(?:^|[^а-я\\d])(\\d{1,2})(?:-?го)?\\s*(${MONTH_WORDS.join('|')})(?:\\.)?(?:\\s+(\\d{4}))?(?=$|[^а-я])`,'gu');
  for(const match of text.matchAll(named))push(`${match[3]??today.slice(0,4)}-${String(monthNumber(match[2])).padStart(2,'0')}-${match[1].padStart(2,'0')}`,'explicit',Boolean(match[3]));
  for(const match of text.matchAll(/(?:^|[^а-я\d])(\d{1,2})(?:-го|го|\s+числа)(?=$|[^а-я\d])/gu)) {
    const rest=text.slice(match.index+match[0].length).trim();
    if(MONTH_WORDS.some(month=>rest.startsWith(month)))continue;
    push(`${today.slice(0,7)}-${match[1].padStart(2,'0')}`,'explicit',false);
  }
  const dayOffset=/(?:через|спустя)\s+(?:(\d+)\s*(дн[а-я]*|день|сут[а-я]*|недел[а-я]*)|(неделю|день))/u.exec(text);
  if(dayOffset)push(addDays(today,dayOffset[3]?(dayOffset[3]==='неделю'?7:1):Number(dayOffset[1])*(dayOffset[2].startsWith('недел')?7:1)),'relative');
  const weekdayExpression=/(?:^|[^а-я])(понедельник(?:а|у|ом)?|вторник(?:а|у|ом)?|сред(?:а|у|е|ой)|четверг(?:а|у|ом)?|пятниц(?:а|у|е|ей|ы)|суббот(?:а|у|е|ой|ы)|воскресень(?:е|я|ю|ем))(?=$|[^а-я])/gu;
  for(const match of text.matchAll(weekdayExpression)) {
    const weekday=WEEKDAYS.findIndex(stem=>match[1].startsWith(stem)),current=new Date(`${today}T12:00:00Z`).getUTCDay();
    if(candidates.length)requireThat(candidates.every(entry=>new Date(`${entry.day}T12:00:00Z`).getUTCDay()===weekday),'WEEKDAY_CONFLICT','Дата и день недели не совпадают. Какой день верный?');
    else {const nextWeek=/следующ[а-я]*/u.test(text);push(addDays(today,nextWeek?7-((current+6)%7)+((weekday+6)%7):(weekday-current+7)%7),'weekday');}
  }
  requireThat(!/(?:через|спустя)\s+(?:\d+\s*)?(?:месяц|год)/u.test(text),'DATE_UNSUPPORTED','Какую календарную дату ты имеешь в виду?');
  const unique=[...new Map(candidates.map(entry=>[entry.day,entry])).values()];
  requireThat(unique.length<=1,'DATE_CONFLICT','Здесь разные даты. На какой день записать?');
  return unique[0]??null;
}
export function resolveDate(phrase, {now,timezone='Asia/Tomsk',requireTime=false,allowPast=false,contextText='',defaultToday=false}={}) {
  const range=resolveTimeRange(String(phrase??''),{now,timezone,requireTime,allowPast,contextText,defaultToday});if(range)return range;
  const source=String(phrase??''),text=languageText(source),context=languageText(contextText);
  requireThat(text.length>0 && text.length<=1500,'DATE_MISSING','На какой день?',{append:true});
  requireThat(!/кажд|еженед|ежеднев|раз[а]?\s+в\s+недел/u.test(text),'REPEAT_UNSUPPORTED','Для еженедельных занятий пока нужна /repeat. Например: /repeat пн,ср,пт 18:00 60 Зал');
  const zone=/моск|мск/u.test(text)||(!/моск|мск/u.test(text)&&/моск|мск/u.test(context))?'Europe/Moscow':timezone,today=dayAt(now,zone);
  const minutesOffset=/(?:через|спустя)\s+(?:(полчаса|час|минуту)|(\d+)\s*(минут[а-я]*|час[а-я]*))/u.exec(text);
  if(minutesOffset) {
    requireThat(!calendarCandidates(text,today),'DATE_CONFLICT','Указаны и дата, и относительный интервал. Когда именно?');
    const minutes=minutesOffset[1]?(minutesOffset[1]==='полчаса'?30:minutesOffset[1]==='час'?60:1):Number(minutesOffset[2])*(minutesOffset[3].startsWith('час')?60:1);
    requireThat(minutes>0 && minutes<=525600,'INVALID_TIME','Уточни интервал напоминания.');
    const at=new Date(Date.parse(now)+minutes*60000).toISOString();
    return {day:dayAt(at,zone),at,precision:'minute',timezone:zone,source,approximate:/примерно|около|где[ -]?то|\s~\s/u.test(text)};
  }
  let date=calendarCandidates(text,today),clock=clockCandidates(text);
  if(clock&&context&&context!==text&&!/утра|утром|дня|днем|вечера|вечером|ночи|ночью|\d{1,2}[:.]\d{2}/u.test(text)){
    const periods=[...new Set([...context.matchAll(/(?:^|[^а-я])(утра|утром|дня|днем|вечера|вечером|ночи|ночью)(?=$|[^а-я])/gu)].map(match=>match[1]))];if(periods.length===1)clock=clockCandidates(text+' '+periods[0]);
  }
  if(!date && context && context!==text)date=calendarCandidates(context,today);
  if(!clock && context && context!==text)clock=clockCandidates(context);
  const hasPart=/вечер|утр|ноч[ьи]|днем|после\s+обеда/u.test(text+' '+context);
  if(!date && defaultToday && (clock || hasPart))date={day:today,kind:'assumedToday'};
  requireThat(date,'DATE_MISSING','На какой день?',{append:true});
  requireThat(!requireTime || clock,'TIME_MISSING',hasPart?'Во сколько? Например, в семь вечера.':'Во сколько?',{append:true});
  let at=clock?localToUtc(date.day,clock.clock,zone):null;
  if(at && at<=now && date.kind==='weekday' && !/сегодня/u.test(text)) {date={...date,day:addDays(date.day,7)};at=localToUtc(date.day,clock.clock,zone);}
  requireThat(allowPast || (at?Date.parse(at)>Date.parse(now):date.day>=today),'DATE_IN_PAST',`Это время уже прошло${at && date.day===today?' сегодня':''}. На какой день перенести?`);
  return {day:date.day,at,precision:clock?'minute':'day',timezone:zone,source,approximate:/примерно|около|где[ -]?то|(?:^|\s)~(?:\s|$)/u.test(text+' '+context),assumedToday:date.kind==='assumedToday'};
}
export function verifyDatePhrase(phrase, source) {
  const text=languageText(phrase),evidence=languageText(source);
  for(const iso of text.match(/\d{4}-\d{2}-\d{2}/g)??[])requireThat(evidence.includes(iso),'UNGROUNDED_DATE','Уточни дату своими словами: она не совпала с сообщением.');
  const ignored=new Set(['в','на','к','до','с','дня','день','по','начиная','час','часа','часов']);
  let sourceClock=null;try{sourceClock=clockCandidates(evidence)?.clock;}catch{}
  const clockEquivalent=token=>/^\d{1,2}:\d{2}$/.test(token)&&token.padStart(5,'0')===sourceClock;
  const tokens=text.match(/[а-яa-z]+|\d{1,4}(?::\d{2})?/g)??[];
  const wordEquivalent=token=>/вечер/u.test(token)&&/вечер/u.test(evidence)||/утр/u.test(token)&&/утр/u.test(evidence);
  requireThat(tokens.length>0 && tokens.every(token=>ignored.has(token)||evidence.includes(token)||clockEquivalent(token)||wordEquivalent(token)),'UNGROUNDED_DATE','Дата должна происходить из твоего сообщения. Уточни её обычным текстом.');
}
export function formatDate(day,at,timezone,approximate=false) {
  if(!at)return `${new Intl.DateTimeFormat('ru',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(day+'T12:00:00Z'))} · без точного времени`;
  const formatted=new Intl.DateTimeFormat('ru',{timeZone:timezone,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(at));
  return approximate?formatted.replace(/(\d{2}:\d{2})$/u,'около $1'):formatted;
}
