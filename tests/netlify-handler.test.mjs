import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createNetlifyHandler} from '../src/netlify-handler.mjs';
import {createGigaBridge} from '../src/gigachat-bridge.mjs';
import {GIGA_BODY_LIMIT,bodyHash,relaySignature} from '../src/gigachat-relay.mjs';
const url='https://bob-gigachat-bridge.netlify.app/api/gigachat';
for(const body of ['{ "text": "завтра встреча 🍉" }\n','{"unicode":"\\u044f","x":"a\\u0000b"}'])test('modern Netlify preserves exact UTF8 signed bytes: '+body.length,async()=>{
 const expected=Buffer.from(body),response=await createNetlifyHandler(async request=>{assert.equal(request.url,url);assert.equal(request.headers.get('x-bob-signature'),'synthetic');assert.deepEqual(Buffer.from(await request.arrayBuffer()),expected);return Response.json({ok:true},{headers:{'cache-control':'no-store'}});})(new Request(url,{method:'POST',headers:{'x-bob-signature':'synthetic'},body}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{ok:true});
});
test('modern Netlify preserves query, method and denied status',async()=>{const response=await createNetlifyHandler(async request=>{assert.equal(new URL(request.url).search,'?extra=1');assert.equal(request.method,'POST');return Response.json({code:'NOT_FOUND'},{status:404});})(new Request(url+'?extra=1',{method:'POST',body:'{}'}));assert.equal(response.status,404);});
test('modern Netlify GET and HEAD have no body',async()=>{for(const method of ['GET','HEAD']){const response=await createNetlifyHandler(async request=>{assert.equal(request.method,method);assert.equal(request.body,null);return new Response(null,{status:200});})(new Request(url,{method}));assert.equal(response.status,200);}});
test('modern Netlify bounds streams and cancels oversize before dispatch',async()=>{let calls=0,cancelled=false;const handler=createNetlifyHandler(async()=>{calls++;return new Response('unexpected');});const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(4096));},cancel(){cancelled=true;}});assert.equal((await handler(new Request(url,{method:'POST',body:stream,duplex:'half'}))).status,413);assert.ok(cancelled);assert.equal(calls,0);});
test('modern Netlify accepts boundary byte size and rejects oversized unicode',async()=>{let calls=0;const handler=createNetlifyHandler(async request=>{calls++;assert.equal((await request.arrayBuffer()).byteLength,GIGA_BODY_LIMIT);return new Response('ok');});assert.equal((await handler(new Request(url,{method:'POST',body:'a'.repeat(GIGA_BODY_LIMIT)}))).status,200);assert.equal((await handler(new Request(url,{method:'POST',body:'я'.repeat(GIGA_BODY_LIMIT)}))).status,413);assert.equal(calls,1);});
test('modern Netlify sanitizes exceptions without exposing credentials',async()=>{const secret='synthetic-secret-must-not-leak',response=await createNetlifyHandler(async()=>{throw Error(secret);})(new Request(url));assert.equal(response.status,503);assert.ok(!(await response.text()).includes(secret));});
test('modern Netlify forwards signed bytes to HMAC verification before any claim or generation',async()=>{
 let claims=0;const secret='synthetic-modern-netlify-relay-secret',now=Date.now(),reservationId=randomUUID(),timestamp=String(now),deadline=String(now+10000);
 const raw=JSON.stringify({reservationId,request:{model:'forbidden'}}),hash=bodyHash(raw),signature=relaySignature(secret,{timestamp,deadline,reservationId,hash});
 const handler=createNetlifyHandler(createGigaBridge({secret,clock:()=>now,tokens:{get:async()=>{throw Error('must not authorize');}},gigaFetcher:async()=>{throw Error('must not generate');},fetcher:async()=>{claims++;throw Error('must not claim');}}));
 const headers={'Content-Type':'application/json','X-BOB-Time':timestamp,'X-BOB-Deadline':deadline,'X-BOB-Reservation':reservationId,'X-BOB-Signature':signature};
 const signed=await handler(new Request(url,{method:'POST',headers,body:raw}));assert.equal(signed.status,400);assert.equal((await signed.json()).code,'BRIDGE_REQUEST');
 const altered=await handler(new Request(url,{method:'POST',headers,body:raw+' '}));assert.equal(altered.status,403);assert.equal((await altered.json()).code,'BRIDGE_AUTH');assert.equal(claims,0);
});
test('deploy entry uses default web handler and native route without legacy handler export',async()=>{const source=await readFile(new URL('../deploy/gigachat-relay/netlify/gigachat.mjs',import.meta.url),'utf8');assert.match(source,/export default createNetlifyHandler/u);assert.doesNotMatch(source,/export (?:const|function) handler/u);assert.match(source,/config=\{path:'\/api\/gigachat'\}/u);});
