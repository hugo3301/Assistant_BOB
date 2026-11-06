import test from 'node:test';
import assert from 'node:assert/strict';
import {GigaTokenCache,GigaChat,gigaMessage} from '../src/gigachat.mjs';
import {decodeCalls} from '../src/tools.mjs';
import {Store} from '../src/store.mjs';
import {ControlStore} from '../src/control.mjs';
import {ProviderLedger} from '../src/provider-ledger.mjs';
import {providerAvailability} from '../src/provider-settings.mjs';
const key='synthetic-giga-authorization-key';
const action={name:'create_task',arguments:{title:'Отчёт',due_text:'12 ноября'}};
const message={role:'assistant',content:[{function_call:action}]};
const result=(usage={total_tokens:123,input_tokens:100,output_tokens:23})=>Response.json({messages:[message],finish_reason:'function_call',usage});
const budget=()=>({reserved:[],settled:[],async reserve(n){this.reserved.push(n);return 'r';},async settle(...args){this.settled.push(args);}});

test('Giga OAuth uses fixed endpoint, PERS scope, refresh margin and single-flight memory cache',async()=>{
 let now=Date.parse('2026-11-06T10:00:00Z'),calls=0;
 const cache=new GigaTokenCache({authKey:key,clock:()=>now,fetcher:async(url,init)=>{calls++;assert.equal(url,'https://ngw.devices.sberbank.ru:9443/api/v2/oauth');assert.equal(init.headers.Authorization,'Basic '+key);assert.match(init.headers.RqUID,/^[a-f0-9-]{36}$/u);assert.equal(init.body,'scope=GIGACHAT_API_PERS');assert.equal(init.redirect,'manual');return Response.json({access_token:'synthetic-access-token-long-'+calls,expires_at:now+1800000});}});
 const [a,b]=await Promise.all([cache.get(),cache.get()]);assert.equal(a,b);assert.equal(calls,1);now+=1700000;assert.equal(await cache.get(),a);now+=41000;assert.notEqual(await cache.get(),a);assert.equal(calls,2);await cache.get(true);assert.equal(calls,3);assert.equal(JSON.stringify(cache.cached).includes(key),false);
});
test('Giga OAuth rejects untrusted TLS and hides response or authorization details',async()=>{
 const cache=new GigaTokenCache({authKey:key,fetcher:async()=>{throw Error('certificate '+key);}});await assert.rejects(cache.get(),e=>e.code==='PROVIDER_AUTH'&&!e.message.includes(key));
 cache.fetcher=async()=>Response.json({access_token:'synthetic-access-token-long',expires_at:1});await assert.rejects(cache.get(),e=>e.code==='PROVIDER_AUTH');
});
test('Giga V2 native actions pass the existing schema, reject unknown tools, mixed questions and extra fields',()=>{
 assert.equal(decodeCalls(gigaMessage([message]))[0].name,'create_task');
 const withoutDate={role:'assistant',content:[{function_call:{name:'create_task',arguments:{title:'Разобрать фотографии',due_text:null}}}]};assert.equal(decodeCalls(gigaMessage([withoutDate]))[0].args.due_text,null);
 for(const name of ['reply_user','run_shell'])assert.throws(()=>gigaMessage([{role:'assistant',content:[{function_call:{name,arguments:{}}}]}]),e=>e.code==='GIGACHAT_ACTIONS');
 assert.throws(()=>decodeCalls(gigaMessage([{role:'assistant',content:[{function_call:{...action,arguments:{title:'Отчёт',unknown:true}}}]}])),e=>e.code==='UNKNOWN_ARGUMENT');
 assert.throws(()=>gigaMessage([{role:'assistant',content:[{text:'Я добавил задачу'}]}]),e=>e.code==='GIGACHAT_ACTIONS');
 assert.throws(()=>gigaMessage(Array(6).fill(message)),e=>e.code==='GIGACHAT_ACTIONS');
 const ask={role:'assistant',content:[{function_call:{name:'ask_user',arguments:{question:'Какая лаба?'}}}]};assert.throws(()=>decodeCalls(gigaMessage([message,ask])),e=>e.code==='MIXED_QUESTION');
 assert.equal(decodeCalls(gigaMessage([message,message])).length,2);
});
test('Giga native function request meters actual tokens and excludes other provider credentials',async()=>{
 const meter=budget();const client=new GigaChat({budget:meter,tokens:{get:async()=> 'synthetic-access'},fetcher:async(url,init)=>{assert.equal(url,'https://api.giga.chat/v2/chat/completions');assert.equal(init.headers.Authorization,'Bearer synthetic-access');assert.equal(init.redirect,'manual');const body=JSON.parse(init.body);assert.equal(body.model,'GigaChat-3-Ultra');assert.equal(body.model_options.parallel_tool_calls,true);assert.equal(body.tools[0].functions.specifications.length,9);assert.equal(body.tools[0].functions.specifications.some(tool=>tool.name==='reply_user'),false);assert.equal(JSON.stringify(body.messages).includes(key),false);return result();}});
 const response=await client.complete({context:{today:'2026-11-06'},text:'Добавь отчёт к 12 ноября'});assert.equal(decodeCalls(response.message)[0].args.title,'Отчёт');assert.equal(response.usage.tokens,123);assert.ok(meter.reserved[0]>1000);assert.deepEqual(meter.settled,[['r',123]]);
});
test('Giga token refresh retries only one unauthorized call, quota failure never falls back',async()=>{
 let calls=0;const refreshed=[],meter=budget();const client=new GigaChat({budget:meter,tokens:{get:async force=>{refreshed.push(Boolean(force));return 'synthetic-access';}},fetcher:async()=>++calls===1?new Response(null,{status:401}):result()});await client.complete({context:{},text:'Покажи дела'});assert.equal(calls,2);assert.deepEqual(refreshed,[false,true]);
 client.fetcher=async()=>{calls++;return new Response('private provider output',{status:429});};await assert.rejects(client.complete({context:{},text:'Покажи дела'}),e=>e.code==='PROVIDER_QUOTA'&&!e.message.includes('private'));assert.equal(calls,3);assert.deepEqual(meter.settled.at(-1),['r',null]);
});
test('Giga malformed response still settles, missing usage conservatively charges reservation',async()=>{
 const meter=budget(),client=new GigaChat({budget:meter,tokens:{get:async()=> 'synthetic-access'},fetcher:async()=>result(null)});await client.complete({context:{},text:'Добавь отчёт'});assert.deepEqual(meter.settled,[['r',null]]);client.fetcher=async()=>Response.json({messages:[message],finish_reason:'length',usage:{total_tokens:44}});await assert.rejects(client.complete({context:{},text:'Добавь отчёт'}),e=>e.code==='AI_RESPONSE');assert.deepEqual(meter.settled.at(-1),['r',44]);
});
test('Giga quota refusal and unrelated conversation do not send data to any API',async()=>{
 let calls=0;const client=new GigaChat({budget:{reserve:async()=>{throw Error('limit');}},tokens:{get:async()=>{calls++;}},fetcher:async()=>{calls++;}});await assert.rejects(client.complete({context:{},text:'Добавь отчёт'}));await assert.rejects(client.complete({context:{},text:'Рецепт',conversation:true}),e=>e.code==='GIGACHAT_SCOPE');assert.equal(calls,0);
});
test('Giga ledger enforces one stream, lifetime package and independent private daily limits',()=>{
 const store=new Store();let now='2026-11-06T10:00:00Z';try{const control=new ControlStore(store.db,{admin:'123',mode:'open',clock:()=>now}),ledger=new ProviderLedger(control,{gigachatCap:30000});control.access('200',{start:true});const id=ledger.reserve('123','gigachat',15000);assert.throws(()=>ledger.reserve('200','gigachat',100),e=>e.code==='PROVIDER_BUSY');ledger.settle('200',id,0);assert.throws(()=>ledger.reserve('200','gigachat',100),e=>e.code==='PROVIDER_BUSY');ledger.settle('123',id,12000);assert.throws(()=>ledger.reserve('123','gigachat',9000),e=>e.code==='PROVIDER_QUOTA');const other=ledger.reserve('200','gigachat',17000);ledger.settle('200',other,17000);now='2026-11-07T10:00:00Z';assert.throws(()=>ledger.reserve('123','gigachat',1001),e=>e.code==='PROVIDER_QUOTA');assert.equal(ledger.usage('123','gigachat').limits.at(-1).spent,29000);assert.equal(control.usage().spent,0);}finally{store.close();}
});
test('Giga stays disabled until account free package, transport and action quality are verified',()=>{
 const ready={GIGACHAT_ENABLED:'true',GIGACHAT_FREE_CONFIRMED:'true',GIGACHAT_PUBLIC_USE_CONFIRMED:'true',GIGACHAT_TRANSPORT_VERIFIED:'true',GIGACHAT_EVALUATED:'true',GIGACHAT_AUTH_KEY:key,GIGACHAT_TOKEN_CAP:'250000000'};assert.equal(providerAvailability(ready).gigachat,true);for(const name of Object.keys(ready)){const env={...ready};delete env[name];assert.equal(providerAvailability(env).gigachat,false,name);}
});
