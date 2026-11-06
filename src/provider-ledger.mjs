import {randomUUID} from 'node:crypto';
import {requireThat} from './errors.mjs';

// Different providers have different units; none of these counters are neurons.
export class ProviderLedger {
 constructor(control,{gigachatCap=0}={}) {
  this.control=control;this.db=control.db;this.gigachatCap=Number(gigachatCap)||0;
  this.db.exec(`CREATE TABLE IF NOT EXISTS provider_usage(provider TEXT NOT NULL,bucket TEXT NOT NULL,member TEXT NOT NULL,spent REAL NOT NULL DEFAULT 0,reserved REAL NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,bucket,member));
   CREATE TABLE IF NOT EXISTS provider_reservations(id TEXT PRIMARY KEY,provider TEXT NOT NULL,member TEXT NOT NULL,amount REAL NOT NULL,buckets TEXT NOT NULL,created_at TEXT NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS provider_pending ON provider_reservations(provider,settled,created_at);`);
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
 settle(member,id,observed=null){return this.control.transaction(()=>this.settleSync(member,id,observed));}
 settleSync(member,id,observed){const row=this.db.prepare('SELECT * FROM provider_reservations WHERE id=? AND member=?').get(id,member);if(!row||row.settled)return;const amount=Number.isFinite(observed)&&observed>=0?observed:row.amount;for(const [bucket,who] of JSON.parse(row.buckets))this.db.prepare('UPDATE provider_usage SET reserved=MAX(0,reserved-?),spent=spent+? WHERE provider=? AND bucket=? AND member=?').run(row.amount,amount,row.provider,bucket,who);this.db.prepare('UPDATE provider_reservations SET settled=1 WHERE id=?').run(id);}
 reap(){for(const row of this.db.prepare('SELECT id,member FROM provider_reservations WHERE settled=0 AND created_at<?').all(new Date(Date.parse(this.control.clock())-60000).toISOString()))this.settleSync(row.member,row.id,null);this.db.prepare('DELETE FROM provider_reservations WHERE settled=1 AND created_at<?').run(new Date(Date.parse(this.control.clock())-3*86400000).toISOString());this.db.prepare("DELETE FROM provider_usage WHERE bucket!='pool' AND substr(bucket,instr(bucket,':')+1,10)<?").run(new Date(Date.parse(this.control.clock())-3*86400000).toISOString().slice(0,10));}
 usage(member,provider){return {provider,unit:provider==='groq'?'audio_seconds':'tokens',limits:this.buckets(provider,member).map(([bucket,who,limit,requests])=>({period:bucket.startsWith('pool')?'pool':bucket.split(':')[0],personal:who!=='*',...this.row(provider,bucket,who),limit:Number.isFinite(limit)?limit:null,requestLimit:Number.isFinite(requests)?requests:null}))};}
}
