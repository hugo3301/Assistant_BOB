import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {bulkIntent} from '../src/bulk-actions.mjs';
const NOW='2026-11-04T02:00:00.000Z';
function setup(){let now=NOW,seq=0;const store=new Store(),clock=()=>now,provider={complete:()=>{throw Error('Unexpected AI call');}},alpha=new Alpha(store,new Assistant(store,{provider,clock,allowedOwners:['alice','bob']}),{clock});store.ensureUser('alice');return{store,alpha,run:(text,id=`n-${++seq}`)=>alpha.handle('alice',text,{requestId:id}),click:(data,id=`c-${++seq}`,owner='alice')=>alpha.handle(owner,'',{requestId:id,callback:{id,data}}),advance:seconds=>{now=new Date(Date.parse(now)+seconds*1000).toISOString();}};}
function put(store,id,fields={}){store.ensureUser(fields.owner??'alice');store.putItem({id,owner:'alice',kind:'task',title:'Отчёт',day:'2026-11-05',...fields},NOW,60);}
const first=response=>response.replyMarkup.inline_keyboard[0][0].callback_data;
for(const phrase of ['удали все мои дела','убери все','отмени все пары','удали все задачи на завтра','очисти расписание'])test('bulk wording: '+phrase,()=>assert.ok(bulkIntent(phrase)));
for(const phrase of ['не удаляй все дела','как удалить все дела?','удали все задачи кроме отчёта','убери все пары по сетям','что будет если удалить все','можно ли удалить все дела'])test('unrecognized bulk scope cannot silently mean all: '+phrase,()=>assert.equal(bulkIntent(phrase),null));
test('bulk confirms a frozen owned snapshot, cancels reminders and undo restores it once',async()=>{
 const {store,run,click}=setup();try{put(store,'ical-first',{kind:'event',title:'Пара',at:'2026-11-05T08:00:00.000Z',duration:90});put(store,'task-first');put(store,'task-foreign',{owner:'bob'});
  const proposal=await run('удали все мои дела');assert.match(proposal.text,/Дел: 2/);assert.equal(store.items('alice').length,2);
  assert.equal((await click(first(proposal),'foreign','bob')).status,'error');put(store,'task-new',{title:'Добавлено после вопроса'});
  const result=await run('все','confirmation');assert.equal(store.items('alice').length,1);assert.equal(store.item('alice','task-new').status,'open');assert.equal(store.items('bob').length,1);assert.equal(store.pendingReminders('alice').filter(row=>row.status==='pending').length,0);
  const version=store.item('alice','ical-first').version;assert.equal((await run('все','confirmation')).replayed,true);assert.equal(store.item('alice','ical-first').version,version);
  assert.equal((await click(first(result))).status,'ok');assert.equal(store.items('alice').length,3);assert.equal(store.pendingReminders('alice').filter(row=>row.status==='pending').length,1);assert.equal((await click(first(result))).status,'error');
 }finally{store.close();}
});
test('bulk cancellation, stale changes, expired questions and interrupted conversation are safe',async()=>{
 const {store,run,click,advance}=setup();try{put(store,'task-one');let question=await run('удали все дела');await run('отмена');assert.equal((await click(first(question))).status,'error');assert.equal(store.items('alice').length,1);
  question=await run('удали все задачи');store.changeItem('alice','task-one',{title:'Новая версия'},NOW);const refreshed=await run('да');assert.match(refreshed.text,/Список изменился/);assert.equal(store.items('alice').length,1);
  advance(601);assert.equal((await click(first(refreshed))).status,'error');assert.equal(store.items('alice').length,1);
  question=await run('удали все дела');await run('Сегодня');assert.equal((await click(first(question))).status,'error');assert.equal(store.items('alice').length,1);
 }finally{store.close();}
});
test('bulk stops recurring sources, includes child work, and undo restores series without duplicates',async()=>{
 const {store,alpha,run}=setup();try{await run('/repeat пн,ср,пт 18:00 60 Зал');put(store,'parent');put(store,'child',{kind:'work',parent_id:'parent',at:'2026-11-05T09:00:00.000Z',duration:60});const count=store.items('alice').length;
  const proposal=await run('удали все дела');assert.match(proposal.text,/Повторяющихся серий: 1/);await run('подтверждаю');assert.equal(store.items('alice').length,0);assert.equal(alpha.expandSeries('alice',NOW),0);
  await run('верни как было');assert.equal(store.items('alice').length,count);assert.equal(alpha.expandSeries('alice',NOW),0);
 }finally{store.close();}
});
test('undo creation, move and completion is transactional and cannot overwrite newer edits',async()=>{
 const {store,run}=setup();try{let result=await run('сдать отчёт к 12 ноября');assert.equal(result.modelCalls,0);const id=store.items('alice')[0].id;await run('/undo');assert.equal(store.item('alice',id).status,'cancelled');
  result=await run('Добавь задачу сдать проект к 14 ноября');const target=result.focusId;await run('Перенеси срок сдачи '+target+' на 15 ноября');assert.equal(store.item('alice',target).day,'2026-11-15');await run('/undo');assert.equal(store.item('alice',target).day,'2026-11-14');
  await run('сдал проект');assert.equal(store.item('alice',target).status,'completed');await run('/undo');assert.equal(store.item('alice',target).status,'open');
  await run('сдал проект');store.db.prepare('UPDATE items SET version=version+1 WHERE id=?').run(target);result=await run('/undo');assert.equal(result.code,'UNDO_STALE');assert.equal(store.item('alice',target).status,'completed');
 }finally{store.close();}
});
for(const [phrase,kind,day,time,title]of[
 ['> Добавь задачу сдать отчёт к 12 ноября.','task','2026-11-12',null,'сдать отчёт'],
 ['Надо купить продукты завтра','task','2026-11-05',null,'купить продукты'],
 ['можешь добавить задачу сдать отчёт к 12 ноября?','task','2026-11-12',null,'сдать отчёт'],
 ['завтра в 7 вечера встреча с преподавателем','event','2026-11-05','12:00','встреча с преподавателем'],
 ['сегодня вечером где-то к 7 вечера пара по схемату есть','event','2026-11-04','12:00','пара по схемату'],
 ['встреча через час','event','2026-11-04','03:00','встреча'],
 ['запиши созвон в пятницу в 15:00','event','2026-11-06','08:00','созвон']
])test('ordinary phrase has no model dependency: '+phrase,async()=>{const {store,run}=setup();try{const result=await run(phrase);assert.equal(result.status,'ok',result.text);assert.equal(result.modelCalls,0);const item=store.items('alice')[0];assert.equal(item.kind,kind);assert.equal(item.day,day);assert.equal(item.at?.slice(11,16)??null,time);assert.equal(item.title,title);}finally{store.close();}});
test('ordinary views filter classes and date without AI; visible numbers identify the selected item',async()=>{
 const {store,run}=setup();try{put(store,'ical-lesson',{kind:'event',title:'Пара по сетям',area:'Учёба',at:'2026-11-05T08:00:00.000Z'});put(store,'task-numbered');
  const tomorrow=await run('какие пары у меня завтра?');assert.match(tomorrow.text,/Пара по сетям/);assert.doesNotMatch(tomorrow.text,/Отчёт/);assert.equal(tomorrow.modelCalls,0);
  await run('все дела');const state=JSON.parse(store.db.prepare('SELECT data FROM ui_state').get().data),number=Object.keys(state.numbers).find(number=>state.numbers[number]==='task-numbered');await run('удали '+number);assert.equal(store.item('alice','task-numbered').status,'cancelled');assert.equal(store.item('alice','ical-lesson').status,'open');
 }finally{store.close();}
});
test('negative, explanatory and unsupported bulk requests never call AI or alter data',async()=>{const {store,run}=setup();try{put(store,'keep');for(const text of ['не надо удалять все дела','как удалить все дела?','удали все пары кроме сетей']){const response=await run(text);assert.equal(response.changed,0);assert.equal(response.modelCalls,0);assert.equal(store.items('alice').length,1);}}finally{store.close();}});
