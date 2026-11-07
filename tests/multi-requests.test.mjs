import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {splitRequests} from '../src/requests.mjs';
const NOW='2026-11-07T02:00:00.000Z';
function setup(provider=null){const store=new Store(),assistant=new Assistant(store,{provider,allowedOwners:['alice'],clock:()=>NOW}),alpha=new Alpha(store,assistant,{clock:()=>NOW});store.ensureUser('alice',{timezone:'Asia/Tomsk'});return{store,assistant,alpha};}
test('split only independent requests, keeping conjunctions and quoted titles',()=>{
 assert.equal(splitRequests('купить хлеб и молоко').length,1);
 assert.equal(splitRequests('добавь задачу «купить хлеб; и завтра молоко»').length,1);
 assert.equal(splitRequests('Лабу сдал, отметь.').length,1);
 assert.equal(splitRequests('Всё, сделал — отметь выполненной.').length,1);
 assert.deepEqual(splitRequests('Завтра:\n1. в10:00 встреча\n2. в12:00 созвон').map(x=>x.text),['Завтра в10:00 встреча','Завтра в12:00 созвон']);
});
test('four creations keep dates, durations and reminder scopes; replay and undo cover the batch',async()=>{
 const {store,alpha}=setup();try{
 const text='завтра с10:00до11:00 встреча с Иваном без напоминания; в12:00 созвон на 30 минут; сдать отчет к 12 ноября; купить хлеб и молоко';
 const result=await alpha.handle('alice',text,{requestId:'batch'});assert.equal(result.changed,4,JSON.stringify(result));assert.equal(result.modelCalls,0);

 const items=store.items('alice'),events=items.filter(i=>i.kind==='event');assert.equal(events.length,2);assert.deepEqual(events.map(i=>i.duration).sort((a,b)=>a-b),[30,60]);
 assert.equal(events.find(i=>i.duration===60).reminder_minutes,null);assert.equal(events.find(i=>i.duration===30).reminder_minutes,60);assert.equal(events.every(i=>i.day==='2026-11-08'),true);
 const task=items.find(i=>i.title.includes('отчет'));assert.equal(task.day,'2026-11-12');assert.equal(items.find(i=>i.title.includes('хлеб')).day,null);
 assert.equal((await alpha.handle('alice',text,{requestId:'batch'})).replayed,true);assert.equal(store.items('alice').length,4);
 assert.equal((await alpha.handle('alice','/undo')).status,'ok');assert.equal(store.items('alice').length,0);
 }finally{store.close();}
});
test('ambiguous boundary clarifies only its own clause without losing the other event',async()=>{
 const {store,alpha}=setup();try{
 const question=await alpha.handle('alice','завтра с10:00до11:00 встреча с Иваном; послезавтра с15:30до созвон');assert.equal(question.status,'clarify',JSON.stringify(question));assert.equal(store.items('alice').length,0);
 const result=await alpha.handle('alice','16:00');assert.equal(result.changed,2,JSON.stringify(result));const events=store.items('alice');assert.equal(events.find(i=>i.duration===60).day,'2026-11-08');assert.equal(events.find(i=>i.duration===30).day,'2026-11-09');assert.equal(result.modelCalls,0);
 }finally{store.close();}
});
test('overlapping new intervals leave no partial items or reminders',async()=>{
 const {store,alpha}=setup();try{const r=await alpha.handle('alice','завтра с10:00до11:00 встреча; завтра с10:30до12:00 созвон');assert.equal(r.changed,0);assert.equal(r.status,'clarify');assert.equal(store.items('alice').length,0);assert.equal(store.pendingReminders('alice').length,0);}finally{store.close();}
});
test('six instructions are rejected before a model request',async()=>{
 let calls=0;const {store,alpha}=setup({complete:async()=>{calls++;throw Error('must not call');}});try{const r=await alpha.handle('alice',Array.from({length:6},(_,i)=>`добавь задачу купить товар ${i}`).join('; '));assert.equal(r.code,'BATCH_LIMIT');assert.equal(calls,0);assert.equal(store.items('alice').length,0);}finally{store.close();}
});
test('independent moves and target selection stay attached to their own clauses',async()=>{
 const {store,alpha}=setup();try{
 for(const [id,title] of [['report','Отчет'],['demo','Демонстрация']])store.putItem({id,owner:'alice',kind:'task',title,day:'2026-11-10',at:null,duration:null,parent_id:null},NOW,60);
 const r=await alpha.handle('alice','перенеси срок сдачи report на 12 ноября; перенеси срок сдачи demo на 14 ноября');assert.equal(r.changed,2,JSON.stringify(r));assert.equal(store.item('alice','report').day,'2026-11-12');assert.equal(store.item('alice','demo').day,'2026-11-14');
 }finally{store.close();}
});
test('a conflict correction keeps the first accepted range unchanged',async()=>{
 const {store,alpha}=setup();try{
 await alpha.handle('alice','завтра с10:00до11:00 встреча; завтра с10:30до12:00 созвон');
 const r=await alpha.handle('alice','завтра с12:30до13:00');assert.equal(r.changed,2,JSON.stringify(r));const items=store.items('alice');assert.equal(items.find(i=>i.duration===60).at,'2026-11-08T03:00:00.000Z');assert.equal(items.find(i=>i.duration===30).at,'2026-11-08T05:30:00.000Z');
 }finally{store.close();}
});
test('model cannot omit a clause or borrow a neighboring date',async()=>{
 for(const shifted of [false,true]){let calls=0;const provider={complete:async()=>{calls++;return {message:{tool_calls:[{id:'a',type:'function',function:{name:'create_event',arguments:JSON.stringify({title:'встреча с Иваном',when_text:shifted?'послезавтра в12:00':'завтра в10:00'})}},...(shifted?[{id:'b',type:'function',function:{name:'create_event',arguments:JSON.stringify({title:'созвон с Петром',when_text:'послезавтра в12:00'})}}]:[])]}};}};const {store,assistant}=setup(provider);try{const r=await assistant.handle('alice','завтра в10:00 встреча с Иваном; послезавтра в12:00 созвон с Петром');assert.equal(r.changed,0,JSON.stringify(r));assert.equal(store.items('alice').length,0);assert.ok(calls<=2);}finally{store.close();}}
});
