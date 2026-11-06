import test from 'node:test';
import assert from 'node:assert/strict';
import {GigaTokenCache,GigaChat,gigaMessage} from '../src/gigachat.mjs';
import {decodeCalls} from '../src/tools.mjs';
import {Store} from '../src/store.mjs';
import {ControlStore} from '../src/control.mjs';
import {ProviderLedger} from '../src/provider-ledger.mjs';
import {providerAvailability} from '../src/provider-settings.mjs';
const key='synthetic-giga-authorization-key';
const action={name:'create_task',arguments_json:JSON.stringify({title:'Отчёт',due_text:'12 ноября'})};
const message={role:'assistant',function_call:{name:'propose_actions',arguments:{actions:[action]}}};
const result=(usage={total_tokens:123,prompt_tokens:100,completion_tokens:23})=>Response.json({choices:[{finish_reason:'function_call',message}],usage});
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
test('Giga dispatcher still passes through application tool schema and rejects chat or arbitrary functions',()=>{
 assert.equal(decodeCalls(gigaMessage(message))[0].name,'create_task');
 for(const bad of [{name:'reply_user',arguments_json:'{"answer":"ok"}'},{name:'run_shell',arguments_json:'{}'}])assert.throws(()=>gigaMessage({function_call:{name:'propose_actions',arguments:{actions:[bad]}}}),e=>e.code==='GIGACHAT_ACTIONS');
 assert.throws(()=>decodeCalls(gigaMessage({function_call:{name:'propose_actions',arguments:{actions:[{...action,arguments_json:'{"title":"Отчёт","unknown":true}'}]}}})),e=>e.code==='UNKNOWN_ARGUMENT');
 assert.throws(()=>gigaMessage({content:'Я добавил задачу'}),e=>e.code==='GIGACHAT_ACTIONS');
 assert.throws(()=>gigaMessage({function_call:{name:'propose_actions',arguments:{actions:Array(6).fill(action)}}}),e=>e.code==='GIGACHAT_ACTIONS');
});
test('Giga native function request meters actual tokens and excludes other provider credentials',async()=>{
 const meter=budget();const client=new GigaChat({budget:meter,tokens:{get:async()=> 'synthetic-access'},fetcher:async(url,init)=>{assert.equal(url,'https://api.giga.chat/v1/chat/completions');assert.equal(init.headers.Authorization,'Bearer synthetic-access');assert.equal(init.redirect,'manual');const body=JSON.parse(init.body);assert.equal(body.model,'GigaChat-2');assert.equal(body.function_call.name,'propose_actions');assert.equal(body.functions.length,1);assert.equal(body.functions[0].parameters.properties.actions.items.properties.name.enum.includes('reply_user'),false);assert.equal(body.messages.some(x=>x.content.includes(key)),false);return result();}});
 const response=await client.complete({context:{today:'2026-11-06'},text:'Добавь отчёт к 12 ноября'});assert.equal(decodeCalls(response.message)[0].args.title,'Отчёт');assert.equal(response.usage.tokens,123);assert.ok(meter.reserved[0]>1000);assert.deepEqual(meter.settled,[['r',123]]);
});
test('Giga token refresh retries only one unauthorized call, quota failure never falls back',async()=>{
 let calls=0;const refreshed=[],meter=budget();const client=new GigaChat({budget:meter,tokens:{get:async force=>{refreshed.push(Boolean(force));return 'synthetic-access';}},fetcher:async()=>++calls===1?new Response(null,{status:401}):result()});await client.complete({context:{},text:'Покажи дела'});assert.equal(calls,2);assert.deepEqual(refreshed,[false,true]);
 client.fetcher=async()=>{calls++;return new Response('private provider output',{status:429});};await assert.rejects(client.complete({context:{},text:'Покажи дела'}),e=>e.code==='PROVIDER_QUOTA'&&!e.message.includes('private'));assert.equal(calls,3);assert.deepEqual(meter.settled.at(-1),['r',null]);
});
test('Giga malformed response still settles, missing usage conservatively charges reservation',async()=>{
 const meter=budget(),client=new GigaChat({budget:meter,tokens:{get:async()=> 'synthetic-access'},fetcher:async()=>result(null)});await client.complete({context:{},text:'Добавь отчёт'});assert.deepEqual(meter.settled,[['r',null]]);client.fetcher=async()=>Response.json({choices:[{finish_reason:'length',message}],usage:{total_tokens:44}});await assert.rejects(client.complete({context:{},text:'Добавь отчёт'}),e=>e.code==='AI_RESPONSE');assert.deepEqual(meter.settled.at(-1),['r',44]);
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
