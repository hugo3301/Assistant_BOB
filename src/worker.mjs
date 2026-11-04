import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { CloudStore } from './cloud-store.mjs';
import { Assistant } from './assistant.mjs';
import { WorkersAI } from './ai.mjs';
import { Alpha } from './alpha.mjs';
import { ReminderWorker } from './reminders.mjs';
import { Telegram, isOwnerUpdate, splitMessage } from './telegram.mjs';
import { BobError } from './errors.mjs';
import {friendlyResponse} from './views.mjs';
const VERSION = '0.2.0-alpha';
function equalSecret(actual, expected) { if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length < 24) return false; const a = new TextEncoder().encode(actual), b = new TextEncoder().encode(expected); return a.length === b.length && timingSafeEqual(a,b); }
function object(env) { return env.BOB.get(env.BOB.idFromName(`owner:${env.TELEGRAM_OWNER_ID}:v1`)); }
export default {
  async fetch(request,env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({service:'BOB',version:VERSION,status:'ok'},{headers:{'Cache-Control':'no-store'}});
    if (path === '/admin/status' && request.method === 'GET' && equalSecret(request.headers.get('Authorization'), `Bearer ${env.ADMIN_SECRET}`)) return object(env).fetch('https://internal/status');
    if(path==='/admin/telegram'&&request.method==='POST'&&equalSecret(request.headers.get('Authorization'),`Bearer ${env.ADMIN_SECRET}`))return object(env).fetch(new Request('https://internal/configure',{method:'POST'}));
    if (path !== '/telegram/webhook' || request.method !== 'POST' || !equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET)) return new Response('Not found',{status:404});
    try {
      let raw = '', length = 0; const reader = request.body?.getReader(); if (!reader) return new Response('Invalid request',{status:400});
      const decoder = new TextDecoder();
      while (true) { const {value,done} = await reader.read(); if (done) break; length += value.byteLength; if (length > 250000) {await reader.cancel(); return new Response('Too large',{status:413});} raw += decoder.decode(value,{stream:true}); }
      raw += decoder.decode(); const update = JSON.parse(raw);
      if (!isOwnerUpdate(update,env.TELEGRAM_OWNER_ID)) return new Response('ok');
      return object(env).fetch(new Request('https://internal/enqueue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)}));
    } catch { return new Response('Temporarily unavailable',{status:503}); }
  },
  async scheduled(_controller,env,ctx) { ctx.waitUntil(object(env).fetch('https://internal/wake').then(response => {if (!response.ok) throw new Error('BOB scheduler failed');})); },
};
export class BobObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env); this.owner = String(env.TELEGRAM_OWNER_ID); this.store = new CloudStore(ctx.storage); this.env = env;
    this.store.ensureUser(this.owner,{timezone:'Asia/Tomsk',morningTime:'08:00',reminderMinutes:60});
    const now = new Date().toISOString();
    if (env.AI_BUDGET_SEED_DAY === now.slice(0,10)) this.store.db.prepare('INSERT OR IGNORE INTO budget(day,spent,reserved) VALUES (?,?,0)').run(now.slice(0,10),Number(env.AI_BUDGET_SEED_NEURONS) || 0);
    this.telegram = new Telegram(env.TELEGRAM_BOT_TOKEN);
    this.assistant = new Assistant(this.store,{provider:new WorkersAI(this.store,{accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.WORKERS_AI_TOKEN,dailyBudget:7500}),allowedOwners:[this.owner]});
    this.alpha = new Alpha(this.store,this.assistant); this.reminders = new ReminderWorker(this.store);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_jobs(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,lease_until TEXT,last_error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON telegram_jobs(status,next_at,id);
      CREATE TABLE IF NOT EXISTS telegram_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,sent_at TEXT,last_error TEXT);
      CREATE INDEX IF NOT EXISTS outbox_due ON telegram_outbox(status,next_at);
      CREATE TABLE IF NOT EXISTS runtime_health(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  health(key) { this.store.db.prepare('INSERT INTO runtime_health VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,new Date().toISOString()); }
  async fetch(request) {
    const path = new URL(request.url).pathname, now = new Date().toISOString();
    if (path === '/status') return Response.json({version:VERSION,settings:{timezone:this.store.user(this.owner).timezone,morningTime:this.store.user(this.owner).morning_time,reminderMinutes:this.store.user(this.owner).reminder_minutes},usage:this.store.usage(now.slice(0,10)),health:this.store.db.prepare('SELECT * FROM runtime_health').all(),jobs:this.store.db.prepare('SELECT status,COUNT(*) AS count FROM telegram_jobs GROUP BY status').all(),outbox:this.store.db.prepare('SELECT status,COUNT(*) AS count FROM telegram_outbox GROUP BY status').all(),reminders:this.store.db.prepare('SELECT status,COUNT(*) AS count FROM reminders GROUP BY status').all(),items:this.store.items(this.owner).length});
    if (path === '/enqueue' && request.method === 'POST') {
      const update = await request.json(); if (!isOwnerUpdate(update,this.owner)) return new Response('ok');
      this.store.db.prepare('INSERT OR IGNORE INTO telegram_jobs(id,payload,next_at) VALUES (?,?,?)').run(update.update_id,JSON.stringify(update),now);
      await this.wake(); return new Response('ok');
    }
    if(path==='/configure'&&request.method==='POST'){
      await this.telegram.call('setWebhook',{url:'https://assistant-bob-alpha.assistant-bob.workers.dev/telegram/webhook',secret_token:this.env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false});
      return Response.json({callbackUpdatesEnabled:true});
    }
    if (path === '/wake') {
      this.health('last_cron');
      await this.reminders.tick(message => this.sendReminder(message));
      await this.wake(); return new Response('ok');
    }
    return new Response('Not found',{status:404});
  }
  async wake() { const alarm = await this.ctx.storage.getAlarm(); if (alarm === null || alarm > Date.now()+2000) await this.ctx.storage.setAlarm(Date.now()+1000); }
  async sendReminder(message) {
    if (message.owner !== this.owner) throw new Error('Owner mismatch');
    const chunks = splitMessage(message.text); for (const chunk of chunks) await this.telegram.send(this.owner,chunk);
  }
  async processJob() {
    const now = new Date().toISOString();
    const job = this.store.transaction(() => {
      const next = this.store.db.prepare("SELECT * FROM telegram_jobs WHERE (status='pending' AND next_at<=?) OR (status='processing' AND lease_until<=?) ORDER BY id LIMIT 1").get(now,now);
      if (!next) return null;
      this.store.db.prepare("UPDATE telegram_jobs SET status='processing',attempts=attempts+1,lease_until=? WHERE id=?").run(new Date(Date.now()+210000).toISOString(),next.id); return {...next,attempts:next.attempts+1};
    });
    if (!job) return;
    try {
      const update = JSON.parse(job.payload), callback=update.callback_query,message = callback?.message??update.message; let response;
      if(callback){try{await this.telegram.answer(callback.id);}catch{} response=await this.alpha.handle(this.owner,'',{requestId:`tg:${job.id}`,callback});}
      else if (message.document) {
        if ((!/\.ics$/i.test(message.document.file_name ?? '')&&!['text/calendar','application/ics','application/icalendar'].includes(message.document.mime_type)) || message.document.file_size > 1000000) response = {text:'Пришли расписание файлом .ics до 1 МБ. Другие вложения в альфе пока не обрабатываю.'};
        else {
          const documentText = await this.telegram.calendar(message.document.file_id);
          response = await this.alpha.handle(this.owner,`Файл расписания ${message.document.file_unique_id}`,{requestId:`tg:${job.id}`,documentText,caption:message.caption??''});
        }
      } else if (typeof message.text === 'string' && message.text.length <= 8000) response = await this.alpha.handle(this.owner,message.text,{requestId:`tg:${job.id}`});
      else response = {text:'Пока понимаю текст и расписание .ics. Напиши /help.'};
      response=friendlyResponse(response);
      const chunks=splitMessage(response.text),payloads = chunks.map((text,index) => ({text,...(index===chunks.length-1&&response.replyMarkup?{replyMarkup:response.replyMarkup}:{}),...(callback&&response.edit&&chunks.length===1?{editMessageId:message.message_id}:{})})); if (response.file) payloads.push({file:response.file});
      this.store.transaction(() => {
        for (const [index,payload] of payloads.entries()) this.store.db.prepare('INSERT OR IGNORE INTO telegram_outbox(id,payload,next_at) VALUES (?,?,?)').run(`reply:${job.id}:${index}`,JSON.stringify(payload),new Date().toISOString());
        this.store.db.prepare("UPDATE telegram_jobs SET status='done',payload='{}',lease_until=NULL,last_error=NULL WHERE id=?").run(job.id);
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
    }
  }
  async flushOutbox() {
    // Only the alarm sends reply outbox entries; cron only sends independently leased reminders.
    const rows = this.store.db.prepare("SELECT * FROM telegram_outbox WHERE status='pending' AND next_at<=? ORDER BY rowid LIMIT 12").all(new Date().toISOString());
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        if (payload.file) await this.telegram.document(this.owner,payload.file); else if(payload.editMessageId)await this.telegram.edit(this.owner,payload.editMessageId,payload.text,payload.replyMarkup);else await this.telegram.send(this.owner,payload.text,payload.replyMarkup);
        this.store.db.prepare("UPDATE telegram_outbox SET status='sent',payload='{}',sent_at=?,attempts=attempts+1,last_error=NULL WHERE id=?").run(new Date().toISOString(),row.id);
      } catch (error) {
        const attempts = row.attempts+1, delay = Math.max(5000*2**Math.min(attempts,6),(error.retryAfter ?? 0)*1000);
        this.store.db.prepare('UPDATE telegram_outbox SET status=?,attempts=?,next_at=?,last_error=? WHERE id=?').run(attempts >= 8 ? 'failed' : 'pending',attempts,new Date(Date.now()+delay).toISOString(),'DELIVERY_FAILED',row.id);
        break;
      }
    }
  }
  async alarm() {
    const now = new Date().toISOString();
    try {
      this.health('last_alarm');
      this.store.transaction(() => {
        let changed = this.alpha.expandSeries(this.owner,now);
        for (const item of this.store.items(this.owner).filter(item => item.kind !== 'task' && item.at && Date.parse(item.at)+(item.duration ?? 1440)*60000 < Date.parse(now))) { this.store.changeItem(this.owner,item.id,{status:'elapsed'},now); changed++; }
        if (changed) this.store.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(this.owner);
      });
      await this.reminders.tick(message => this.sendReminder(message));
      await this.processJob();
      await this.flushOutbox();
      // Keep delivery receipts for replay prevention; remove only stale sensitive payloads already acknowledged.
    } finally { await this.ctx.storage.setAlarm(Date.now()+this.nextDelay()); }
  }
  nextDelay() {
    const now = Date.now(); let earliest = now+60000;
    for (const sql of ["SELECT MIN(CASE WHEN status='processing' THEN lease_until ELSE next_at END) AS at FROM telegram_jobs WHERE status IN ('pending','processing')", "SELECT MIN(next_at) AS at FROM telegram_outbox WHERE status='pending'", "SELECT MIN(CASE WHEN status='claimed' THEN lease_until ELSE COALESCE(next_retry,fire_at) END) AS at FROM reminders WHERE status IN ('pending','claimed')"]) {
      const at = this.store.db.prepare(sql).get()?.at; if (at) earliest = Math.min(earliest,Date.parse(at));
    }
    return Math.max(1000,earliest-now);
  }
}
