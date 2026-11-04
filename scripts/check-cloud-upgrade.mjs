import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const previous=process.argv[2];if(!previous)throw Error('Supply a previously built Worker bundle');
const secret='synthetic-upgrade-webhook-secret',admin='synthetic-upgrade-admin-secret',sent=[];
const common={unsafeInspectDurableObjects:true,name:'bob-upgrade-test',modules:true,compatibilityDate:'2026-11-04',compatibilityFlags:['nodejs_compat'],resourcePersistencePath:resolve(`work/upgrade-${Date.now()}`),bindings:{TELEGRAM_OWNER_ID:'123',TELEGRAM_BOT_TOKEN:'123456789:'+'A'.repeat(35),TELEGRAM_WEBHOOK_SECRET:secret,ADMIN_SECRET:admin,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),WORKERS_AI_TOKEN:'synthetic-upgrade-ai-token'},outboundService:async request=>{if(new URL(request.url).hostname!=='api.telegram.org')throw Error('Unexpected model call');sent.push(await request.json());return Response.json({ok:true,result:{message_id:sent.length}});}};
let mf=new Miniflare(convertV4MiniflareOptions({...common,scriptPath:resolve(previous),durableObjects:{BOB:{className:'BobObject',useSQLite:true}}}));
const request=async(path,data)=>{const response=await mf.dispatchFetch('https://upgrade.local'+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${admin}`,'X-Telegram-Bot-Api-Secret-Token':secret},...(data?{body:JSON.stringify(data)}:{})});return response.json();};
try{
 await request('/admin/status');const db=await mf.unsafeGetDurableObjectStorage('bob-upgrade-test','BobObject',{name:'owner:123:v1'});
 await db.exec("INSERT INTO items(id,owner,kind,title,day,at,duration,reminder_minutes,created_at) VALUES ('legacy-report','123','task','Сохранённый отчёт','2026-11-12',NULL,NULL,60,'2026-11-04T00:00:00Z')");
 await db.exec("INSERT INTO item_context(item_id,area) VALUES ('legacy-report','Учёба')");
 await db.exec("UPDATE users SET focus_id='legacy-report',revision=7,history='[{\"user\":\"Старый диалог\",\"assistant\":\"Сохранено\"}]' WHERE id='123'");
 await db.exec("INSERT OR REPLACE INTO budget VALUES ('2026-11-04',77,0)");
 await db.exec("INSERT INTO telegram_outbox(id,payload,next_at) VALUES ('legacy-outbox','{\"text\":\"Старый недоставленный ответ\"}','2026-11-04T00:00:00Z')");
 await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions({...common,scriptPath:resolve('work/build/worker.js'),durableObjects:{BOB:{className:'BobObject',useSQLite:true},CONTROL:{className:'ControlObject',useSQLite:true}}}));
 assert.equal((await request('/admin/status')).items,1);const bootstrap=await request('/admin/bootstrap',{});assert.equal(bootstrap.globalBudget.spent,77);await request('/admin/bootstrap',{});assert.equal((await request('/admin/registry')).usage.spent,77);
 await mf.dispatchFetch('https://upgrade.local/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:51,message:{message_id:51,from:{id:123},chat:{id:123,type:'private'},text:'/today'}})});
 const end=Date.now()+10000;while(Date.now()<end&&sent.filter(message=>message.text).length<2)await new Promise(resolve=>setTimeout(resolve,100));
 const current=await mf.unsafeGetDurableObjectStorage('bob-upgrade-test','BobObject',{name:'owner:123:v1'}),users=await current.exec('SELECT focus_id,history,revision FROM users');assert.equal(users[0].focus_id,'legacy-report');assert.ok(users[0].history.includes('Старый диалог'));assert.ok(users[0].revision>7);assert.equal((await request('/admin/status')).items,1);assert.equal(sent.filter(message=>message.text)[0].text,'Старый недоставленный ответ');
 console.log(JSON.stringify({upgradePassed:true,oldOwnerNamespacePreserved:true,itemsAndHistoryPreserved:true,legacyOutboxDelivered:true,legacyBudgetSeededOnce:true}));
}finally{await mf.dispose();}
