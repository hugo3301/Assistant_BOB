import {randomBytes} from 'node:crypto';
import {BobError,requireThat} from './errors.mjs';
import {normalize,cleanUserText,dayAt} from './dates.mjs';

export function bulkIntent(text){
 const source=normalize(cleanUserText(text)).replace(/[.!]+$/u,'');
 if(/\?|(?:^|\s)(?:не|как|если|можно\s+ли|что\s+будет)(?:\s|$)/u.test(source))return null;
 const match=/^(?:пожалуйста[, ]+)?(?:удали|убери|отмени|очисти|сотри)\s+(?:(?:пожалуйста|мне|мои|у меня)\s+)*(?:все(?:х)?\s+)?(.*)$/u.exec(source);
 if(!match||!/(?:^|\s)все(?:х)?(?:\s|$)|^очисти\s+(?:список|расписание)/u.test(source))return null;
 const tail=match[1].replace(/^все(?:х)?(?:\s+|$)/u,'').replace(/^мои\s+/u,'');
 const known=/^(?:(?:мои|дела|дел|задачи|задач|задания|встречи|встреч|события|пары|пар|занятия|расписание|на|сегодня|завтра|вообще|целиком|пожалуйста)\s*)*$/u.test(tail);
 if(!known)return null;
 return{kind:/задач|задани/u.test(tail)?'tasks':/пар|расписан/u.test(tail)?'classes':/встреч|событи|заняти/u.test(tail)?'events':'all',day:/завтра/u.test(tail)?'tomorrow':/сегодня/u.test(tail)?'today':null};
}
export class BulkActions{
 constructor(store,{clock}){this.store=store;this.clock=clock;}
 targets(owner,scope){const timezone=this.store.user(owner).timezone,today=dayAt(this.clock(),timezone),day=scope.day==='tomorrow'?new Date(Date.parse(today+'T12:00:00Z')+86400000).toISOString().slice(0,10):scope.day?today:null;return this.store.items(owner).filter(item=>(!day||(item.at?dayAt(item.at,timezone):item.day)===day)&&(scope.kind==='all'||scope.kind==='tasks'&&item.kind==='task'||scope.kind==='classes'&&item.id.startsWith('ical-')||scope.kind==='events'&&item.kind!=='task'));}
 proposal(owner,scope,items=this.targets(owner,scope),series=null){
  series??=scope.kind==='all'&&!scope.day?this.store.db.prepare('SELECT id,active FROM weekly_series WHERE owner=? AND active=1').all(owner):[];
  if(!items.length&&!series.length)return{text:'В этой группе уже нет открытых дел. Ничего менять не нужно.',pending:null,mutate:()=>{}};
  const token=randomBytes(10).toString('hex'),now=this.clock(),expires=new Date(Date.parse(now)+600000).toISOString(),payload={type:'bulk',scope,items:items.map(item=>({id:item.id,version:item.version})),series};
  const label={all:'дела',tasks:'задачи',classes:'пары из расписания',events:'встречи и занятия'}[scope.kind];
  const synced=items.filter(item=>item.calendar_connection_id).length;
  return{text:`Убрать ${label}${scope.day==='today'?' на сегодня':scope.day==='tomorrow'?' на завтра':''}?\n\nДел: ${items.length}${series.length?`\nПовторяющихся серий: ${series.length}`:''}\nИх напоминания тоже отключатся.${synced?`\nСвязанных с календарями: ${synced}. Отмены передадутся в Google/Яндекс при синхронизации.`:``}\nВернуть изменение можно в течение 10 минут.`,pending:{kind:'bulk',token,expiresAt:expires,originalText:'массовая отмена'},replyMarkup:{inline_keyboard:[[{text:`Убрать ${items.length} дел`,callback_data:`b|${token}|yes`},{text:'Оставить',callback_data:`b|${token}|no`}]]},mutate:()=>this.store.db.prepare('INSERT INTO action_records VALUES (?,?,?,?,?,?)').run(token,owner,JSON.stringify(payload),now,expires,'pending')};
 }
 async handle(owner,text,{requestId,callback,requestText}={}){
  const source=requestText??(callback?`callback:${callback.id}:${callback.data}`:text),cached=this.store.cachedTurn(owner,requestId,source);if(cached)return cached;
  const user=this.store.user(owner),pending=user.pending,clean=normalize(text).replace(/[.!?,]+$/u,'');
  const undo=callback?/^j\|([a-f0-9]{20})$/.exec(callback.data):null;
  const bulk=callback?/^b\|([a-f0-9]{20})\|(yes|no)$/.exec(callback.data):null;
  const wantsUndo=!callback&&/^(?:\/undo|верни как было|верни обратно|откати|отмени последнее(?: изменение)?|отменить изменение|назад)$/u.test(clean);
  const decision=!callback&&pending?.kind==='bulk'&&/^(?:да|все|подтверждаю|давай|удаляй|убирай|отмени все|нет|отмена|не надо|оставь|\/cancel)$/u.test(clean);
  const legacy=!callback&&pending?.kind==='target'&&bulkIntent(pending.originalText??'')&&clean==='все';
  const scope=!callback?bulkIntent(text):null;
  const bulkQuestion=!callback&&/^(?:как|можно ли|что будет)/u.test(clean)&&/удал|убир|убра|отмен/u.test(clean);
  const unsupported=!callback&&/^(?:удали|убери|отмени|очисти|сотри)\s/u.test(clean)&&/(?:^|\s)все(?:х)?(?:\s|$)/u.test(clean)&&!scope;
  const negative=!callback&&/^(?:ничего не|не\s+(?:(?:надо|нужно)\s+)?(?:удал|убир|отмен))/u.test(clean);
  if(!undo&&!wantsUndo&&!bulk&&!decision&&!scope&&!legacy&&!unsupported&&!negative&&!bulkQuestion)return null;
  const claim=this.store.beginTurn(owner,requestId,source,this.clock());if(claim.cached)return{...claim.cached,replayed:true};
  const commit=(response,mutate)=>this.store.finishTurn(owner,requestId,claim.lease,user.revision,text,{status:'ok',changed:0,modelCalls:0,...response},mutate);
  try{
   if(negative)return commit({text:'Оставил дела и напоминания как есть.',pending:null});
   if(bulkQuestion)return commit({text:'Напиши «убери все дела», «убери все задачи» или «убери все пары». Я покажу количество и попрошу подтверждение. Случайное изменение можно вернуть кнопкой или словом «верни как было» в течение 10 минут.',pending:null});
   if(unsupported)return commit({status:'clarify',text:'Какую группу убрать: все дела, все задачи или все пары? Для отдельного предмета открой «Все дела» и выбери нужные записи. Сейчас ничего не изменено.',pending:null});
   if(undo||wantsUndo){const row=undo?{token:undo[1]}:this.store.db.prepare("SELECT token FROM action_records WHERE owner=? AND state='ready' AND expires_at>? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(owner,this.clock());requireThat(row,'UNDO_EXPIRED','Нет недавнего изменения для отмены. Кнопка «Отменить изменение» доступна 10 минут.');return commit({text:'↩ Вернул предыдущее состояние дел и напоминаний.',pending:null,noUndo:true},()=>this.store.undo(owner,row.token,this.clock()));}
   if(scope||legacy){const choice=this.proposal(owner,scope??bulkIntent(pending.originalText));const {mutate,...response}=choice;return commit(response,mutate);}
   const token=bulk?.[1]??pending.token,row=this.store.db.prepare('SELECT * FROM action_records WHERE owner=? AND token=?').get(owner,token);
   requireThat(row&&row.state==='pending'&&row.expires_at>this.clock()&&pending?.kind==='bulk'&&pending.token===token,'CONFIRM_EXPIRED','Этот вопрос уже неактуален. Если всё ещё нужно убрать дела, попроси заново.');
   const action=JSON.parse(row.data);requireThat(action.type==='bulk','CONFIRM_EXPIRED','Открой актуальный список.');
   const cancel=bulk?.[2]==='no'||['нет','отмена','не надо','оставь','/cancel'].includes(clean);
   if(cancel)return commit({text:'Оставил всё как было.',pending:null},()=>this.store.db.prepare("UPDATE action_records SET state='cancelled' WHERE owner=? AND token=?").run(owner,token));
   const items=action.items.map(entry=>this.store.item(owner,entry.id)).filter(item=>item?.status==='open');
   if(items.length!==action.items.length||items.some(item=>action.items.find(entry=>entry.id===item.id).version!==item.version)||action.series.some(entry=>this.store.db.prepare('SELECT active FROM weekly_series WHERE owner=? AND id=?').get(owner,entry.id)?.active!==entry.active)){
    const series=action.series.filter(entry=>this.store.db.prepare('SELECT active FROM weekly_series WHERE owner=? AND id=?').get(owner,entry.id)?.active===1),choice=this.proposal(owner,action.scope,items,series),{mutate,...response}=choice;return commit({...response,text:'Список изменился. Уточню актуальное количество.\n\n'+response.text},mutate);
   }
   const ids=new Set(items.map(item=>item.id));for(const child of this.store.items(owner))if(ids.has(child.parent_id))ids.add(child.id);
   return commit({text:`Убрал дел: ${ids.size}.${action.series.length?' Повторяющиеся серии остановлены.':''}\nНапоминания отменены.`,changed:ids.size+action.series.length,pending:null},()=>{for(const id of ids)this.store.changeItem(owner,id,{status:'cancelled'},this.clock());for(const entry of action.series)this.store.db.prepare('UPDATE weekly_series SET active=0 WHERE owner=? AND id=?').run(owner,entry.id);this.store.db.prepare("UPDATE action_records SET state='confirmed' WHERE owner=? AND token=?").run(owner,token);});
  }catch(error){if(!(error instanceof BobError))throw error;return commit({status:'error',code:error.code,text:error.message});}
 }
}
