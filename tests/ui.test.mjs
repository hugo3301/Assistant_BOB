import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {friendlyResponse} from '../src/views.mjs';
import {isOwnerUpdate,Telegram} from '../src/telegram.mjs';
const NOW='2026-11-04T02:00:00.000Z';
function setup(){const store=new Store(),assistant=new Assistant(store,{allowedOwners:['alice','bob'],clock:()=>NOW}),alpha=new Alpha(store,assistant,{clock:()=>NOW});store.ensureUser('alice');let seq=0;return{store,alpha,run:text=>alpha.handle('alice',text,{requestId:`ui-${++seq}`}),click:(data,id=`click-${++seq}`,owner='alice')=>alpha.handle(owner,'',{requestId:id,callback:{id,data}})};}
const button=(response,label)=>response.replyMarkup.inline_keyboard.flat().find(button=>button.text.includes(label))?.callback_data;
function put(store,id,fields={}){store.putItem({id,owner:'alice',title:'Занятие '+id,kind:'task',day:'2026-11-05',...fields},NOW,60);}
test('paged lists, day headings, conflict marks and cards never expose internal identifiers',async()=>{
 const {store,run,click}=setup();try{
  for(let i=0;i<14;i++)put(store,'ical-'+String(i).padStart(22,'0'),{title:'Предмет '+i+' (ЛБ)',kind:'event',at:'2026-11-05T08:00:00.000Z',duration:90});
  let page=await run('/week');assert.match(page.text,/ЗАВТРА/);assert.match(page.text,/15:00–16:30/);assert.match(page.text,/совпадение/);assert.match(page.text,/Страница 1 из 3 · всего 14/);assert.doesNotMatch(page.text,/ical-|\[Учёба\]/);
  const card=await click(button(page,'1. Открыть'));assert.match(card.text,/Лабораторная/);assert.doesNotMatch(card.text,/ical-/);assert.ok(button(card,'Перенести'));
  page=await click(button(await click(button(card,'К списку')),'Дальше'));assert.match(page.text,/Страница 2 из 3/);
  assert.ok(page.replyMarkup.inline_keyboard.flat().every(item=>Buffer.byteLength(item.callback_data)<=64));
  page=await click(button(page,'Дальше'));assert.match(page.text,/Страница 3 из 3/);assert.match(page.text,/14\./);
 }finally{store.close();}
});
test('callbacks are owner scoped, stale cards refresh, retries do not repeat effects',async()=>{
 const {store,run,click}=setup();try{put(store,'task-ui',{title:'Отчёт'});const list=await run('Все дела'),card=await click(button(list,'1. Открыть'));
  assert.equal((await click(button(card,'Готово'),'foreign','bob')).status,'error');assert.equal(store.item('alice','task-ui').status,'open');
  store.changeItem('alice','task-ui',{title:'Отчёт исправленный'},NOW);const stale=await click(button(card,'Готово'));assert.match(stale.text,/Карточка изменилась/);assert.equal(store.item('alice','task-ui').status,'open');
  const data=button(stale,'Готово'),result=await click(data,'done');assert.match(result.text,/Выполнено/);const version=store.item('alice','task-ui').version;assert.equal((await click(data,'done')).replayed,true);assert.equal(store.item('alice','task-ui').version,version);
 }finally{store.close();}
});
test('card date follow-up moves the selected item without AI and survives UI receipt replay',async()=>{
 const {store,run,click}=setup();try{put(store,'event-ui',{title:'Встреча',kind:'event',at:'2026-11-05T08:00:00.000Z',duration:60});const card=await click(button(await run('Все дела'),'1. Открыть'));const question=await click(button(card,'Перенести'));
  assert.match(question.text,/Когда теперь/);const result=await run('завтра в 7 вечера');assert.equal(result.changed,1);assert.equal(result.modelCalls,0);assert.equal(store.item('alice','event-ui').at,'2026-11-05T12:00:00.000Z');
 }finally{store.close();}
});
test('callbacks check both actual clicker and private destination, not bot message author',()=>{
 const update={update_id:5,callback_query:{id:'cb',data:'u|'+ 'a'.repeat(20)+'|home|',from:{id:123},message:{message_id:1,from:{id:999,is_bot:true},chat:{id:123,type:'private'}}}};
 assert.equal(isOwnerUpdate(update,'123'),true);assert.equal(isOwnerUpdate({...update,callback_query:{...update.callback_query,from:{id:456}}},'123'),false);assert.equal(isOwnerUpdate({...update,callback_query:{...update.callback_query,message:{...update.callback_query.message,chat:{id:456,type:'private'}}}},'123'),false);
});
test('friendly errors and unchanged message edits hide function internals',async()=>{
 assert.doesNotMatch(friendlyResponse({code:'TOOL_COUNT',text:'Ожидался корректный вызов функции.'}).text,/функци/);
 assert.equal(friendlyResponse({text:'Добавил: Отчёт [task-1234abcd]'}).text,'Добавил: Отчёт');
 const telegram=new Telegram('123456789:'+'A'.repeat(35),{fetcher:async()=>Response.json({ok:false,description:'Bad Request: message is not modified'},{status:400})});await telegram.edit('123',1,'text');
});
