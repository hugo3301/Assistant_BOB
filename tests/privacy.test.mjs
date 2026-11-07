import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {modelContext} from '../src/context.mjs';
import {containsCredential,redactCredentials,minimalUpdate,configuredSecrets} from '../src/privacy.mjs';
import {remoteJson} from '../src/remote-json.mjs';
import {Telegram} from '../src/telegram.mjs';
import {WorkersAI} from '../src/ai.mjs';
import {SpeechAI,VoiceFlow} from '../src/voice.mjs';
import {GroqSpeech} from '../src/groq.mjs';
import {GoogleCalendar} from '../src/calendars/google.mjs';
import {YandexCalendar} from '../src/calendars/yandex.mjs';
import {ogg} from './ogg-fixture.mjs';
const NOW='2026-11-07T02:00:00.000Z',key='gsk_'+'A'.repeat(40),botToken='123456789:'+'B'.repeat(35);
test('credential recognizer avoids ordinary reminders and masks only recognized/configured secrets',()=>{
 for(const text of [key,botToken,'GOOGLE_CLIENT_SECRET='+'x'.repeat(24),'пароль: '+'X'.repeat(20),'-----BEGIN '+'PRIVATE KEY-----\nsynthetic\n-----END '+'PRIVATE KEY-----'])assert.equal(containsCredential(text),true,text.slice(0,8));
 for(const text of ['напомни завтра поменять пароль','купить ключ на 12','встреча с 15:30 до 16:00','2026-11-07','abcdef1234567890'.repeat(4)])assert.equal(containsCredential(text),false);
 assert.equal(redactCredentials('до '+key+' после'),'до [скрыто] после');assert.equal(redactCredentials('ABC unknown-random-CF-value',['unknown-random-CF-value']),'ABC [скрыто]');assert.equal(configuredSecrets({ADMIN_SECRET:'x'.repeat(32),GROQ_ENABLED:'true',TELEGRAM_OWNER_ID:'123'}).length,1);
});
test('durable queue input strips unused profiles/forwarding/contact and rejects secret-bearing text before storage',()=>{
 const update={update_id:1,message:{message_id:3,from:{id:123,is_bot:false,first_name:'PRIVATE NAME',username:'PRIVATE LOGIN',language_code:'ru'},chat:{id:123,type:'private',first_name:'PRIVATE'},text:'Добавь задачу купить хлеб',contact:{phone_number:'PRIVATE'},forward_origin:{sender_user:{id:999}},reply_to_message:{text:'PRIVATE'}}};
 const clean=minimalUpdate(update);assert.equal(clean.message.text,update.message.text);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE|contact|forward_origin|reply_to_message|username/);
 update.message.text='Добавь '+key;const blocked=minimalUpdate(update);assert.equal(blocked.message.text,'/security-input-blocked');assert.equal(JSON.stringify(blocked).includes(key),false);
 const callback=minimalUpdate({update_id:4,callback_query:{id:'c',data:'n|today',from:{id:123,username:'PRIVATE'},message:{...update.message,text:'PRIVATE BOT HISTORY'}}});assert.equal(callback.callback_query.message.text,undefined);assert.doesNotMatch(JSON.stringify(callback),/PRIVATE/);
});
test('model gets no unrelated tasks/history; changes disclose only relevant owned candidates',()=>{
 const store=new Store();try{store.ensureUser('alice');store.ensureUser('bob');for(const [id,owner,title] of [['a','alice','Отчет по практике'],['b','alice','Личная медицинская встреча'],['c','bob','Отчет чужого владельца']])store.putItem({id,owner,kind:'task',title},NOW,60);store.db.prepare('UPDATE users SET focus_id=?,history=? WHERE id=?').run('b',JSON.stringify([{user:'PRIVATE unrelated conversation',assistant:'PRIVATE'}]),'alice');
 const fresh=modelContext(store,'alice','добавь задачу сдать новую работу к 12 ноября',NOW);assert.equal(fresh.items.length,0);assert.equal(fresh.history.length,0);assert.equal(fresh.focus_id,null);
 const change=modelContext(store,'alice','перенеси срок Отчет по практике на 14 ноября',NOW);assert.deepEqual(change.items.map(x=>x.id),['a']);assert.equal(JSON.stringify(change).includes('PRIVATE'),false);assert.equal(JSON.stringify(change).includes('медицинская'),false);
 const focused=modelContext(store,'alice','её уже сделал',NOW);assert.equal(focused.focus_id,'b');assert.ok(focused.items.some(x=>x.id==='b'));assert.ok(focused.items.every(x=>x.id!=='c'));
 }finally{store.close();}
});
test('secret-bearing text/diet/ICS never becomes a turn, task, model request or conversation history',async()=>{
 const store=new Store();let calls=0;const assistant=new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW,provider:{complete:()=>{calls++;throw Error('unexpected');}}}),alpha=new Alpha(store,assistant,{clock:()=>NOW});try{
 for(const [text,options] of [['добавь задачу '+key,{}],['/diet '+key,{}],['Файл',{documentText:'BEGIN:VCALENDAR\nSUMMARY:'+key}]]){const result=await alpha.handle('alice',text,options);assert.equal(result.code,'SENSITIVE_INPUT');assert.equal(result.text.includes(key),false);}
 assert.equal(calls,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n,0);assert.equal(store.items('alice').length,0);
 }finally{store.close();}
});
test('recognized secret in voice is neither cached, echoed nor dispatched after STT',async()=>{
 const store=new Store();let dispatched=0;store.ensureUser('alice');const flow=new VoiceFlow(store,'alice',{telegram:{voice:async()=>ogg(4)},speech:{transcribe:async()=>({text:'добавь '+key,uncertain:false})},clock:()=>NOW});try{await assert.rejects(flow.handle({file_id:'synthetic',duration:4},'voice',()=>{dispatched++;}),e=>e.code==='SENSITIVE_INPUT'&&!e.message.includes(key));assert.equal(dispatched,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM voice_receipts').get().n,0);}finally{store.close();}
});
test('Telegram output masks legacy secret strings and clears stale entity offsets',async()=>{
 const sent=[],tg=new Telegram(botToken,{fetcher:async(_url,init)=>{assert.equal(init.redirect,'manual');sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{}});}});await tg.send(123,'старое дело '+key,undefined,[{type:'bold',offset:0,length:10}]);await tg.edit(123,1,'старый '+key,{},[{type:'bold',offset:0,length:4}]);for(const row of sent){assert.equal(row.text.includes(key),false);assert.deepEqual(row.entities,[]);}
});
test('credentialed text/STT/Telegram requests refuse redirects and do not send data to another host',async()=>{
 let requests=0;const redirect=async(_url,init)=>{requests++;assert.equal(init.redirect,'manual');return new Response('{}',{status:307,headers:{Location:'https://untrusted.invalid/collect'}});},store=new Store(),budget={reserve:async()=> 'r',settle:async()=>{}};try{
 const cloud=new WorkersAI(store,{accountId:'a'.repeat(32),token:'synthetic-workers-ai-token',budget,fetcher:redirect});await assert.rejects(cloud.complete({context:{},text:'Встреча завтра'}));
 await assert.rejects(new SpeechAI({accountId:'a'.repeat(32),token:'synthetic-workers-ai-token',budget,fetcher:redirect}).transcribe(new Uint8Array([1]),1));
 await assert.rejects(new GroqSpeech({token:'synthetic-groq-api-token',budget,fetcher:redirect}).transcribe(new Uint8Array([1]),1));
 await assert.rejects(new Telegram(botToken,{fetcher:redirect}).send(123,'private text'));assert.equal(requests,4);
 }finally{store.close();}
});
test('streaming JSON boundary cancels oversized input and never reflects its contents',async()=>{
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('PRIVATE'.repeat(20)));},cancel(){cancelled=true;}});await assert.rejects(remoteJson(new Response(stream),{limit:10}),e=>e.code==='REMOTE_RESPONSE'&&!e.message.includes('PRIVATE'));assert.equal(cancelled,true);
});
test('calendar writes reject credential-bearing titles before credentialed network calls',async()=>{
 let requests=0;const fetcher=()=>{requests++;throw Error('must not call');},item={title:'meeting '+key,status:'open'};
 await assert.rejects(new GoogleCalendar({credentials:{},configuration:{},fetcher}).write('synthetic',{},item,{create:true}),e=>e.code==='SENSITIVE_INPUT');
 await assert.rejects(new YandexCalendar({credentials:{},fetcher}).write('https://caldav.yandex.ru/calendars/synthetic/',{resource:'https://caldav.yandex.ru/calendars/synthetic/one.ics'},item,{create:true}),e=>e.code==='SENSITIVE_INPUT');assert.equal(requests,0);
});
