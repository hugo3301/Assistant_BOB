import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const sent = [], calls = []; const secret='synthetic-webhook-secret-for-local-tests', admin='synthetic-admin-secret-for-local-tests';
let calendarBody='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BOB runtime tests//EN\r\nBEGIN:VEVENT\r\nUID:runtime-class\r\nSUMMARY:Runtime calendar class\r\nDTSTART;TZID=Asia/Tomsk:20261105T150000\r\nDTEND;TZID=Asia/Tomsk:20261105T160000\r\nEND:VEVENT\r\nEND:VCALENDAR';
const configuration=convertV4MiniflareOptions({unsafeInspectDurableObjects:true,name:'bob-cloud-test',modules:true,scriptPath:resolve('work/build/worker.js'),compatibilityDate:'2026-11-04',compatibilityFlags:['nodejs_compat'],durableObjects:{BOB:{className:'BobObject',useSQLite:true}},resourcePersistencePath:resolve(`work/cloud-test-${Date.now()}`),bindings:{TELEGRAM_OWNER_ID:'123',TELEGRAM_BOT_TOKEN:'123456789:'+ 'A'.repeat(35),TELEGRAM_WEBHOOK_SECRET:secret,ADMIN_SECRET:admin,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),WORKERS_AI_TOKEN:'synthetic-workers-ai-token-for-local-tests'},outboundService:async request=>{
  const url=new URL(request.url);calls.push(url.hostname);
  if(url.hostname==='api.telegram.org'){
    if(url.pathname.startsWith('/file/'))return new Response(calendarBody);
    if(url.pathname.endsWith('/getFile'))return Response.json({ok:true,result:{file_path:'documents/calendar.ics',file_size:Buffer.byteLength(calendarBody)}});
    const body=await request.json();sent.push(body);return Response.json({ok:true,result:{message_id:sent.length}});
  }
  if(url.hostname==='api.cloudflare.com')return Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'one',function:{name:'create_task',arguments:JSON.stringify({title:'Проверка сервера',due_text:'12 ноября'})}}]}}],usage:{neurons:1}});
  throw Error('Unexpected external request in cloud test');
}});
let mf=new Miniflare(configuration);
const request=async(path,body,headers={})=>{const response=await mf.dispatchFetch('https://bob.local'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return new Response(await response.text(),{status:response.status,headers:response.headers});};
const update=(id,text,from=123)=>({update_id:id,message:{message_id:id,from:{id:from},chat:{id:from,type:'private'},text}});
async function status(){return (await request('/admin/status',null,{Authorization:`Bearer ${admin}`})).json();}
async function until(predicate){const end=Date.now()+20000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Cloud worker test timed out');}
try{
  assert.equal((await request('/health')).status,200);
  assert.equal((await request('/admin/status')).status,404);
  assert.equal((await request('/telegram/webhook',update(1,'/start'))).status,404);
  assert.equal((await request('/telegram/webhook',update(2,'/start',456),{'X-Telegram-Bot-Api-Secret-Token':secret})).status,200);
  assert.equal((await request('/telegram/webhook',update(3,'Добавь задачу Проверка сервера к 12 ноября'),{'X-Telegram-Bot-Api-Secret-Token':secret})).status,200);
  await until(async()=> (await status()).jobs.some(row=>row.status==='done') && sent.some(message=>message.text.includes('Добавил: Проверка сервера')));
  const initialStatus = await status();
  if (initialStatus.items !== 1) { const db = await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:'owner:123:v1'}); console.log(JSON.stringify({diagnostic:initialStatus,syntheticReplies:sent,calls,outbox:await db.exec('SELECT payload,last_error FROM telegram_outbox')})); }
  assert.equal(initialStatus.items,1);assert.ok(sent.some(message=>message.text.includes('Добавил: Проверка сервера')));
  await request('/telegram/webhook',update(3,'Добавь задачу Проверка сервера к 12 ноября'),{'X-Telegram-Bot-Api-Secret-Token':secret});
  await new Promise(resolve=>setTimeout(resolve,1300));assert.equal((await status()).items,1);assert.equal(sent.filter(message=>message.text.includes('Добавил: Проверка сервера')).length,1);
  await mf.dispose(); mf=new Miniflare(configuration);
  assert.equal((await status()).items,1);
  const documentUpdate=update(4,'');delete documentUpdate.message.text;documentUpdate.message.document={file_id:'file-one',file_unique_id:'calendar-one',file_name:'schedule.ics',mime_type:'text/calendar',file_size:Buffer.byteLength(calendarBody)};
  await request('/telegram/webhook',documentUpdate,{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(async()=> (await status()).items===2&&sent.some(message=>message.text?.includes('Расписание расставлено')));
  calendarBody=calendarBody.replace('T150000','T170000').replace('T160000','T180000');
  documentUpdate.update_id=5;documentUpdate.message.document.file_unique_id='calendar-two';
  await request('/telegram/webhook',documentUpdate,{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(async()=> (await status()).jobs.some(row=>row.status==='done'&&row.count===3));
  assert.equal((await status()).items,2);
  const cloudDb=await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:'owner:123:v1'});
  const calendarRows=await cloudDb.exec("SELECT at FROM items WHERE title='Runtime calendar class' AND status='open'");
  assert.equal(calendarRows.length,1);assert.equal(calendarRows[0].at,'2026-11-05T10:00:00.000Z');
  console.log(JSON.stringify({localCloudRuntime:'passed',realSqliteDurableObject:true,ownerCheck:true,webhookAuthentication:true,durableJobAndOutbox:true,noDuplicate:true,calendarFileDownloaded:true,calendarAutoImported:true,calendarReuploadPreservedCount:true,externalNetwork:'stubbed',aiCalls:calls.filter(host=>host==='api.cloudflare.com').length}));
}finally{await mf.dispose();}

