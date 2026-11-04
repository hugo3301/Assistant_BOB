import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {WorkersAI} from '../src/ai.mjs';
import {modelContext} from '../src/context.mjs';
import {Telegram} from '../src/telegram.mjs';
const NOW='2026-11-04T02:00:00.000Z';
test('compact model context prioritizes a named distant task beyond a semester of calendar entries',()=>{
 const store=new Store();try{store.ensureUser('alice');for(let i=0;i<100;i++)store.putItem({id:'ical-'+i,owner:'alice',kind:'event',title:'Пара '+i,day:'2026-11-05',at:'2026-11-05T08:00:00.000Z'},NOW,60);store.putItem({id:'report',owner:'alice',kind:'task',title:'Отчёт по практике',day:'2027-02-12'},NOW,60);store.ensureUser('bob');store.putItem({id:'private',owner:'bob',kind:'task',title:'Отчёт чужой'},NOW,60);
  const context=modelContext(store,'alice','перенеси сдачу отчёта по практике',NOW);assert.equal(context.items[0].id,'report');assert.equal(context.items.length,16);assert.equal(context.more_items,true);assert.ok(context.items.every(item=>item.id!=='private'));
 }finally{store.close();}
});
test('AI timeout aborts the request, settles its reservation and leaves items intact',async()=>{
 const store=new Store();try{const provider=new WorkersAI(store,{accountId:'a'.repeat(32),token:'synthetic-token-for-unit-tests',clock:()=>NOW,timeoutMs:25,fetcher:async(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const assistant=new Assistant(store,{provider,allowedOwners:['alice'],clock:()=>NOW}),alpha=new Alpha(store,assistant,{clock:()=>NOW});const start=Date.now(),result=await alpha.handle('alice','Помоги организовать защиту диплома',{requestId:'timeout'});assert.equal(result.code,'AI_TIMEOUT');assert.equal(result.modelCalls,1);assert.ok(Date.now()-start<1000);assert.equal(store.items('alice').length,0);assert.equal(store.usage(NOW.slice(0,10)).reserved,0);
 }finally{store.close();}
});
test('a corrective model pass receives only the remaining turn deadline',async()=>{
 const store=new Store();try{const budgets=[],provider={complete:async({timeoutMs})=>{budgets.push(timeoutMs);await new Promise(resolve=>setTimeout(resolve,30));return{message:{content:'bad response'}};}};const assistant=new Assistant(store,{provider,allowedOwners:['alice'],clock:()=>NOW,timeBudgetMs:2000});const response=await assistant.handle('alice','сложная просьба',{requestId:'correction'});assert.equal(response.modelCalls,2);assert.ok(budgets[1]<budgets[0]-10);assert.equal(store.items('alice').length,0);
 }finally{store.close();}
});
test('a deleted or uneditable Telegram message falls back to a fresh message',async()=>{
 const calls=[],telegram=new Telegram('123456789:'+'A'.repeat(35),{fetcher:async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return calls.length===1?Response.json({ok:false,description:'Bad Request: message to edit not found'},{status:400}):Response.json({ok:true,result:{message_id:2}});}});
 const markup={inline_keyboard:[[{text:'Открыть',callback_data:'test'}]]};await telegram.edit('123',1,'Дело',markup);assert.deepEqual(calls.map(call=>call.method),['editMessageText','sendMessage']);assert.deepEqual(calls[1].body.reply_markup,markup);
});
