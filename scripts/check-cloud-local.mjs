import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {ogg} from '../tests/ogg-fixture.mjs';
const sent = [], calls = [];let failNextSend=false; const secret='synthetic-webhook-secret-for-local-tests', admin='synthetic-admin-secret-for-local-tests';
let asrCalls=0,asrText='Завтра в семь вечера встреча по проекту';const voiceBody=ogg(10,{eos:false});
let calendarBody='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BOB runtime tests//EN\r\nBEGIN:VEVENT\r\nUID:runtime-class\r\nSUMMARY:Runtime calendar class\r\nDTSTART;TZID=Asia/Tomsk:20261105T150000\r\nDTEND;TZID=Asia/Tomsk:20261105T160000\r\nEND:VEVENT\r\nEND:VCALENDAR';
const configuration=convertV4MiniflareOptions({unsafeInspectDurableObjects:true,name:'bob-cloud-test',modules:true,scriptPath:resolve('work/build/worker.js'),compatibilityDate:'2026-11-04',compatibilityFlags:['nodejs_compat'],durableObjects:{BOB:{className:'BobObject',useSQLite:true},CONTROL:{className:'ControlObject',useSQLite:true}},resourcePersistencePath:resolve(`work/cloud-test-${Date.now()}`),bindings:{TELEGRAM_OWNER_ID:'123',TELEGRAM_BOT_TOKEN:'123456789:'+ 'A'.repeat(35),TELEGRAM_WEBHOOK_SECRET:secret,ADMIN_SECRET:admin,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),WORKERS_AI_TOKEN:'synthetic-workers-ai-token-for-local-tests'},outboundService:async request=>{
  const url=new URL(request.url);calls.push(url.hostname);
  if(url.hostname==='api.telegram.org'){
    if(url.pathname.endsWith('/getMe'))return Response.json({ok:true,result:{username:'mybob_robot'}});
    if(url.pathname.startsWith('/file/'))return new Response(url.pathname.endsWith('voice.oga')?voiceBody:calendarBody);
    if(url.pathname.endsWith('/getFile')){const body=await request.json();return Response.json({ok:true,result:body.file_id==='voice-one'?{file_path:'voice/voice.oga',file_size:voiceBody.length}:{file_path:'documents/calendar.ics',file_size:Buffer.byteLength(calendarBody)}});}
    const body=await request.json();if(failNextSend&&url.pathname.endsWith('/sendMessage')){failNextSend=false;return Response.json({ok:false,parameters:{retry_after:1}},{status:429});}sent.push(body);return Response.json({ok:true,result:{message_id:sent.length}});
  }
  if(url.hostname==='api.cloudflare.com'&&url.pathname.endsWith('/whisper-large-v3-turbo')){asrCalls++;return Response.json({success:true,result:{text:asrText,segments:[{no_speech_prob:0.01,avg_logprob:-0.2}]},usage:{neurons:8}});}
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
  await until(async()=> (await status()).jobs.some(row=>row.status==='done') && sent.some(message=>message.text?.includes('Проверка сервера')));
  const initialStatus = await status();
  if (initialStatus.items !== 1) { const db = await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:'owner:123:v1'}); console.log(JSON.stringify({diagnostic:initialStatus,syntheticReplies:sent,calls,outbox:await db.exec('SELECT payload,last_error FROM telegram_outbox')})); }
  assert.equal(initialStatus.items,1);assert.ok(sent.some(message=>message.text?.includes('Проверка сервера')));
  await request('/telegram/webhook',update(3,'Добавь задачу Проверка сервера к 12 ноября'),{'X-Telegram-Bot-Api-Secret-Token':secret});
  await new Promise(resolve=>setTimeout(resolve,1300));assert.equal((await status()).items,1);assert.equal(sent.filter(message=>message.text?.includes('Проверка сервера')).length,1);
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
  await request('/telegram/webhook',update(6,'/week'),{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(()=>sent.some(message=>message.reply_markup?.inline_keyboard&&message.text?.includes('Ближайшие 7 дней')));
  const list=sent.find(message=>message.reply_markup?.inline_keyboard&&message.text?.includes('Ближайшие 7 дней'));
  const cb={update_id:7,callback_query:{id:'synthetic-click',from:{id:123},data:list.reply_markup.inline_keyboard[0][0].callback_data,message:{message_id:6,from:{id:999,is_bot:true},chat:{id:123,type:'private'}}}};
  await request('/telegram/webhook',cb,{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(()=>sent.some(message=>message.callback_query_id==='synthetic-click')&&sent.some(message=>message.message_id===6&&message.reply_markup?.inline_keyboard));
  assert.ok(sent.filter(message=>message.text).every(message=>! /\[(?:task|ical)-/.test(message.text)));
  assert.equal((await request('/admin/telegram',{})).status,404);
  assert.equal((await request('/admin/telegram',{}, {Authorization:`Bearer ${admin}`})).status,200);
  assert.ok(sent.some(message=>message.allowed_updates?.includes('callback_query')&&message.drop_pending_updates===false));
  await request('/telegram/webhook',update(8,'удали все мои дела'),{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(()=>sent.some(message=>message.text?.includes('Дел: 2')));assert.equal((await status()).items,2);
  await request('/telegram/webhook',update(9,'все'),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(async()=>(await status()).items===0);
  await request('/telegram/webhook',update(10,'верни как было'),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(async()=>(await status()).items===2);
  await until(async()=>(await status()).latency.samples===8&&(await status()).latency.replyMs!==null);
  const latency=(await status()).latency;assert.equal(latency.withoutAI,8);assert.ok(latency.queueMs.p50<1000,'Immediate runner should remove the old one-second alarm floor');
  const count=sent.filter(message=>message.text).length;failNextSend=true;
  await request('/telegram/webhook',update(11,'/today'),{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(async()=>(await status()).outbox.some(row=>row.status==='pending'));assert.equal(sent.filter(message=>message.text).length,count);
  await request('/telegram/webhook',update(12,'/week'),{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(async()=>(await status()).latency.samples===10);assert.equal(sent.filter(message=>message.text).length,count);
  await mf.dispose();mf=new Miniflare(configuration);
  await until(()=>sent.filter(message=>message.text).length===count+2);
  assert.match(sent.filter(message=>message.text).at(-2).text,/Сегодня/);assert.match(sent.filter(message=>message.text).at(-1).text,/Ближайшие 7 дней/);
  for(let i=0;i<9;i++){
    const before=sent.filter(message=>message.text?.includes('start=join_')).length;
    await request('/telegram/webhook',update(100+i,'/invite'),{'X-Telegram-Bot-Api-Secret-Token':secret});
    await until(()=>sent.filter(message=>message.text?.includes('start=join_')).length===before+1);
    const invitation=/https:\/\/t.me\/mybob_robot\?start=(join_[\w-]+)/u.exec(sent.filter(message=>message.text?.includes('start=join_')).at(-1).text)[1];
    await request('/telegram/webhook',update(200+i,'/start '+invitation,200+i),{'X-Telegram-Bot-Api-Secret-Token':secret});
    await until(()=>sent.some(message=>String(message.chat_id)===String(200+i)&&message.text?.includes('Выбери свой город')));
    const welcome=sent.find(message=>String(message.chat_id)===String(200+i)&&message.text?.includes('Выбери свой город'));
    await request('/telegram/webhook',{update_id:250+i,callback_query:{id:`zone-${i}`,from:{id:200+i},data:welcome.reply_markup.inline_keyboard.flat().find(button=>button.text==='Томск').callback_data,message:{message_id:2000+i,chat:{id:200+i,type:'private'},from:{id:999,is_bot:true}}}},{'X-Telegram-Bot-Api-Secret-Token':secret});
    await request('/telegram/webhook',update(300+i,`Добавь задачу Личная ${i} к 12 ноября`,200+i),{'X-Telegram-Bot-Api-Secret-Token':secret});
    await until(()=>sent.some(message=>String(message.chat_id)===String(200+i)&&message.text?.includes(`Личная ${i}`)));
  }
  const registry=await(await request('/admin/registry',null,{Authorization:`Bearer ${admin}`})).json();assert.equal(registry.members.filter(member=>member.active).length,10);assert.equal((await status()).items,2);
  for(let i=0;i<9;i++){const db=await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:`owner:${200+i}:v1`});const rows=await db.exec("SELECT owner,title FROM items WHERE status='open'");assert.equal(rows.length,1);assert.equal(rows[0].owner,String(200+i));assert.equal(rows[0].title,`Личная ${i}`);}
  await request('/telegram/webhook',update(400,'Зафиксируй задачу Проверка сервера к 12 ноября',200),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>sent.some(message=>String(message.chat_id)==='200'&&message.text?.includes('Проверка сервера')));
  const metered=await(await request('/admin/registry',null,{Authorization:`Bearer ${admin}`})).json();assert.equal(metered.usage.spent,1);assert.equal(metered.usage.reserved,0);
  await request('/telegram/webhook',update(401,'/members',201),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>sent.some(message=>String(message.chat_id)==='201'&&message.text?.includes('доступен владельцу')));
  const voice=update(500,'',200);delete voice.message.text;voice.message.voice={file_id:'voice-one',file_unique_id:'unique-voice-one',duration:10,file_size:voiceBody.length,mime_type:'audio/ogg'};
  await request('/telegram/webhook',voice,{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>sent.some(message=>String(message.chat_id)==='200'&&message.text?.includes('Услышал')));
  await request('/telegram/webhook',voice,{'X-Telegram-Bot-Api-Secret-Token':secret});await new Promise(resolve=>setTimeout(resolve,200));assert.equal(asrCalls,1);
  assert.ok(sent.filter(message=>message.text).some(message=>message.entities?.some(entity=>entity.type==='bold')));for(const message of sent.filter(message=>message.text))for(const entity of message.entities??[])assert.ok(entity.offset>=0&&entity.offset+entity.length<=message.text.length);
  const voiceDb=await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:'owner:200:v1'});assert.equal((await voiceDb.exec("SELECT * FROM items WHERE kind='event' AND status='open'")).length,1);assert.equal((await(await request('/admin/registry',null,{Authorization:`Bearer ${admin}`})).json()).usage.spent,9);
  asrText='Сколько осталось токенов?';const quotaVoice=structuredClone(voice);quotaVoice.update_id=501;await request('/telegram/webhook',quotaVoice,{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>sent.some(message=>String(message.chat_id)==='200'&&message.text?.includes('Ресурс ИИ')&&message.text?.includes('Услышал')));assert.equal(asrCalls,2);assert.equal((await voiceDb.exec("SELECT * FROM items WHERE kind='event' AND status='open'")).length,1);
  await mf.dispose();mf=new Miniflare(configuration);assert.equal((await(await request('/admin/registry',null,{Authorization:`Bearer ${admin}`})).json()).members.length,10);assert.equal((await status()).items,2);
  console.log(JSON.stringify({localCloudRuntime:'passed',realSqliteDurableObject:true,ownerCheck:true,webhookAuthentication:true,durableJobAndOutbox:true,noDuplicate:true,calendarFileDownloaded:true,calendarAutoImported:true,calendarReuploadPreservedCount:true,callbackAcknowledgedAndEdited:true,bulkConfirmedAndUndone:true,deliveryRetryAndRestart:true,replyOrderPreserved:true,tenIsolatedUsers:true,sharedBudgetMetered:true,membersSurviveRestart:true,voiceDownloadedTranscribedAndSaved:true,voiceReplayWithoutSTT:true,latency,externalNetwork:'stubbed',aiCalls:calls.filter(host=>host==='api.cloudflare.com').length}));
}finally{await mf.dispose();}

