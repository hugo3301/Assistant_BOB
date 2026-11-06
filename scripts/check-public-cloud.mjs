import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const secret='synthetic-public-webhook-secret',admin='synthetic-public-admin-secret',sent=[];
const mf=new Miniflare(convertV4MiniflareOptions({name:'bob-public-check',modules:true,scriptPath:resolve('work/build/worker.js'),compatibilityDate:'2026-11-04',compatibilityFlags:['nodejs_compat'],durableObjects:{BOB:{className:'BobObject',useSQLite:true},CONTROL:{className:'ControlObject',useSQLite:true}},bindings:{ALPHA_ACCESS_MODE:'open',TELEGRAM_OWNER_ID:'123',TELEGRAM_BOT_TOKEN:'123456789:'+'A'.repeat(35),TELEGRAM_WEBHOOK_SECRET:secret,ADMIN_SECRET:admin,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),WORKERS_AI_TOKEN:'synthetic-ai-token-no-live-use'},outboundService:async request=>{assert.equal(new URL(request.url).hostname,'api.telegram.org');sent.push(await request.json());return Response.json({ok:true,result:{message_id:sent.length}});}}));
const until=async predicate=>{const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error('Public test timed out');};
const update=async(id,text,n)=>{const r=await mf.dispatchFetch('https://bob.local/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:n,message:{message_id:n,from:{id,first_name:'Synthetic'},chat:{id,type:'private'},text}})});assert.equal(r.status,200);};
try{
 const health=await(await mf.dispatchFetch('https://bob.local/health')).json();assert.equal(health.features.registration,'open');assert.equal(health.features.userLimit,null);
 for(let id=200;id<215;id++){await update(id,'/start',id*10);await until(()=>sent.some(x=>String(x.chat_id)===String(id)));await update(id,'Москва',id*10+1);await until(()=>sent.some(x=>String(x.chat_id)===String(id)&&x.text?.includes('Москв')));}
 const registry=await(await mf.dispatchFetch('https://bob.local/admin/registry',{headers:{Authorization:`Bearer ${admin}`}})).json();assert.equal(registry.activeCount,16);assert.equal(registry.capacity,null);
 await update(200,'Добавь задачу личная проверка',4000);await until(()=>sent.some(x=>String(x.chat_id)==='200'&&x.text?.includes('Добавлено')));await update(201,'/tasks',4001);await until(()=>sent.some(x=>String(x.chat_id)==='201'&&x.text?.includes('дел')));assert.ok(sent.filter(x=>String(x.chat_id)==='201').every(x=>!x.text?.includes('личная проверка')));
 console.log(JSON.stringify({publicRegistration:true,moreThanTen:true,privateUserData:true,noModelRequests:true}));
}finally{await mf.dispose();}
