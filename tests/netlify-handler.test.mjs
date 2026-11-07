import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetlifyHandler} from '../src/netlify-handler.mjs';
import {GIGA_BODY_LIMIT} from '../src/gigachat-relay.mjs';
const event={rawUrl:'https://bob-gigachat-bridge.netlify.app/api/gigachat',httpMethod:'POST',headers:{'content-type':'application/json','x-bob-signature':'synthetic'},body:'{"text":"завтра встреча"}'};
for(const base64 of[false,true])test('Netlify preserves exact signed bytes '+(base64?'base64':'utf8'),async()=>{
 const expected=Buffer.from(event.body),handler=createNetlifyHandler(async request=>{assert.equal(request.url,event.rawUrl);assert.equal(request.headers.get('x-bob-signature'),'synthetic');assert.deepEqual(Buffer.from(await request.arrayBuffer()),expected);return Response.json({ok:true},{headers:{'cache-control':'no-store'}});});
 const response=await handler({...event,isBase64Encoded:base64,body:base64?expected.toString('base64'):event.body});assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');assert.deepEqual(JSON.parse(response.body),{ok:true});assert.equal(response.isBase64Encoded,false);
});
test('Netlify forwards error status and retains original query',async()=>{const response=await createNetlifyHandler(async request=>{assert.equal(new URL(request.url).search,'?extra=1');return Response.json({code:'NOT_FOUND'},{status:404});})({...event,rawUrl:event.rawUrl+'?extra=1'});assert.equal(response.statusCode,404);});
test('Netlify GET has no body even if supplied',async()=>{const response=await createNetlifyHandler(async request=>{assert.equal(request.method,'GET');assert.equal(request.body,null);return Response.json({status:'ok'});})({...event,httpMethod:'GET'});assert.equal(response.statusCode,200);});
test('Netlify bounds encoded and decoded bodies before dispatch',async()=>{let calls=0;const handler=createNetlifyHandler(async()=>{calls++;return new Response('unexpected');});for(const input of[{body:'x'.repeat(GIGA_BODY_LIMIT*2+1)},{body:'я'.repeat(GIGA_BODY_LIMIT)},{body:Buffer.alloc(GIGA_BODY_LIMIT+1).toString('base64'),isBase64Encoded:true}]){assert.equal((await handler({...event,...input})).statusCode,413);}assert.equal(calls,0);});
test('Netlify sanitizes exceptions without exposing credentials',async()=>{const secret='synthetic-secret-that-must-not-appear',response=await createNetlifyHandler(async()=>{throw Error(secret);})(event);assert.equal(response.statusCode,503);assert.ok(!JSON.stringify(response).includes(secret));});
test('Netlify preserves denied authentication response',async()=>{const response=await createNetlifyHandler(async()=>Response.json({code:'BRIDGE_AUTH'},{status:403}))(event);assert.equal(response.statusCode,403);assert.equal(JSON.parse(response.body).code,'BRIDGE_AUTH');});
