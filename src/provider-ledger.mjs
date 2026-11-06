import {randomUUID} from 'node:crypto';
import {requireThat} from './errors.mjs';

// Different providers have different units; none of these counters are neurons.
export class ProviderLedger {
 constructor(control,{gigachatCap=0}={}) {
  this.control=control;this.db=control.db;this.gigachatCap=Number(gigachatCap)||0;
  this.db.exec(`CREATE TABLE IF NOT EXISTS provider_usage(provider TEXT NOT NULL,bucket TEXT NOT NULL,member TEXT NOT NULL,spent REAL NOT NULL DEFAULT 0,reserved REAL NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,bucket,member));
   CREATE TABLE IF NOT EXISTS provider_reservations(id TEXT PRIMARY KEY,provider TEXT NOT NULL,member TEXT NOT NULL,amount REAL NOT NULL,buckets TEXT NOT NULL,created_at TEXT NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS provider_pending ON provider_reservations(provider,settled,created_at);
   CREATE TABLE IF NOT EXISTS provider_dispatches(id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,claimed_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS provider_dispatch_age ON provider_dispatches(claimed_at);
   CREATE TABLE IF NOT EXISTS provider_probes(id TEXT PRIMARY KEY,amount REAL NOT NULL);`);
 }
 buckets(provider,member) {
  const now=this.control.clock(),day=now.slice(0,10),hour=now.slice(0,13),minute=now.slice(0,16);
  if(provider==='groq')return[
   ['day:'+day,'*',27000,1800],['hour:'+hour,'*',6600,Infinity],['minute:'+minute,'*',Infinity,18],['day:'+day,member,600,100],
  ];
  requireThat(provider==='gigachat'&&this.gigachatCap>0,'PROVIDER_DISABLED','Этот провайдер пока не подключён.');
  return[['day:'+day,'*',500000,Infinity],['day:'+day,member,20000,100],['pool','*',this.gigachatCap,Infinity]];
 }
 row(provider,bucket,member){return this.db.prepare('SELECT spent,reserved,requests FROM provider_usage WHERE provider=? AND bucket=? AND member=?').get(provider,bucket,member)??{spent:0,reserved:0,requests:0};}
 reserve(member,provider,amount){
  requireThat(this.control.active(member),'ACCESS','Доступ отключён.');
  requireThat(Number.isFinite(amount)&&amount>0&&amount<=100000,'PROVIDER_REQUEST','Слишком большой запрос к провайдеру.');
  return this.control.transaction(()=>{
   this.reap();const buckets=this.buckets(provider,member);
   if(provider==='gigachat')requireThat(!this.db.prepare("SELECT id FROM provider_reservations WHERE provider='gigachat' AND settled=0 LIMIT 1").get(),'PROVIDER_BUSY','GigaChat сейчас обрабатывает другой запрос. Попробуй через несколько секунд.');
   for(const [bucket,who,limit,requests] of buckets){const row=this.row(provider,bucket,who);requireThat(row.spent+row.reserved+amount<=limit&&row.requests+1<=requests,'PROVIDER_QUOTA',provider==='groq'?'Ресурс Groq на этот период закончился. Можно написать текстом или выбрать Cloudflare в /providers.':'Ресурс GigaChat на этот период закончился. Меню и напоминания работают; провайдер меняется в /providers.');}
   for(const [bucket,who] of buckets)this.db.prepare('INSERT INTO provider_usage VALUES (?,?,?,0,?,1) ON CONFLICT(provider,bucket,member) DO UPDATE SET reserved=reserved+excluded.reserved,requests=requests+1').run(provider,bucket,who,amount);
   const id=randomUUID();this.db.prepare('INSERT INTO provider_reservations VALUES (?,?,?,?,?,?,0)').run(id,provider,member,amount,JSON.stringify(buckets.map(([bucket,who])=>[bucket,who])),this.control.clock());return id;
  });
 }
 claim(id,hash,allow=()=>true,amount=null){requireThat(/^[a-f0-9-]{36}$/u.test(id??'')&&/^[a-f0-9]{64}$/u.test(hash??''),'PROVIDER_REQUEST','Некорректный запрос моста.');return this.control.transaction(()=>{const row=this.db.prepare('SELECT * FROM provider_reservations WHERE id=?').get(id),now=this.control.clock();requireThat(row&&row.provider==='gigachat'&&row.settled===0&&Date.parse(row.created_at)>=Date.parse(now)-30000&&this.control.active(row.member)&&allow(row.member)&&(amount===null||Number.isFinite(amount)&&amount>0&&amount<=row.amount),'PROVIDER_CLAIM','Резерв недоступен.');requireThat(!this.db.prepare('SELECT id FROM provider_dispatches WHERE id=?').get(id),'PROVIDER_REPLAY','Резерв уже использован.');this.db.prepare('INSERT INTO provider_dispatches VALUES (?,?,?)').run(id,hash,now);return {claimed:true};});}
 reserveProbe(member,amount){requireThat(member===this.control.admin&&Number.isInteger(amount)&&amount>0&&amount<=5000,'PROVIDER_REQUEST','Недопустимая проверка.');const usage=this.db.prepare('SELECT COUNT(*) AS calls,COALESCE(SUM(amount),0) AS total FROM provider_probes').get();requireThat(usage.calls<2&&usage.total+amount<=10000,'PROVIDER_PROBE_LIMIT','Лимит согласованных проверок исчерпан.');const id=this.reserve(member,'gigachat',amount);this.db.prepare('INSERT INTO provider_probes VALUES (?,?)').run(id,amount);return{id,remainingCalls:1-usage.calls};}
 settleProbe(member,id,observed){requireThat(member===this.control.admin&&this.db.prepare('SELECT id FROM provider_probes WHERE id=?').get(id),'PROVIDER_REQUEST','Неизвестная проверка.');this.settle(member,id,observed);}
 settle(member,id,observed=null){return this.control.transaction(()=>this.settleSync(member,id,observed));}
 settleSync(member,id,observed){const row=this.db.prepare('SELECT * FROM provider_reservations WHERE id=? AND member=?').get(id,member);if(!row||row.settled)return;const amount=Number.isFinite(observed)&&observed>=0?observed:row.amount;for(const [bucket,who] of JSON.parse(row.buckets))this.db.prepare('UPDATE provider_usage SET reserved=MAX(0,reserved-?),spent=spent+? WHERE provider=? AND bucket=? AND member=?').run(row.amount,amount,row.provider,bucket,who);this.db.prepare('UPDATE provider_reservations SET settled=1 WHERE id=?').run(id);}
 reap(){this.db.prepare('DELETE FROM provider_dispatches WHERE claimed_at<?').run(new Date(Date.parse(this.control.clock())-3*86400000).toISOString());for(const row of this.db.prepare('SELECT id,member FROM provider_reservations WHERE settled=0 AND created_at<?').all(new Date(Date.parse(this.control.clock())-60000).toISOString()))this.settleSync(row.member,row.id,null);this.db.prepare('DELETE FROM provider_reservations WHERE settled=1 AND created_at<?').run(new Date(Date.parse(this.control.clock())-3*86400000).toISOString());this.db.prepare("DELETE FROM provider_usage WHERE bucket!='pool' AND substr(bucket,instr(bucket,':')+1,10)<?").run(new Date(Date.parse(this.control.clock())-3*86400000).toISOString().slice(0,10));}
 usage(member,provider){return {provider,unit:provider==='groq'?'audio_seconds':'tokens',limits:this.buckets(provider,member).map(([bucket,who,limit,requests])=>({period:bucket.startsWith('pool')?'pool':bucket.split(':')[0],personal:who!=='*',...this.row(provider,bucket,who),limit:Number.isFinite(limit)?limit:null,requestLimit:Number.isFinite(requests)?requests:null}))};}
}
