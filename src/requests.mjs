import {normalize,cleanUserText,hasTimeRange} from './dates.mjs';
import {requireThat} from './errors.mjs';

const DAY='(?:послезавтра|завтра|сегодня|(?:в|во|на|к|до)\\s+(?:понедельник[а-я]*|вторник[а-я]*|сред[уае]|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*)|\\d{1,2}\\s*(?:январ[а-я]*|феврал[а-я]*|март[а-я]*|апрел[а-я]*|мая|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)|\\d{4}-\\d{2}-\\d{2})';
const CLOCK='(?:(?:в|к|около|с)\\s*(?:\\d|сем[ьи]|восем|девят|десят|шест|пят|четыр|тр[ие]|дв[аеу])|\\d{1,2}:\\d{2})';
const ACTION='(?:добав[а-я]*|запиши|создай|запланируй|надо|нужно|сдать|подготовить|сделать|купить|отправить|оплатить|закончить|поработать|позвонить|забрать|проверить|прочитать|перенеси|передвинь|удали|убери|отмени|завершил|сдал|сделал|отметь|встреч[а-я]*|созвон|пара|лекци[яю]|тренировк[ау]|задач[ау])';
const START=`(?:${DAY}|${CLOCK}|${ACTION})`;
const SEPARATOR=new RegExp(`\\n+|;|(?<!\\d)[.!?]\\s+(?=${START})|,\\s*(?=${START})|\\s+(?:и|а(?:\\s+еще)?|потом|затем|также|еще)\\s+(?=${START})`,'giu');
const dayPattern=new RegExp(DAY,'iu'),clockPattern=new RegExp(CLOCK,'iu');
function quotedPositions(text){const protectedAt=new Uint8Array(text.length);let closing=null,depth=0;for(let i=0;i<text.length;i++){const char=text[i];if(closing){protectedAt[i]=1;if(char===closing)closing=null;continue;}if(char==='«'||char==='“'||char==='"'){closing=char==='«'?'»':char==='“'?'”':'"';protectedAt[i]=1;continue;}if(char==='('||char==='[')depth++;if(depth)protectedAt[i]=1;if(char===')'||char===']')depth=Math.max(0,depth-1);}return protectedAt;}
const removeBullet=text=>text.replace(/^\s*(?:(?:\d{1,2}[.)]|[-•])\s+)?/u,'').trim();
export function splitRequests(value){
 const source=cleanUserText(String(value).split('\nУточнение:')[0]),protectedAt=quotedPositions(source),parts=[];let last=0;
 for(const match of source.matchAll(SEPARATOR)){if(protectedAt[match.index])continue;const before=removeBullet(source.slice(last,match.index));if(before)parts.push(before);last=match.index+match[0].length;}
 const tail=removeBullet(source.slice(last));if(tail)parts.push(tail);
 for(let i=parts.length-1;i>0;i--)if(/^(?:отметь(?:\s+(?:это\s+)?выполненн[а-я]*)?|сделал|готово)[.!?]*$/iu.test(parts[i])){parts[i-1]+=', '+parts[i];parts.splice(i,1);}
 if(parts.length>1&&/^вс[её]$/iu.test(parts[0]))parts.splice(0,2,parts[0]+', '+parts[1]);
 if(parts.length<=1)return [{text:source,raw:source,index:0}];
 const header=parts[0].replace(/[:\s]+$/u,''),headerDay=new RegExp(`^${DAY}$`,'iu').test(header)?header:null;
 if(headerDay)parts.shift();
 let inherited=headerDay;
 return parts.map((raw,index)=>{const own=dayPattern.exec(raw)?.[0];if(own)inherited=own;const timed=clockPattern.test(raw)||hasTimeRange(raw);return {raw,index,text:!own&&inherited&&(headerDay||timed)?inherited+' '+raw:raw};});
}
function score(call,clause){
 const text=normalize(clause.text),args=call.args;let points=0;
 for(const phrase of [args.when_text,args.due_text])if(phrase){const p=normalize(phrase);if(text.includes(p))points+=40;const clocks=p.match(/\d{1,2}[:.]\d{2}/gu)??[];for(const clock of clocks)if(text.includes(clock))points+=12;}
 if(args.title){const title=normalize(args.title);if(text.includes(title))points+=100;else{const words=title.match(/[а-яa-z]{3,}/gu)??[];points+=words.filter(word=>text.includes(word)).length*3;}}
 if(args.target_id&&text.includes(args.target_id))points+=100;
 return points;
}
export function bindCallSources(calls,value){
 const clauses=splitRequests(value),writes=calls.filter(call=>!['ask_user','list_items','reply_user'].includes(call.name));
 requireThat(clauses.length<=5,'BATCH_LIMIT',`В одном сообщении можно разобрать до 5 поручений; здесь ${clauses.length}. Раздели список на несколько сообщений — пока ничего не изменено.`);
 if(!writes.length)return calls;
 if(clauses.length===1)return calls.map(call=>call.sourceText?call:{...call,sourceText:String(value),sourceIndex:0});
 const used=new Set(),bound=calls.map(call=>{
  if(call.sourceText){used.add(call.sourceIndex);return call;}
  const ranked=clauses.map(clause=>({clause,points:score(call,clause)})).sort((a,b)=>b.points-a.points),best=ranked[0];
  requireThat(best.points>0&&(!ranked[1]||best.points>ranked[1].points),'BATCH_AMBIGUOUS','Не смог однозначно связать параметры с каждым делом. Уточни названия и время — пока ничего не изменено.');
  requireThat(!used.has(best.clause.index),'BATCH_INCOMPLETE','Несколько действий относятся к одному фрагменту, а остальные поручения не разобраны. Пока ничего не изменено.');used.add(best.clause.index);
  return {...call,sourceText:best.clause.text,sourceIndex:best.clause.index};
 });
 requireThat(used.size===clauses.length,'BATCH_INCOMPLETE',`Вижу ${clauses.length}поручения, но разобраны не все. Пока ничего не изменено — уточни оставшиеся детали.`);
 return bound;
}
