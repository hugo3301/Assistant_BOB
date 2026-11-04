import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { CloudStore } from './cloud-store.mjs';
import { Assistant } from './assistant.mjs';
import { WorkersAI } from './ai.mjs';
import { Alpha } from './alpha.mjs';
import { ReminderWorker } from './reminders.mjs';
import { Telegram, isOwnerUpdate, splitMessage,privateUpdateOwner } from './telegram.mjs';
import { BobError,requireThat } from './errors.mjs';
import {friendlyResponse} from './views.mjs';
import {callUser,callControl,SharedBudget} from './routing.mjs';
import {dayAt,addDays,localToUtc} from './dates.mjs';
import {SpeechAI,VoiceFlow} from './voice.mjs';
export {ControlObject} from './control-worker.mjs';
const VERSION = '0.2.0-alpha';
function equalSecret(actual, expected) { if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length < 24) return false; const a = new TextEncoder().encode(actual), b = new TextEncoder().encode(expected); return a.length === b.length && timingSafeEqual(a,b); }
function object(env) {return{fetch:(url,init)=>callUser(env,String(env.TELEGRAM_OWNER_ID),new URL(typeof url==='string'?url:url.url).pathname,init??(typeof url==='string'?{}:{method:url.method}))};}
export default {
  async fetch(request,env,ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({service:'BOB',version:VERSION,status:'ok'},{headers:{'Cache-Control':'no-store'}});
    if (path === '/admin/status' && request.method === 'GET' && equalSecret(request.headers.get('Authorization'), `Bearer ${env.ADMIN_SECRET}`)) return object(env).fetch('https://internal/status');
    if(path==='/admin/telegram'&&request.method==='POST'&&equalSecret(request.headers.get('Authorization'),`Bearer ${env.ADMIN_SECRET}`))return object(env).fetch(new Request('https://internal/configure',{method:'POST'}));
    if(path==='/admin/registry'&&request.method==='GET'&&equalSecret(request.headers.get('Authorization'),`Bearer ${env.ADMIN_SECRET}`))return Response.json(await callControl(env,'/overview',{owner:String(env.TELEGRAM_OWNER_ID)}));
    if(path==='/admin/bootstrap'&&request.method==='POST'&&equalSecret(request.headers.get('Authorization'),`Bearer ${env.ADMIN_SECRET}`)){const status=await(await object(env).fetch('https://internal/status')).json();await callControl(env,'/seed',{day:status.usage.day,spent:status.usage.spent});return Response.json({initialized:true,globalBudget:(await callControl(env,'/overview',{owner:String(env.TELEGRAM_OWNER_ID)})).usage});}
    if (path !== '/telegram/webhook' || request.method !== 'POST' || !equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET)) return new Response('Not found',{status:404});
    try {
      let raw = '', length = 0; const reader = request.body?.getReader(); if (!reader) return new Response('Invalid request',{status:400});
      const decoder = new TextDecoder();
      while (true) { const {value,done} = await reader.read(); if (done) break; length += value.byteLength; if (length > 250000) {await reader.cancel(); return new Response('Too large',{status:413});} raw += decoder.decode(value,{stream:true}); }
      raw += decoder.decode(); const update = JSON.parse(raw);
      const owner=privateUpdateOwner(update);if(!owner)return new Response('ok');
      const message=update.message,start=/^\/start(?:@[\w]+)?(?:\s+([\s\S]*))?$/u.exec(message?.text??''),code=start?.[1]?.startsWith('join_')?start[1].slice(5):null;
      const access=await callControl(env,'/access',{owner,start:Boolean(start),code,label:message?.from?.first_name??'Участник'});
      if(!access.allowed){const telegram=new Telegram(env.TELEGRAM_BOT_TOKEN);if(update.callback_query)ctx.waitUntil(telegram.answer(update.callback_query.id).catch(()=>{}));if((await callControl(env,'/notice',{owner})).send)ctx.waitUntil(telegram.send(owner,access.reason==='full'?'В альфе пока заняты все 10 мест. Попроси владельца сообщить, когда появится место.':access.reason==='revoked'?'Доступ к альфе отключён владельцем. Твои данные сохранены.':'BOB сейчас работает по приглашениям. Открой личную ссылку-приглашение от владельца и нажми «Начать».').catch(()=>{}));return new Response('ok');}
      if(start)message.text='/start';
      return callUser(env,owner,'/enqueue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)});
    } catch { return new Response('Temporarily unavailable',{status:503}); }
  },
  async scheduled(_controller,env,ctx) {ctx.waitUntil(callControl(env,'/wake'));},
};
export class BobObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env); this.owner = null; this.store = new CloudStore(ctx.storage); this.env = env;this.runner=null;
    this.telegram = new Telegram(env.TELEGRAM_BOT_TOKEN);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_jobs(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,lease_until TEXT,last_error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON telegram_jobs(status,next_at,id);
      CREATE TABLE IF NOT EXISTS telegram_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,sent_at TEXT,last_error TEXT);
      CREATE INDEX IF NOT EXISTS outbox_due ON telegram_outbox(status,next_at);
      CREATE TABLE IF NOT EXISTS job_metrics(id INTEGER PRIMARY KEY,queued_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,reply_sent_at TEXT,model_calls INTEGER NOT NULL DEFAULT 0,outcome TEXT);
      CREATE TABLE IF NOT EXISTS service_receipts(id TEXT PRIMARY KEY,response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_health(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const users=this.store.db.prepare('SELECT id FROM users').all();requireThat(users.length<=1,'TENANT_STATE','Хранилище не изолировано.');if(users[0])this.initialize(users[0].id);
  }
  initialize(owner){requireThat(/^[1-9]\d{0,19}$/u.test(owner??'')&&this.ctx.id.toString()===this.env.BOB.idFromName(`owner:${owner}:v1`).toString()&&(!this.owner||this.owner===owner),'TENANT_OWNER','Нет доступа к этому хранилищу.');if(this.owner)return;this.owner=owner;
    this.store.ensureUser(owner,{timezone:'Asia/Tomsk',morningTime:'08:00',reminderMinutes:60});
    const now=new Date().toISOString();if(owner===String(this.env.TELEGRAM_OWNER_ID)&&this.env.AI_BUDGET_SEED_DAY===now.slice(0,10))this.store.db.prepare('INSERT OR IGNORE INTO budget(day,spent,reserved) VALUES (?,?,0)').run(now.slice(0,10),Number(this.env.AI_BUDGET_SEED_NEURONS)||0);
    this.budget=new SharedBudget(this.env,owner);this.assistant=new Assistant(this.store,{provider:new WorkersAI(this.store,{accountId:this.env.CLOUDFLARE_ACCOUNT_ID,token:this.env.WORKERS_AI_TOKEN,budget:this.budget}),allowedOwners:[owner]});this.alpha=new Alpha(this.store,this.assistant,{admin:owner===String(this.env.TELEGRAM_OWNER_ID)});this.voice=new VoiceFlow(this.store,owner,{telegram:this.telegram,speech:new SpeechAI({accountId:this.env.CLOUDFLARE_ACCOUNT_ID,token:this.env.WORKERS_AI_TOKEN,budget:this.budget})});this.reminders=new ReminderWorker(this.store);this.paused=this.store.db.prepare("SELECT value FROM runtime_health WHERE key='paused'").get()?.value==='1';
  }
  health(key) { this.store.db.prepare('INSERT INTO runtime_health VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,new Date().toISOString()); }
  async fetch(request) {
    this.initialize(request.headers.get('x-bob-user'));
    const path = new URL(request.url).pathname, now = new Date().toISOString();
    if (path === '/status') return Response.json({version:VERSION,latency:this.latency(),settings:{timezone:this.store.user(this.owner).timezone,morningTime:this.store.user(this.owner).morning_time,reminderMinutes:this.store.user(this.owner).reminder_minutes},usage:this.store.usage(now.slice(0,10)),health:this.store.db.prepare('SELECT * FROM runtime_health').all(),jobs:this.store.db.prepare('SELECT status,COUNT(*) AS count FROM telegram_jobs GROUP BY status').all(),outbox:this.store.db.prepare('SELECT status,COUNT(*) AS count FROM telegram_outbox GROUP BY status').all(),reminders:this.store.db.prepare('SELECT status,COUNT(*) AS count FROM reminders GROUP BY status').all(),items:this.store.items(this.owner).length});
    if (path === '/enqueue' && request.method === 'POST') {
      if(this.paused)return new Response('ok');
      const update = await request.json(); if (!isOwnerUpdate(update,this.owner)) return new Response('ok');
      this.store.db.prepare('INSERT OR IGNORE INTO telegram_jobs(id,payload,next_at) VALUES (?,?,?)').run(update.update_id,JSON.stringify(update),now);
      this.store.db.prepare('INSERT OR IGNORE INTO job_metrics(id,queued_at) VALUES (?,?)').run(update.update_id,now);
      if(update.callback_query)this.ctx.waitUntil(this.telegram.answer(update.callback_query.id).catch(()=>{}));
      await this.wake();this.ctx.waitUntil(this.drain());return new Response('ok');
    }
    if(path==='/pause'&&request.method==='POST'){this.paused=true;this.store.db.prepare("INSERT OR REPLACE INTO runtime_health VALUES ('paused','1')").run();await this.ctx.storage.deleteAlarm();return Response.json({paused:true});}
    if(path==='/configure'&&request.method==='POST'){
      await this.telegram.call('setWebhook',{url:'https://assistant-bob-alpha.assistant-bob.workers.dev/telegram/webhook',secret_token:this.env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false});
      return Response.json({callbackUpdatesEnabled:true});
    }
    if (path === '/wake') {
      if(this.paused)return new Response('ok');
      this.health('last_cron');
      await this.wake();this.ctx.waitUntil(this.drain(true));return new Response('ok');
    }
    return new Response('Not found',{status:404});
  }
  async wake() { const alarm = await this.ctx.storage.getAlarm(); if (alarm === null || alarm > Date.now()+2000) await this.ctx.storage.setAlarm(Date.now()+1000); }
  async sendReminder(message) {
    if(this.paused)return;
    if (message.owner !== this.owner) throw new Error('Owner mismatch');
    const chunks = splitMessage(message.text); for (const chunk of chunks) await this.telegram.send(this.owner,chunk);
  }
  async serviceMessage(text,callback,requestId){
    const command=callback?.data?.startsWith('a|')?callback.data.slice(2):/^\/(invite|members|quota|status)(?:\s+.*)?$/u.exec(text)?.[1]??({'Пригласить друга':'invite','Ресурс ИИ':'quota'}[text]);
    if(!command)return null;
    const cached=this.store.db.prepare('SELECT response FROM service_receipts WHERE id=?').get(requestId);if(cached)return JSON.parse(cached.response);
    let response;const admin=this.owner===String(this.env.TELEGRAM_OWNER_ID);
    try{
      if(command==='home')return this.alpha.handle(this.owner,'/start',{requestId,requestText:callback?`callback:${callback.id}:${callback.data}`:text});
      if(command==='invite'){requireThat(admin,'ADMIN_ONLY','Приглашать друзей может владелец бота.');const invite=await callControl(this.env,'/invite',{owner:this.owner,requestId});response={text:`Приглашение для друга\n\nОтправь эту личную ссылку одному человеку. Она действует 7 дней и открывается только один раз.\n\n${invite.url}`,replyMarkup:{inline_keyboard:[[{text:'Участники',callback_data:'a|members'},{text:'В меню',callback_data:'a|home'}]]}};}
      else if(command==='members'){requireThat(admin,'ADMIN_ONLY','Список участников доступен владельцу.');const group=await callControl(this.env,'/overview',{owner:this.owner});response={text:`Участники альфы · ${group.members.filter(member=>member.active).length} из ${group.capacity}\n\n`+group.members.filter(member=>member.active).map(member=>`• ${member.label}`).join('\n')+'\n\nУ каждого отдельные дела и настройки.',replyMarkup:{inline_keyboard:[[{text:'Пригласить друга',callback_data:'a|invite'},{text:'В меню',callback_data:'a|home'}]]}};}
      else if(command==='quota'||command==='status'){const usage=await this.budget.usage(),percent=Math.max(0,Math.floor((usage.limit-usage.spent-usage.reserved)/usage.limit*100));response={text:`Ресурс ИИ на сегодня\n\nОсталось ${percent}% личного лимита.\n\nОн нужен для сложных фраз и распознавания голоса. Меню, простые текстовые действия и сохранённые напоминания работают без ИИ.\nЛимит обновляется раз в сутки.`,replyMarkup:{inline_keyboard:[[{text:'В меню',callback_data:'a|home'}]]}};}
      else response={text:'Эта кнопка устарела. Открой /start.'};
    }catch(error){if(!(error instanceof BobError))throw error;response={status:'error',code:error.code,text:error.message};}
    response={status:'ok',changed:0,modelCalls:0,...response};this.store.db.prepare('INSERT OR IGNORE INTO service_receipts VALUES (?,?)').run(requestId,JSON.stringify(response));return response;
  }
  async processJob() {
    const now = new Date().toISOString();
    const job = this.store.transaction(() => {
      const next = this.store.db.prepare("SELECT * FROM telegram_jobs WHERE status IN ('pending','processing') ORDER BY id LIMIT 1").get();
      if (!next || (next.status==='processing'?next.lease_until:next.next_at)>now) return null;
      this.store.db.prepare("UPDATE telegram_jobs SET status='processing',attempts=attempts+1,lease_until=? WHERE id=?").run(new Date(Date.now()+210000).toISOString(),next.id); return {...next,attempts:next.attempts+1};
    });
    if (!job) return false;
    this.store.db.prepare('UPDATE job_metrics SET started_at=? WHERE id=?').run(new Date().toISOString(),job.id);
    const typing=setTimeout(()=>this.ctx.waitUntil(this.telegram.typing(this.owner).catch(()=>{})),700);
    try {
      const update = JSON.parse(job.payload), callback=update.callback_query,message = callback?.message??update.message; let response;
      const service=await this.serviceMessage(message.text??'',callback,`tg:${job.id}`);
      if(service)response=service;
      else if(callback){response=await this.alpha.handle(this.owner,'',{requestId:`tg:${job.id}`,callback});}
      else if(message.voice)response=await this.voice.handle(message.voice,`tg:${job.id}`,text=>this.alpha.handle(this.owner,text,{requestId:`tg:${job.id}`}));
      else if (message.document) {
        if ((!/\.ics$/i.test(message.document.file_name ?? '')&&!['text/calendar','application/ics','application/icalendar'].includes(message.document.mime_type)) || message.document.file_size > 1000000) response = {text:'Пришли расписание файлом .ics до 1 МБ. Другие вложения в альфе пока не обрабатываю.'};
        else {
          const documentText = await this.telegram.calendar(message.document.file_id);
          response = await this.alpha.handle(this.owner,`Файл расписания ${message.document.file_unique_id}`,{requestId:`tg:${job.id}`,documentText,caption:message.caption??''});
        }
      } else if (typeof message.text === 'string' && message.text.length <= 8000) response = await this.alpha.handle(this.owner,message.text,{requestId:`tg:${job.id}`});
      else response = {text:'Пришли текст, голосовое до 2 минут или расписание .ics. Открыть меню: /start.'};
      response=friendlyResponse(response);
      const chunks=splitMessage(response.text),payloads = chunks.map((text,index) => ({text,...(index===chunks.length-1&&response.replyMarkup?{replyMarkup:response.replyMarkup}:{}),...(callback&&response.edit&&chunks.length===1?{editMessageId:message.message_id}:{})})); if (response.file) payloads.push({file:response.file});
      this.store.transaction(() => {
        for (const [index,payload] of payloads.entries()) this.store.db.prepare('INSERT OR IGNORE INTO telegram_outbox(id,payload,next_at) VALUES (?,?,?)').run(`reply:${job.id}:${index}`,JSON.stringify(payload),new Date().toISOString());
        this.store.db.prepare("UPDATE telegram_jobs SET status='done',payload='{}',lease_until=NULL,last_error=NULL WHERE id=?").run(job.id);
        this.store.db.prepare('UPDATE job_metrics SET finished_at=?,model_calls=?,outcome=? WHERE id=?').run(new Date().toISOString(),response.modelCalls??0,response.code??response.status??'ok',job.id);
      });
      this.health('last_job');
    } catch (error) {
      const known = error instanceof BobError && !['TURN_BUSY','LEASE_LOST','STALE_CONTEXT'].includes(error.code);
      if (known || job.attempts >= 3) {
        this.store.transaction(() => {
          const text = known ? error.message : 'Не удалось завершить обработку. Проверь /tasks, прежде чем повторять действие. Данные могли сохраниться перед сбоем.';
          this.store.db.prepare('INSERT OR IGNORE INTO telegram_outbox(id,payload,next_at) VALUES (?,?,?)').run(`error:${job.id}`,JSON.stringify({text}),new Date().toISOString());
          this.store.db.prepare("UPDATE telegram_jobs SET status='failed',payload='{}',last_error=? WHERE id=?").run(known ? error.code : 'JOB_FAILED',job.id);
        });
      } else this.store.db.prepare("UPDATE telegram_jobs SET status='pending',next_at=?,lease_until=NULL,last_error='JOB_RETRY' WHERE id=?").run(new Date(Date.now()+185000).toISOString(),job.id);
    }finally{clearTimeout(typing);}
    return true;
  }
  async flushOutbox() {
    if(this.paused)return;
    // A single runner owns jobs/outbox; cron reminders use independent persisted leases.
    const rows = this.store.db.prepare("SELECT * FROM telegram_outbox WHERE status='pending' ORDER BY rowid LIMIT 12").all();
    for (const row of rows) {
      if(row.next_at>new Date().toISOString())break;
      try {
        const payload = JSON.parse(row.payload);
        if (payload.file) await this.telegram.document(this.owner,payload.file); else if(payload.editMessageId)await this.telegram.edit(this.owner,payload.editMessageId,payload.text,payload.replyMarkup);else await this.telegram.send(this.owner,payload.text,payload.replyMarkup);
        this.store.db.prepare("UPDATE telegram_outbox SET status='sent',payload='{}',sent_at=?,attempts=attempts+1,last_error=NULL WHERE id=?").run(new Date().toISOString(),row.id);
        const job=/^reply:(\d+):/u.exec(row.id);if(job)this.store.db.prepare('UPDATE job_metrics SET reply_sent_at=COALESCE(reply_sent_at,?) WHERE id=?').run(new Date().toISOString(),Number(job[1]));
      } catch (error) {
        const attempts = row.attempts+1, delay = Math.max(5000*2**Math.min(attempts,6),(error.retryAfter ?? 0)*1000);
        this.store.db.prepare('UPDATE telegram_outbox SET status=?,attempts=?,next_at=?,last_error=? WHERE id=?').run(attempts >= 8 ? 'failed' : 'pending',attempts,new Date(Date.now()+delay).toISOString(),'DELIVERY_FAILED',row.id);
        break;
      }
    }
  }
  async alarm() {
    if(!this.owner||this.paused)return;
    await this.drain(true);
  }
  drain(maintenance=false){
    if(this.paused)return Promise.resolve();
    this.maintenanceRequested=maintenance||this.maintenanceRequested;
    if(this.runner)return this.runner;
    this.runner=(async()=>{const started=Date.now();try{
      await this.flushOutbox();
      for(let i=0;i<8&&Date.now()-started<25000;i++){const processed=await this.processJob();await this.flushOutbox();if(!processed)break;}
      if(this.maintenanceRequested){this.maintenanceRequested=false;const now=new Date().toISOString();
      this.health('last_alarm');
      this.store.transaction(() => {
        let changed = this.alpha.expandSeries(this.owner,now);
        for (const item of this.store.items(this.owner).filter(item => item.kind !== 'task' && item.at && Date.parse(item.at)+(item.duration ?? 1440)*60000 < Date.parse(now))) { this.store.changeItem(this.owner,item.id,{status:'elapsed'},now); changed++; }
        if (changed) this.store.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(this.owner);
      });
      await this.reminders.tick(message => this.sendReminder(message));
      }
      this.store.db.prepare('DELETE FROM job_metrics WHERE id NOT IN (SELECT id FROM job_metrics ORDER BY id DESC LIMIT 256)').run();
      // Keep delivery receipts for replay prevention; remove only stale sensitive payloads already acknowledged.
    }finally{if(!this.paused){const at=Date.now()+this.nextDelay();await this.ctx.storage.setAlarm(at);await callControl(this.env,'/schedule',{owner:this.owner,at:new Date(at).toISOString()});}}})().finally(()=>{this.runner=null;const next=this.store.db.prepare("SELECT status,next_at,lease_until FROM telegram_jobs WHERE status IN ('pending','processing') ORDER BY id LIMIT 1").get();if(!this.paused&&next&&(next.status==='processing'?next.lease_until:next.next_at)<=new Date().toISOString())this.ctx.waitUntil(this.drain());});
    return this.runner;
  }
  latency(){
    const rows=this.store.db.prepare('SELECT * FROM job_metrics WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 100').all();
    const summary=values=>{values.sort((a,b)=>a-b);return values.length?{p50:values[Math.floor((values.length-1)*0.5)],p95:values[Math.ceil((values.length-1)*0.95)]}:null;};
    return{samples:rows.length,withoutAI:rows.filter(row=>row.model_calls===0).length,queueMs:summary(rows.filter(row=>row.started_at).map(row=>Math.max(0,Date.parse(row.started_at)-Date.parse(row.queued_at)))),processingMs:summary(rows.map(row=>Math.max(0,Date.parse(row.finished_at)-Date.parse(row.started_at)))),replyMs:summary(rows.filter(row=>row.reply_sent_at).map(row=>Math.max(0,Date.parse(row.reply_sent_at)-Date.parse(row.queued_at))))};
  }
  nextDelay() {
    const now = Date.now(); let earliest = now+3600000;
    const user=this.store.user(this.owner);if(user.morning_time){try{const today=dayAt(new Date(now).toISOString(),user.timezone);let at=localToUtc(today,user.morning_time,user.timezone);if(Date.parse(at)<=now)at=localToUtc(addDays(today,1),user.morning_time,user.timezone);earliest=Math.min(earliest,Date.parse(at));}catch{}}
    for (const sql of ["SELECT CASE WHEN status='processing' THEN lease_until ELSE next_at END AS at FROM telegram_jobs WHERE status IN ('pending','processing') ORDER BY id LIMIT 1", "SELECT next_at AS at FROM telegram_outbox WHERE status='pending' ORDER BY rowid LIMIT 1", "SELECT MIN(CASE WHEN status='claimed' THEN lease_until ELSE COALESCE(next_retry,fire_at) END) AS at FROM reminders WHERE status IN ('pending','claimed')"]) {
      const at = this.store.db.prepare(sql).get()?.at; if (at) earliest = Math.min(earliest,Date.parse(at));
    }
    return Math.max(1000,earliest-now);
  }
}
