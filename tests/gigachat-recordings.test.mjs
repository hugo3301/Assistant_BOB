import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gigaMessage} from '../src/gigachat.mjs';
import {decodeCalls} from '../src/tools.mjs';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/gigachat-ultra-v2.json',import.meta.url)));
for(const sample of fixture.cases)test('real synthetic Ultra recording remains valid: '+sample.id,()=>{
 const store=new Store(),now=fixture.referenceAt;try{store.ensureUser('evaluation');for(const item of [{id:'report',kind:'task',title:'Отчёт',day:'2026-11-12'},{id:'lab-a',kind:'task',title:'Лаба по сетям',day:'2026-11-11'},{id:'lab-b',kind:'task',title:'Лаба по вычислениям',day:'2026-11-10'}])store.putItem({...item,owner:'evaluation'},now,60);store.db.prepare('UPDATE users SET focus_id=? WHERE id=?').run('report','evaluation');const before=store.items('evaluation'),calls=decodeCalls(gigaMessage(sample.messages));assert.equal(calls.length,1);assert.equal(calls[0].name,sample.expected);const prepared=new Assistant(store,{allowedOwners:['evaluation'],clock:()=>now}).prepare('evaluation',calls,sample.text,store.user('evaluation'),now);
 if(sample.id==='ordinary-evening')assert.equal(prepared[0].item.at,'2026-11-06T12:00:00.000Z');
 if(sample.id==='quoted-task')assert.equal(prepared[0].item.day,'2026-11-12');
 if(sample.id==='ambiguous-target')assert.equal(prepared[0].kind,'question');
 if(sample.id==='work-not-deadline'){assert.equal(prepared[0].item.duration,60);assert.equal(prepared[0].item.parent_id,'report');assert.equal(store.items('evaluation').find(item=>item.id==='report').day,'2026-11-12');}
 if(sample.id==='focused-completion')assert.equal(prepared[0].target.id,'report');
 if(sample.id==='weekly-view')assert.equal(prepared[0].scope,'week');
 assert.deepEqual(store.items('evaluation'),before);
 }finally{store.close();}
});
