import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDate} from '../src/dates.mjs';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {canonical as calendarCanonical,googleBody} from '../src/calendars/model.mjs';
const NOW='2026-11-07T02:00:00.000Z';
for(const [text,start,duration]of[
 ['завтра с15.30до16.00 встреча','2026-11-08T08:30:00.000Z',30],
 ['завтра с 15:30 до 16:00 встреча','2026-11-08T08:30:00.000Z',30],
 ['завтра 15:30–16:00 встреча','2026-11-08T08:30:00.000Z',30],
 ['завтра с семи до восьми вечера встреча','2026-11-08T12:00:00.000Z',60],
 ['завтра с двух дня до четырех вечера встреча','2026-11-08T07:00:00.000Z',120],
 ['завтра с23:30до00:30 встреча','2026-11-08T16:30:00.000Z',60],
 ['завтра с23:00до24:00 встреча','2026-11-08T16:00:00.000Z',60],
 ['завтра с одиннадцати вечера до часу ночи встреча','2026-11-08T16:00:00.000Z',120],
 ['завтра с15:30до16:00 по Москве встреча','2026-11-08T12:30:00.000Z',30],
])test('clock range: '+text,()=>{const r=resolveDate(text,{now:NOW,requireTime:true,defaultToday:true});assert.equal(r.at,start);assert.equal(r.duration,duration);assert.equal(Date.parse(r.endAt)-Date.parse(r.at),duration*60000);});
for(const text of['завтра с15:00до15:00','завтра с15:00до14:00','завтра с25:00до26:00','завтра с15:30до','завтра с15:00до16:00 и в18:00'])test('invalid/contradictory range asks: '+text,()=>assert.throws(()=>resolveDate(text,{now:NOW,requireTime:true,defaultToday:true})));
test('range dates use independent DST validation for both boundaries',()=>assert.throws(()=>resolveDate('2027-03-14 с01:30до02:30',{now:NOW,timezone:'America/New_York',requireTime:true}),e=>e.code==='DST_GAP'));
test('ordinary range creates one event, correct end and start reminder without AI',async()=>{
 const store=new Store(),bot=new Alpha(store,new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW}),{clock:()=>NOW});
 try{const result=await bot.handle('alice','завтра с15.30до16.00 надо заскочить в ком клуб',{requestId:'range'});assert.equal(result.changed,1);assert.equal(result.modelCalls,0);const item=store.items('alice')[0];assert.equal(item.duration,30);assert.equal(item.title,'заскочить в ком клуб');assert.equal(store.pendingReminders('alice')[0].fire_at,'2026-11-08T07:30:00.000Z');const c=calendarCanonical(item);assert.equal(c.at,'2026-11-08T08:30:00.000Z');assert.equal(googleBody(c).end.dateTime,'2026-11-08T09:00:00.000Z');assert.equal((await bot.handle('alice','завтра с15.30до16.00 надо заскочить в ком клуб',{requestId:'range'})).replayed,true);assert.equal(store.items('alice').length,1);}finally{store.close();}
});
test('task range creates a task and a linked work block, never a false deadline',async()=>{
 const store=new Store(),assistant=new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW});const source='Добавь задачу подготовить отчет завтра с15:00до16:00';
 try{const r=await assistant.handle('alice',source,{applicationCalls:[{name:'create_task',args:{title:'подготовить отчет',due_text:source}}]});assert.equal(r.changed,2);const task=store.items('alice').find(i=>i.kind==='task'),work=store.items('alice').find(i=>i.kind==='work');assert.equal(task.day,null);assert.equal(task.at,null);assert.equal(work.parent_id,task.id);assert.equal(work.duration,60);assert.equal(store.pendingReminders('alice').length,1);}finally{store.close();}
});
test('model cannot omit the original range end or replace it with a fabricated duration',async()=>{
 const store=new Store(),bot=new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW});try{const r=await bot.handle('alice','завтра с15:00до16:00 встреча',{applicationCalls:[{name:'create_event',args:{title:'встреча',when_text:'завтра в15:00',duration_minutes:999}}]});assert.equal(r.changed,1);assert.equal(store.items('alice')[0].duration,60);}finally{store.close();}
});
test('range end clarification preserves original day and start without another model call',async()=>{
 const store=new Store(),bot=new Alpha(store,new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW}),{clock:()=>NOW});
 try{assert.equal((await bot.handle('alice','завтра встреча с15:30до')).status,'clarify');const result=await bot.handle('alice','в16:00');assert.equal(result.changed,1);const item=store.items('alice')[0];assert.equal(item.at,'2026-11-08T08:30:00.000Z');assert.equal(item.duration,30);assert.equal(result.modelCalls,0);}finally{store.close();}
});
test('work range preserves the existing deadline and rejects a conflicting appointment atomically',async()=>{
 const store=new Store(),bot=new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW});store.ensureUser('alice',{timezone:'Asia/Tomsk'});store.putItem({id:'report',owner:'alice',kind:'task',title:'отчет',day:'2026-11-12',at:null,duration:null,parent_id:null},NOW,60);
 try{const r=await bot.handle('alice','запланируй работу над отчетом завтра с15:00до16:00',{applicationCalls:[{name:'plan_work',args:{target_id:'report',when_text:'завтра с15:00до16:00'}}]});assert.equal(r.changed,1);assert.equal(store.item('alice','report').day,'2026-11-12');const work=store.items('alice').find(i=>i.kind==='work');assert.equal(work.duration,60);const conflicting=await bot.handle('alice','завтра встреча с15:30до16:30',{applicationCalls:[{name:'create_event',args:{title:'конфликт',when_text:'завтра с15:30до16:30'}}]});assert.equal(conflicting.changed,0);assert.equal(store.items('alice').length,2);}finally{store.close();}
});
test('a task proposal cannot silently discard either its work range or its external deadline',async()=>{
 const store=new Store(),bot=new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW});try{const r=await bot.handle('alice','добавь задачу сдать отчет к12ноября, поработать завтра с15:00до16:00',{applicationCalls:[{name:'create_task',args:{title:'отчет',due_text:'к12ноября'}}]});assert.equal(r.changed,0);assert.equal(store.items('alice').length,0);}finally{store.close();}
});
test('numeric price ranges remain task content rather than work appointments',async()=>{
 const store=new Store(),bot=new Alpha(store,new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW}),{clock:()=>NOW});try{const r=await bot.handle('alice','Добавь задачу купить подарок от5до10тысяч');assert.equal(r.changed,1);const item=store.items('alice')[0];assert.equal(item.kind,'task');assert.equal(item.day,null);assert.match(item.title,/от5до10тысяч/);}finally{store.close();}
});
