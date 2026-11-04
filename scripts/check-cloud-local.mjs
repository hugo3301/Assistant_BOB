import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {ogg} from '../tests/ogg-fixture.mjs';
import {APP_ORIGIN} from '../src/calendars/pages.mjs';
import {GOOGLE_SCOPES} from '../src/calendars/google.mjs';
const googleEvents=new Map(),googleWrites=[];let googleVersion=0;
const googleDay=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
googleEvents.set('remote-synthetic',{id:'remote-synthetic',etag:'"one"',summary:'Из Google',start:{dateTime:googleDay+'T10:00:00Z'},end:{dateTime:googleDay+'T11:00:00Z'}});
const yandexResources=new Map(),yandexWrites=[];let yandexVersion=0;
const yandexCollection='https://caldav.yandex.ru/calendars/synthetic/one/';
const yandexOriginal='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BOB synthetic CalDAV//EN\r\nBEGIN:VEVENT\r\nUID:runtime-yandex\r\nSUMMARY:Из Яндекса\r\nDTSTART:'+googleDay.replaceAll('-','')+'T120000Z\r\nDTEND:'+googleDay.replaceAll('-','')+'T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
yandexResources.set(yandexCollection+'remote.ics',{body:yandexOriginal,etag:'"dav-one"'});
const davMulti=rows=>'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'+rows+'</d:multistatus>',davRow=(href,props)=>`<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const sent = [], calls = [];let failNextSend=false; const secret='synthetic-webhook-secret-for-local-tests', admin='synthetic-admin-secret-for-local-tests';
let asrCalls=0,asrText='Завтра в семь вечера встреча по проекту';const voiceBody=ogg(10,{eos:false});
let calendarBody='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BOB runtime tests//EN\r\nBEGIN:VEVENT\r\nUID:runtime-class\r\nSUMMARY:Runtime calendar class\r\nDTSTART;TZID=Asia/Tomsk:20261105T150000\r\nDTEND;TZID=Asia/Tomsk:20261105T160000\r\nEND:VEVENT\r\nEND:VCALENDAR';
const configuration=convertV4MiniflareOptions({unsafeInspectDurableObjects:true,name:'bob-cloud-test',modules:true,scriptPath:resolve('work/build/worker.js'),compatibilityDate:'2026-11-04',compatibilityFlags:['nodejs_compat'],durableObjects:{BOB:{className:'BobObject',useSQLite:true},CONTROL:{className:'ControlObject',useSQLite:true}},resourcePersistencePath:resolve(`work/cloud-test-${Date.now()}`),bindings:{CALENDAR_SECRET_KEY:'c'.repeat(64),GOOGLE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-client-secret',TELEGRAM_OWNER_ID:'123',TELEGRAM_BOT_TOKEN:'123456789:'+ 'A'.repeat(35),TELEGRAM_WEBHOOK_SECRET:secret,ADMIN_SECRET:admin,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),WORKERS_AI_TOKEN:'synthetic-workers-ai-token-for-local-tests'},outboundService:async request=>{
  const url=new URL(request.url);calls.push(url.hostname);
  if(url.hostname==='caldav.yandex.ru'){
    assert.ok(request.headers.get('Authorization').startsWith('Basic '));
    if(request.method==='PROPFIND'){const body=await request.text();return new Response(davMulti(body.includes('current-user-principal')?davRow('/','<d:current-user-principal><d:href>/principals/synthetic/</d:href></d:current-user-principal>'):body.includes('calendar-home-set')?davRow('/principals/synthetic/','<c:calendar-home-set><d:href>/calendars/synthetic/</d:href></c:calendar-home-set>'):davRow(yandexCollection,'<d:displayname>Синтетический</d:displayname><d:resourcetype><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>')),{status:207});}
    if(request.method==='REPORT')return new Response(davMulti([...yandexResources].map(([href,value])=>davRow(href,'<d:getetag>'+value.etag.replaceAll('"','&quot;')+'</d:getetag><c:calendar-data><![CDATA['+value.body+']]></c:calendar-data>')).join('')),{status:207});
    if(request.method==='GET'){const value=yandexResources.get(url.href);return value?new Response(value.body,{headers:{ETag:value.etag}}):new Response('Not found',{status:404});}
    if(request.method==='PUT'){const previous=yandexResources.get(url.href);assert.equal(request.headers.get(previous?'If-Match':'If-None-Match'),previous?.etag??'*');const value={body:await request.text(),etag:'"dav-'+ ++yandexVersion+'"'};yandexResources.set(url.href,value);yandexWrites.push(url.pathname);return new Response(null,{status:previous?204:201,headers:{ETag:value.etag}});}
    throw Error('Unexpected synthetic CalDAV method');
  }
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'synthetic-google-access',refresh_token:'synthetic-google-refresh',scope:GOOGLE_SCOPES.join(' '),expires_in:3600});
  if(url.hostname==='www.googleapis.com'){
    if(url.pathname.endsWith('/calendarList'))return Response.json({items:[{id:'synthetic-calendar',summary:'Рабочий',accessRole:'owner'}]});
    const id=decodeURIComponent(url.pathname.split('/').at(-1));
    if(request.method==='GET')return id==='events'?Response.json({items:[...googleEvents.values()]}):googleEvents.has(id)?Response.json(googleEvents.get(id)):Response.json({error:'not found'},{status:404});
    if(request.method==='DELETE'){assert.equal(request.headers.get('If-Match'),googleEvents.get(id).etag);googleEvents.set(id,{...googleEvents.get(id),status:'cancelled',etag:'"'+ ++googleVersion+'"'});googleWrites.push('delete');return new Response(null,{status:204});}
    const body=await request.json(),key=body.id??id;
    if(request.method==='PATCH')assert.equal(request.headers.get('If-Match'),googleEvents.get(key).etag);
    const value={...googleEvents.get(key),...body,id:key,etag:'"'+ ++googleVersion+'"'};googleEvents.set(key,value);googleWrites.push(request.method);return Response.json(value);
  }
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
  await request('/telegram/webhook',update(600,'/calendars',208),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>sent.some(message=>String(message.chat_id)==='208'&&message.text?.includes('Календари')));
  await request('/telegram/webhook',{update_id:601,callback_query:{id:'connect-google',from:{id:208},data:'k|connect|google',message:{message_id:6000,chat:{id:208,type:'private'},from:{id:999,is_bot:true}}}},{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(()=>sent.some(message=>String(message.chat_id)==='208'&&message.reply_markup?.inline_keyboard?.flat().some(button=>button.url?.includes('/calendars/connect'))));
  const connectMessage=sent.find(message=>String(message.chat_id)==='208'&&message.reply_markup?.inline_keyboard?.flat().some(button=>button.url?.includes('/calendars/connect'))),setupUrl=new URL(connectMessage.reply_markup.inline_keyboard.flat().find(button=>button.url).url),setupTicket=setupUrl.searchParams.get('ticket');
  const setupResponse=await request('/calendars/connect?ticket='+encodeURIComponent(setupTicket)),setupCookie=setupResponse.headers.get('Set-Cookie').split(';')[0];assert.equal(setupResponse.status,200);
  async function postCalendar(path,body,cookie=setupCookie){const response=await mf.dispatchFetch('https://bob.local'+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:APP_ORIGIN,Cookie:cookie},body:new URLSearchParams(body)});return new Response(await response.text(),{status:response.status,headers:response.headers});}
  const redirect=await postCalendar('/calendars/google/start',{ticket:setupTicket});assert.equal(redirect.status,303);const state=new URL(redirect.headers.get('Location')).searchParams.get('state'),choice=await request('/calendars/google/callback?code=synthetic-code&state='+encodeURIComponent(state),null,{Cookie:setupCookie});assert.equal(choice.status,200);const selection=/name="ticket" value="([^"]+)"/u.exec(await choice.text())[1];
  assert.equal((await postCalendar('/calendars/select',{ticket:selection,calendar:'0',consent:'yes',default:'yes'})).status,200);
  const calendarDb=await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:'owner:208:v1'});await until(async()=>Boolean((await calendarDb.exec('SELECT last_ok FROM calendar_connections'))[0]?.last_ok));
  assert.equal((await calendarDb.exec("SELECT * FROM items WHERE title='Из Google'")).length,1);assert.equal((await calendarDb.exec('SELECT credentials FROM calendar_connections'))[0].credentials.includes('synthetic-google-refresh'),false);
  await request('/telegram/webhook',update(602,'Завтра в 13:20 встреча из BOB на час',208),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>googleWrites.includes('POST'));
  const created=[...googleEvents.values()].find(event=>event.summary?.includes('встреча из BOB'));assert.ok(created);assert.equal((await calendarDb.exec('SELECT * FROM calendar_links')).length,2);
  googleEvents.set('remote-synthetic',{...googleEvents.get('remote-synthetic'),summary:'Из Google после правки',etag:'"external-change"'});await calendarDb.exec("UPDATE calendar_connections SET next_at='2000-01-01T00:00:00.000Z'");
  await request('/telegram/webhook',{update_id:603,callback_query:{id:'sync-google',from:{id:208},data:'k|sync|'+(await calendarDb.exec('SELECT id FROM calendar_connections'))[0].id,message:{message_id:6030,chat:{id:208,type:'private'},from:{id:999,is_bot:true}}}},{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(async()=>Boolean((await calendarDb.exec("SELECT * FROM items WHERE title='Из Google после правки'"))[0]));
  await request('/telegram/webhook',{update_id:610,callback_query:{id:'connect-yandex',from:{id:207},data:'k|connect|yandex',message:{message_id:6100,chat:{id:207,type:'private'},from:{id:999,is_bot:true}}}},{'X-Telegram-Bot-Api-Secret-Token':secret});
  await until(()=>sent.some(message=>String(message.chat_id)==='207'&&message.reply_markup?.inline_keyboard?.flat().some(button=>button.url?.includes('/calendars/connect'))));
  const yandexConnect=sent.find(message=>String(message.chat_id)==='207'&&message.reply_markup?.inline_keyboard?.flat().some(button=>button.url?.includes('/calendars/connect'))),yandexTicket=new URL(yandexConnect.reply_markup.inline_keyboard.flat().find(button=>button.url).url).searchParams.get('ticket'),yandexSetup=await request('/calendars/connect?ticket='+encodeURIComponent(yandexTicket)),yandexCookie=yandexSetup.headers.get('Set-Cookie').split(';')[0];
  const yandexChoice=await postCalendar('/calendars/yandex',{ticket:yandexTicket,login:'synthetic@yandex.ru',password:'synthetic-calendar-app-password'},yandexCookie);assert.equal(yandexChoice.status,200);const yandexSelection=/name="ticket" value="([^"]+)"/u.exec(await yandexChoice.text())[1];assert.equal((await postCalendar('/calendars/select',{ticket:yandexSelection,calendar:'0',consent:'yes',default:'yes'},yandexCookie)).status,200);
  const yandexDb=await mf.unsafeGetDurableObjectStorage('bob-cloud-test','BobObject',{name:'owner:207:v1'});await until(async()=>Boolean((await yandexDb.exec('SELECT last_ok FROM calendar_connections'))[0]?.last_ok));assert.equal((await yandexDb.exec("SELECT * FROM items WHERE title='Из Яндекса'")).length,1);
  await request('/telegram/webhook',update(611,'Завтра в 14:20 встреча для Яндекса на час',207),{'X-Telegram-Bot-Api-Secret-Token':secret});await until(()=>yandexWrites.length>0);assert.equal(yandexResources.size,2);assert.equal((await yandexDb.exec('SELECT credentials FROM calendar_connections'))[0].credentials.includes('synthetic-calendar-app-password'),false);
  await mf.dispose();mf=new Miniflare(configuration);assert.equal((await(await request('/admin/registry',null,{Authorization:`Bearer ${admin}`})).json()).members.length,10);assert.equal((await status()).items,2);
  console.log(JSON.stringify({localCloudRuntime:'passed',realSqliteDurableObject:true,ownerCheck:true,webhookAuthentication:true,durableJobAndOutbox:true,noDuplicate:true,calendarFileDownloaded:true,calendarAutoImported:true,calendarReuploadPreservedCount:true,callbackAcknowledgedAndEdited:true,bulkConfirmedAndUndone:true,deliveryRetryAndRestart:true,replyOrderPreserved:true,tenIsolatedUsers:true,sharedBudgetMetered:true,membersSurviveRestart:true,voiceDownloadedTranscribedAndSaved:true,voiceReplayWithoutSTT:true,googleOAuthCookieAndPKCE:true,twoWayCalendarSqlite:true,yandexCalDAVSqlite:true,calendarCredentialsEncrypted:true,latency,externalNetwork:'stubbed',aiCalls:calls.filter(host=>host==='api.cloudflare.com').length}));
}finally{await mf.dispose();}

