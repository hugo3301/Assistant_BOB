import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {requireThat} from './errors.mjs';

export const FREE_POLICY=Object.freeze({users:10,total:9000,person:800,voiceSeconds:120,voiceBytes:2000000});
const hash=code=>createHash('sha256').update(code).digest('hex');
export class ControlStore{
 constructor(db,{admin,clock=()=>new Date().toISOString(),mode='invite',total=FREE_POLICY.total,person=FREE_POLICY.person,maxUsers=FREE_POLICY.users}={}){
  this.db=db;this.admin=admin;this.clock=clock;this.mode=mode;this.total=total;this.person=person;this.maxUsers=maxUsers;
  db.exec(`CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,label TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,joined_at TEXT NOT NULL,next_wake TEXT);
   CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY,label TEXT NOT NULL,expires_at TEXT NOT NULL,used_by TEXT,code TEXT NOT NULL,request_id TEXT UNIQUE);
   CREATE TABLE IF NOT EXISTS shared_days(day TEXT PRIMARY KEY,external REAL NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS member_usage(day TEXT NOT NULL,member TEXT NOT NULL,spent REAL NOT NULL DEFAULT 0,reserved REAL NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,voice_seconds REAL NOT NULL DEFAULT 0,PRIMARY KEY(day,member));
   CREATE TABLE IF NOT EXISTS shared_reservations(id TEXT PRIMARY KEY,member TEXT NOT NULL,day TEXT NOT NULL,amount REAL NOT NULL,kind TEXT NOT NULL,seconds REAL NOT NULL,created_at TEXT NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS access_notice(member TEXT PRIMARY KEY,sent_at TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO members(id,label,joined_at) VALUES (?,?,?)').run(admin,'Владелец',clock());
 }
 transaction(fn){return this.db.transaction(fn);}
 member(id){return this.db.prepare('SELECT * FROM members WHERE id=?').get(id);}
 active(id){return this.member(id)?.active===1;}
 access(id,{code=null,label='Участник',start=false}={}){
  requireThat(/^[1-9]\d{0,19}$/u.test(id),'ACCESS','Нужен личный аккаунт Telegram.');
  return this.transaction(()=>{
   if(this.active(id))return{allowed:true};
   if(this.member(id))return{allowed:false,reason:'revoked'};
   if(!start)return{allowed:false,reason:'invite'};
   const invite=code?this.db.prepare('SELECT * FROM invitations WHERE hash=?').get(hash(code)):null;
   if(this.mode!=='open'&&(!invite||invite.expires_at<=this.clock()||invite.used_by&&invite.used_by!==id))return{allowed:false,reason:'invite'};
   if(this.db.prepare('SELECT COUNT(*) AS count FROM members WHERE active=1').get().count>=this.maxUsers)return{allowed:false,reason:'full'};
   this.db.prepare('INSERT INTO members(id,label,joined_at) VALUES (?,?,?)').run(id,String(label).replace(/[\r\n\u0000-\u001f]/gu,' ').slice(0,80)||'Участник',this.clock());
   if(invite)this.db.prepare('UPDATE invitations SET used_by=? WHERE hash=?').run(id,invite.hash);
   return{allowed:true,joined:true};
  });
 }
 invite(caller,label='Друг',requestId=null){
  requireThat(caller===this.admin,'ADMIN_ONLY','Приглашать может владелец бота.');
  return this.transaction(()=>{const previous=requestId?this.db.prepare('SELECT code,expires_at FROM invitations WHERE request_id=?').get(requestId):null;if(previous)return{url:`https://t.me/mybob_robot?start=join_${previous.code}`,expires:previous.expires_at};const active=this.db.prepare('SELECT COUNT(*) AS count FROM members WHERE active=1').get().count,pending=this.db.prepare('SELECT COUNT(*) AS count FROM invitations WHERE used_by IS NULL AND expires_at>?').get(this.clock()).count;
   requireThat(active+pending<this.maxUsers,'MEMBERS_FULL','Все места уже заняты или зарезервированы приглашениями. В альфе доступно 10 мест вместе с владельцем.');
   const code=randomBytes(18).toString('base64url'),expires=new Date(Date.parse(this.clock())+7*86400000).toISOString();
   this.db.prepare('INSERT INTO invitations VALUES (?,?,?,NULL,?,?)').run(hash(code),String(label).slice(0,80),expires,code,requestId);return{url:`https://t.me/mybob_robot?start=join_${code}`,expires};});
 }
 revoke(caller,id){requireThat(caller===this.admin&&id!==this.admin,'ADMIN_ONLY','Можно отключить только приглашённого пользователя.');this.db.prepare('UPDATE members SET active=0,next_wake=NULL WHERE id=?').run(id);}
 notice(id){const row=this.db.prepare('SELECT sent_at FROM access_notice WHERE member=?').get(id);if(row&&Date.parse(this.clock())-Date.parse(row.sent_at)<21600000)return false;this.db.prepare('INSERT INTO access_notice VALUES (?,?) ON CONFLICT(member) DO UPDATE SET sent_at=excluded.sent_at').run(id,this.clock());this.db.prepare('DELETE FROM access_notice WHERE sent_at<?').run(new Date(Date.parse(this.clock())-86400000).toISOString());return true;}
 seed(day,spent){requireThat(/^\d{4}-\d{2}-\d{2}$/u.test(day)&&Number.isFinite(spent)&&spent>=0,'BUDGET','Неверное значение счётчика.');this.db.prepare('INSERT INTO shared_days VALUES (?,?) ON CONFLICT(day) DO UPDATE SET external=MAX(external,excluded.external)').run(day,spent);}
 reserve(member,amount,{kind='llm',seconds=0}={}){
  requireThat(this.active(member),'ACCESS','Доступ отключён.');requireThat(Number.isFinite(amount)&&amount>0&&amount<=this.total&&['llm','stt'].includes(kind)&&Number.isFinite(seconds)&&seconds>=0&&seconds<=120,'BUDGET','Неверный размер запроса.');
  return this.transaction(()=>{this.reap();const day=this.clock().slice(0,10),global=this.usage(),usage=this.usage(member);
   requireThat(global.spent+global.reserved+amount<=this.total,'AI_BUDGET_GLOBAL','На сегодня общий ресурс ИИ закончился. Обзоры, кнопки и напоминания продолжают работать. Новый день ИИ начинается в 07:00 по Томску.');
   requireThat(usage.spent+usage.reserved+amount<=this.person,'AI_BUDGET_USER','Твой ресурс ИИ на сегодня закончился. Кнопки, текстовые быстрые действия и напоминания работают. Голос можно заменить текстом.');
   const id=randomUUID();this.db.prepare('INSERT OR IGNORE INTO member_usage(day,member) VALUES (?,?)').run(day,member);this.db.prepare('UPDATE member_usage SET reserved=reserved+? WHERE day=? AND member=?').run(amount,day,member);
   this.db.prepare('INSERT INTO shared_reservations VALUES (?,?,?,?,?,?,?,0)').run(id,member,day,amount,kind,seconds,this.clock());return id;});
 }
 settle(member,id,observed=null){return this.transaction(()=>this.settleSync(member,id,observed));}
 settleSync(member,id,observed){const row=this.db.prepare('SELECT * FROM shared_reservations WHERE id=? AND member=?').get(id,member);if(!row||row.settled)return;const spent=Number.isFinite(observed)&&observed>=0?observed:row.amount;this.db.prepare('UPDATE member_usage SET reserved=MAX(0,reserved-?),spent=spent+?,calls=calls+?,voice_seconds=voice_seconds+? WHERE day=? AND member=?').run(row.amount,spent,row.kind==='llm'?1:0,row.seconds,row.day,member);this.db.prepare('UPDATE shared_reservations SET settled=1 WHERE id=?').run(id);}
 reap(){for(const row of this.db.prepare('SELECT * FROM shared_reservations WHERE settled=0 AND created_at<?').all(new Date(Date.parse(this.clock())-180000).toISOString()))this.settleSync(row.member,row.id,null);this.db.prepare('DELETE FROM shared_reservations WHERE settled=1 AND created_at<?').run(new Date(Date.parse(this.clock())-3*86400000).toISOString());}
 usage(member=null){const day=this.clock().slice(0,10);if(member){const row=this.db.prepare('SELECT spent,reserved,calls,voice_seconds FROM member_usage WHERE day=? AND member=?').get(day,member);return{day,spent:0,reserved:0,calls:0,voice_seconds:0,...row,limit:this.person};}const row=this.db.prepare('SELECT COALESCE(SUM(spent),0) AS spent,COALESCE(SUM(reserved),0) AS reserved FROM member_usage WHERE day=?').get(day),external=this.db.prepare('SELECT external FROM shared_days WHERE day=?').get(day)?.external??0;return{day,spent:row.spent+external,reserved:row.reserved,limit:this.total};}
 overview(){return{usage:this.usage(),members:this.db.prepare('SELECT id,label,active,joined_at FROM members ORDER BY joined_at,id').all(),capacity:this.maxUsers,mode:this.mode};}
 schedule(member,at){requireThat(this.active(member)&&Number.isFinite(Date.parse(at)),'ACCESS','Пользователь недоступен.');this.db.prepare('UPDATE members SET next_wake=? WHERE id=?').run(at,member);}
 due(){return this.db.prepare('SELECT id FROM members WHERE active=1 AND (next_wake IS NULL OR next_wake<=?)').all(new Date(Date.parse(this.clock())+10000).toISOString()).map(row=>row.id);}
}
