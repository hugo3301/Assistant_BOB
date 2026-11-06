import test from 'node:test';
import assert from 'node:assert/strict';
import {rootCertificates} from 'node:tls';
import {globalAgent} from 'node:https';
import {EventEmitter} from 'node:events';
import {createGigaNodeFetch} from '../src/gigachat-node.mjs';
const ca=rootCertificates[0],url='https://api.giga.chat/v1/models';
function requester(reply){return(target,options,respond)=>{const req=new EventEmitter();req.end=body=>queueMicrotask(()=>{const res=new EventEmitter();res.headers={'content-type':'application/json'};res.statusCode=200;res.destroy=error=>res.emit('error',error);respond(res);reply({target,options,body,res});});return req;};}
test('Node Giga transport verifies TLS and limits CA to the individual fixed request',async()=>{
 const original=globalAgent.options.ca,fetcher=createGigaNodeFetch({ca,requester:requester(({target,options,res})=>{assert.equal(target,url);assert.equal(options.ca,ca);assert.equal(options.rejectUnauthorized,true);assert.ok(options.signal);res.emit('data',Buffer.from('{"data":[]}'));res.emit('end');})});const response=await fetcher(url,{redirect:'manual'});assert.deepEqual(await response.json(),{data:[]});assert.equal(globalAgent.options.ca,original);
});
test('Node Giga transport refuses arbitrary URLs, credentials, query, redirects and wrong methods before network',async()=>{
 let calls=0;const fetcher=createGigaNodeFetch({ca,requester:()=>{calls++;}});
 for(const target of ['https://evil.test/v1/models','https://api.giga.chat.evil.test/v1/models',url+'?target=evil',url+'#fragment','https://key@api.giga.chat/v1/models','https://api.giga.chat:444/v1/models'])await assert.rejects(fetcher(target,{redirect:'manual'}),e=>e.code==='GIGACHAT_DESTINATION');
 await assert.rejects(fetcher(url,{redirect:'follow'}),e=>e.code==='GIGACHAT_DESTINATION');await assert.rejects(fetcher(url,{method:'POST',redirect:'manual'}),e=>e.code==='GIGACHAT_DESTINATION');assert.equal(calls,0);
});
test('Node Giga POST preserves body and credentials only on an allowed destination; redirects stay responses',async()=>{
 const controller=new AbortController(),fetcher=createGigaNodeFetch({ca,requester:requester(({options,body,res})=>{assert.equal(options.signal,controller.signal);assert.equal(options.headers.authorization,'Basic synthetic');assert.equal(Number(options.headers['content-length']),Buffer.byteLength(body));assert.equal(body,'scope=GIGACHAT_API_PERS');res.statusCode=302;res.headers={location:'https://evil.test'};res.emit('end');})});const response=await fetcher('https://ngw.devices.sberbank.ru:9443/api/v2/oauth',{method:'POST',headers:{Authorization:'Basic synthetic'},body:'scope=GIGACHAT_API_PERS',redirect:'manual',signal:controller.signal});assert.equal(response.status,302);
});
test('Node Giga transport bounds input and streamed output and rejects truncated responses',async()=>{
 assert.throws(()=>createGigaNodeFetch({ca:'not a certificate'}),e=>e.code==='GIGACHAT_CA');let fetcher=createGigaNodeFetch({ca,requester:requester(({res})=>{res.emit('data',Buffer.alloc(1025));}),maxResponseBytes:1024});await assert.rejects(fetcher(url,{redirect:'manual'}),e=>e.code==='GIGACHAT_RESPONSE');fetcher=createGigaNodeFetch({ca,requester:requester(({res})=>res.emit('aborted'))});await assert.rejects(fetcher(url,{redirect:'manual'}),e=>e.code==='GIGACHAT_RESPONSE');await assert.rejects(fetcher('https://api.giga.chat/v1/chat/completions',{method:'POST',redirect:'manual',body:'x'.repeat(100001)}),e=>e.code==='GIGACHAT_REQUEST');
});
