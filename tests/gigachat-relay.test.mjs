import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {ControlStore} from '../src/control.mjs';
import {ProviderLedger} from '../src/provider-ledger.mjs';
import {GigaChat} from '../src/gigachat.mjs';
import {GigaRelay,GIGA_CLAIM_URL,GIGA_BODY_LIMIT} from '../src/gigachat-relay.mjs';
import {createGigaBridge} from '../src/gigachat-bridge.mjs';
import {providerAvailability} from '../src/provider-settings.mjs';
const secret='synthetic-relay-secret-'.repeat(3),base='https://bob-giga-test.vercel.app/api/gigachat',NOW='2026-11-07T02:00:00.000Z';
const response=()=>Response.json({messages:[{role:'assistant',content:[{function_call:{name:'create_task',arguments:{title:'Синтетическая задача',due_text:null}}}]}],finish_reason:'function_call',usage:{total_tokens:123}});
async function sampleBody(){let encoded;const client=new GigaChat({budget:{reserve:async()=>randomUUID(),settle:async()=>{}},transport:{request:async body=>{encoded=body;return response();}}});await client.complete({context:{now:NOW,timezone:'Asia/Tomsk'},text:'Добавь синтетическую задачу'});return encoded;}
async function signedRequest(encoded,id,{clock=()=>Date.parse(NOW),url=base}={}){let request;await new GigaRelay({url,secret,clock,fetcher:async(target,init)=>{request=new Request(target,init);return response();}}).request(encoded,id,12000);return request;}
function fixture(){const store=new Store(),control=new ControlStore(store.db,{admin:'123',mode:'open',clock:()=>NOW});return{store,control,ledger:new ProviderLedger(control,{gigachatCap:50000000})};}
test('durable single-use claim rejects foreign providers, settled/old/revoked reservations and replay after restart',()=>{
 const {store,control}=fixture();let ledger=new ProviderLedger(control,{gigachatCap:50000000});try{let id=ledger.reserve('123','groq',10);assert.throws(()=>ledger.claim(id,'a'.repeat(64)));ledger.settle('123',id,10);id=ledger.reserve('123','gigachat',100);assert.throws(()=>ledger.claim(id,'a'.repeat(64),()=>false));assert.deepEqual(ledger.claim(id,'a'.repeat(64)),{claimed:true});ledger=new ProviderLedger(control,{gigachatCap:50000000});assert.throws(()=>ledger.claim(id,'b'.repeat(64)),e=>e.code==='PROVIDER_REPLAY');ledger.settle('123',id,50);assert.throws(()=>ledger.claim(id,'a'.repeat(64)),e=>e.code==='PROVIDER_CLAIM');id=ledger.reserve('123','gigachat',100);store.db.prepare("UPDATE provider_reservations SET created_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);assert.throws(()=>ledger.claim(id,'a'.repeat(64)),e=>e.code==='PROVIDER_CLAIM');control.access('200',{start:true});id=ledger.reserve('200','gigachat',100);control.revoke('123','200');assert.throws(()=>ledger.claim(id,'a'.repeat(64)),e=>e.code==='PROVIDER_CLAIM');}finally{store.close();}
});
test('signed relay claims before one native call; a second instance cannot replay the same reservation',async()=>{
 const {store,ledger}=fixture(),id=ledger.reserve('123','gigachat',20000),body=await sampleBody();let claims=0,generations=0;const make=()=>createGigaBridge({secret,clock:()=>Date.parse(NOW),tokens:{get:async()=> 'synthetic-access'},gigaFetcher:async(url,init)=>{generations++;assert.equal(url,'https://api.giga.chat/v2/chat/completions');assert.equal(init.headers.Authorization,'Bearer synthetic-access');return response();},fetcher:async(url,init)=>{claims++;assert.equal(url,GIGA_CLAIM_URL);assert.equal(init.headers.Authorization,'Bearer '+secret);const data=JSON.parse(init.body);try{return Response.json(ledger.claim(data.id,data.hash,()=>true,data.amount));}catch{return Response.json({claimed:false},{status:409});}}});
 try{const signed=await signedRequest(body,id),first=await make()(signed.clone());assert.equal(first.status,200);assert.equal((await first.json()).usage.total_tokens,123);const replay=await make()(signed.clone());assert.equal(replay.status,409);assert.equal(generations,1);assert.equal(claims,2);}finally{store.close();}
});
test('invalid or altered requests never claim or send a model request',async()=>{
 let calls=0;const bridge=createGigaBridge({secret,clock:()=>Date.parse(NOW),tokens:{get:async()=>{calls++;}},gigaFetcher:async()=>{calls++;},fetcher:async()=>{calls++;}}),body=await sampleBody(),valid=await signedRequest(body,randomUUID());
 const alteredHeaders=new Headers(valid.headers);alteredHeaders.set('X-BOB-Signature','f'.repeat(64));assert.equal((await bridge(new Request(base,{method:'POST',headers:alteredHeaders,body:await valid.clone().text()}))).status,403);
 const expired=await signedRequest(body,randomUUID(),{clock:()=>Date.parse(NOW)-31000});assert.equal((await bridge(expired)).status,403);
 const payload=JSON.parse(body);payload.model='paid-model';assert.equal((await bridge(await signedRequest(JSON.stringify(payload),randomUUID()))).status,400);
 payload.model='GigaChat-3-Ultra';payload.tools.push({web_search:{}});assert.equal((await bridge(await signedRequest(JSON.stringify(payload),randomUUID()))).status,400);
 assert.equal((await bridge(new Request(base,{method:'POST'}))).status,403);assert.equal(calls,0);
});
test('bridge body size, failed claims and provider errors do not leak credentials or cause fallback',async()=>{
 let generations=0;const bridge=createGigaBridge({secret,clock:()=>Date.parse(NOW),tokens:{get:async()=> 'private-token'},gigaFetcher:async()=>{generations++;return new Response('private-token private-provider-error',{status:429});},fetcher:async()=>Response.json({claimed:true})}),body=await sampleBody();const signed=await signedRequest(body,randomUUID()),headers=new Headers(signed.headers);
 assert.equal((await bridge(new Request(base,{method:'POST',headers,body:'x'.repeat(GIGA_BODY_LIMIT+1)}))).status,413);assert.equal(generations,0);
 const limited=await bridge(signed);assert.equal(limited.status,429);assert.equal((await limited.text()).includes('private'),false);assert.equal(generations,1);
 const denied=createGigaBridge({secret,clock:()=>Date.parse(NOW),tokens:{get:async()=>{throw Error('must not authorize');}},gigaFetcher:async()=>{throw Error('must not generate');},fetcher:async()=>Response.json({claimed:false},{status:409})});assert.equal((await denied(await signedRequest(body,randomUUID()))).status,409);
});
test('personal Giga availability does not expose an owner package to all public members',()=>{
 const env={TELEGRAM_OWNER_ID:'123',GIGACHAT_ENABLED:'true',GIGACHAT_FREE_CONFIRMED:'true',GIGACHAT_TRANSPORT_VERIFIED:'true',GIGACHAT_EVALUATED:'true',GIGACHAT_RELAY_URL:base,GIGACHAT_RELAY_SECRET:secret,GIGACHAT_TOKEN_CAP:'49900000'};assert.equal(providerAvailability(env,'123').gigachat,true);assert.equal(providerAvailability(env,'200').gigachat,false);assert.equal(providerAvailability({...env,GIGACHAT_PUBLIC_USE_CONFIRMED:'true'},'200').gigachat,true);assert.equal(providerAvailability({...env,GIGACHAT_TOKEN_CAP:'250000000'},'123').gigachat,false);
 assert.doesNotThrow(()=>new GigaRelay({url:'https://bob-giga-test.netlify.app/api/gigachat',secret}));assert.equal(providerAvailability({...env,GIGACHAT_RELAY_URL:'https://bob-giga-test.netlify.app/api/gigachat'},'123').gigachat,true);assert.throws(()=>new GigaRelay({url:'http://localhost/api/gigachat',secret}));assert.throws(()=>new GigaRelay({url:base+'?redirect=other',secret}));
});

test('deployment probes have a persistent two-call/10000-token upper bound independent of actual settlement',()=>{
 const {store,control}=fixture();let ledger=new ProviderLedger(control,{gigachatCap:50000000});try{assert.throws(()=>ledger.reserveProbe('200',1000));const first=ledger.reserveProbe('123',3000);assert.throws(()=>ledger.claim(first.id,'a'.repeat(64),()=>true,3001),e=>e.code==='PROVIDER_CLAIM');ledger.settleProbe('123',first.id,100);const second=ledger.reserveProbe('123',3000);ledger.settleProbe('123',second.id,50);ledger=new ProviderLedger(control,{gigachatCap:50000000});assert.throws(()=>ledger.reserveProbe('123',1),e=>e.code==='PROVIDER_PROBE_LIMIT');assert.throws(()=>ledger.settleProbe('123','unknown',0));}finally{store.close();}
});
