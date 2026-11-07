import {requireThat} from './errors.mjs';
import {providerAvailability} from './provider-settings.mjs';

const COMPONENTS=new Set(['inbound','job','queue','reply','delivery','reminder_delivery','llm_cloudflare','llm_gigachat','stt_cloudflare','stt_groq','calendar_sync','reminders','ics','planner','filtered','cron']);
const VALUES=['tokens','inputTokens','outputTokens','cachedTokens','neurons','audioSeconds'];
const BINS=[5,10,25,50,100,250,500,1000,2000,5000,10000,20000,30000,60000,120000,300000,900000,3600000,86400000,2678400000];
const iso=value=>new Date(value).toISOString();
const code=value=>/^[A-Z][A-Z0-9_]{0,63}$/u.test(value??'')?value:'ERROR';
const count=(db,sql,...args)=>Number(db.prepare(sql).get(...args)?.n??0);

// Only fixed dimensions and numeric measurements cross tenant boundaries.
export class OpsStore {
 constructor(db,{clock=()=>new Date().toISOString()}={}){
  this.db=db;this.clock=clock;this.cache=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS ops_counts(hour TEXT NOT NULL,component TEXT NOT NULL,outcome TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(hour,component,outcome));
   CREATE TABLE IF NOT EXISTS ops_values(hour TEXT NOT NULL,component TEXT NOT NULL,metric TEXT NOT NULL,total REAL NOT NULL,samples INTEGER NOT NULL,PRIMARY KEY(hour,component,metric));
   CREATE TABLE IF NOT EXISTS ops_bins(hour TEXT NOT NULL,component TEXT NOT NULL,bound INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(hour,component,bound));
   CREATE TABLE IF NOT EXISTS ops_seen(id TEXT PRIMARY KEY,at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS ops_seen_at ON ops_seen(at);
   CREATE TABLE IF NOT EXISTS ops_activity(day TEXT NOT NULL,member TEXT NOT NULL,PRIMARY KEY(day,member));
   CREATE TABLE IF NOT EXISTS ops_snapshots(member TEXT PRIMARY KEY,at TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ops_audit(at TEXT NOT NULL,action TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ops_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO ops_meta VALUES ('since',?)").run(clock());
 }
 record(member,events=[],snapshot=null){
  requireThat(Array.isArray(events)&&events.length<=100,'OPS_INPUT','Слишком большой пакет метрик.');
  const now=this.clock(),hour=now.slice(0,13);
  const valid=events.map(event=>{
   requireThat(event&&COMPONENTS.has(event.component)&&/^[a-zA-Z0-9:._-]{1,120}$/u.test(event.id??''),'OPS_INPUT','Некорректная метрика.');
   const result={id:event.id,component:event.component,outcome:['ok','clarify','filtered','retry'].includes(event.outcome)?event.outcome:code(event.outcome)};
   for(const key of [...VALUES,'durationMs'])if(event[key]!==null&&event[key]!==undefined){requireThat(Number.isFinite(event[key])&&event[key]>=0&&event[key]<=1e12,'OPS_INPUT','Некорректное измерение.');result[key]=event[key];}
   return result;
  });
  this.db.transaction(()=>{
   for(const event of valid){
    if(!this.db.prepare('INSERT OR IGNORE INTO ops_seen VALUES (?,?)').run(member+':'+event.id,now).changes)continue;
    this.db.prepare('INSERT INTO ops_counts VALUES (?,?,?,1) ON CONFLICT(hour,component,outcome) DO UPDATE SET n=n+1').run(hour,event.component,event.outcome);
    for(const key of VALUES)if(event[key]!==undefined)this.db.prepare('INSERT INTO ops_values VALUES (?,?,?,?,1) ON CONFLICT(hour,component,metric) DO UPDATE SET total=total+excluded.total,samples=samples+1').run(hour,event.component,key,event[key]);
    if(event.durationMs!==undefined)this.db.prepare('INSERT INTO ops_bins VALUES (?,?,?,1) ON CONFLICT(hour,component,bound) DO UPDATE SET n=n+1').run(hour,event.component,BINS.find(bound=>bound>=event.durationMs)??BINS.at(-1));
    if(event.component==='inbound'&&event.outcome==='ok')this.db.prepare('INSERT OR IGNORE INTO ops_activity VALUES (?,?)').run(now.slice(0,10),member);
   }
   if(snapshot)this.db.prepare('INSERT INTO ops_snapshots VALUES (?,?,?) ON CONFLICT(member) DO UPDATE SET at=excluded.at,data=excluded.data').run(member,now,JSON.stringify(safeSnapshot(snapshot)));
   this.prune(now);
  });
 }
 prune(now=this.clock()){
  const hour=now.slice(0,13);if(this.db.prepare("SELECT value FROM ops_meta WHERE key='last_prune'").get()?.value===hour)return;
  this.db.prepare("INSERT OR REPLACE INTO ops_meta VALUES ('last_prune',?)").run(hour);
  const before=iso(Date.parse(now)-31*86400000).slice(0,13);
  for(const table of ['ops_counts','ops_values','ops_bins'])this.db.prepare(`DELETE FROM ${table} WHERE hour<?`).run(before);
  this.db.prepare('DELETE FROM ops_seen WHERE at<?').run(iso(Date.parse(now)-3*86400000));
  this.db.prepare('DELETE FROM ops_seen WHERE rowid NOT IN (SELECT rowid FROM ops_seen ORDER BY rowid DESC LIMIT 100000)').run();
  this.db.prepare('DELETE FROM ops_activity WHERE day<?').run(iso(Date.parse(now)-32*86400000).slice(0,10));
  this.db.prepare('DELETE FROM ops_audit WHERE at<?').run(iso(Date.parse(now)-31*86400000));
  this.db.prepare('DELETE FROM ops_audit WHERE rowid NOT IN (SELECT rowid FROM ops_audit ORDER BY rowid DESC LIMIT 1000)').run();
 }
 read(control,providers,env,{period='day',exporting=false}={}){
  requireThat(['day','week','month'].includes(period),'OPS_PERIOD','Выбери день, неделю или месяц.');
  const now=this.clock();
  const window=now.slice(0,16),previous=this.db.prepare("SELECT value FROM ops_meta WHERE key='read_window'").get()?.value;
  let reads=0;if(previous){const saved=JSON.parse(previous);if(saved.window===window)reads=saved.reads;}
  requireThat(reads<30,'OPS_RATE','Слишком много обновлений. Подожди минуту.');
  this.db.prepare("INSERT OR REPLACE INTO ops_meta VALUES ('read_window',?)").run(JSON.stringify({window,reads:reads+1}));
  this.db.prepare('INSERT INTO ops_audit VALUES (?,?)').run(now,exporting?'export_'+period:'view_'+period);
  this.db.prepare('DELETE FROM ops_audit WHERE rowid NOT IN (SELECT rowid FROM ops_audit ORDER BY rowid DESC LIMIT 1000)').run();
  this.prune(now);
  const cached=this.cache.get(period);if(cached&&Date.parse(now)-cached.at<15000)return {...cached.data,cached:true};
  const hours={day:24,week:168,month:720}[period],from=iso(Date.parse(now)-(hours-1)*3600000).slice(0,13),fromDay=from.slice(0,10);
  const groups=this.db.prepare('SELECT component,outcome,SUM(n) AS n FROM ops_counts WHERE hour>=? GROUP BY component,outcome').all(from);
  const components={};
  for(const row of groups){const item=components[row.component]??={requests:0,ok:0,errors:0,outcomes:{},latency:null,usage:{}};item.requests+=row.n;item.outcomes[row.outcome]=row.n;if(['ok','clarify','filtered'].includes(row.outcome))item.ok+=row.n;else item.errors+=row.n;}
  for(const row of this.db.prepare('SELECT component,metric,SUM(total) AS total,SUM(samples) AS samples FROM ops_values WHERE hour>=? GROUP BY component,metric').all(from)){if(components[row.component])components[row.component].usage[row.metric]={value:row.total,samples:row.samples,source:row.metric==='audioSeconds'?'local_audio_accounting':'provider_response'};}
  for(const [name,item] of Object.entries(components)){
   const bins=this.db.prepare('SELECT bound,SUM(n) AS n FROM ops_bins WHERE hour>=? AND component=? GROUP BY bound ORDER BY bound').all(from,name),n=bins.reduce((sum,row)=>sum+row.n,0);
   if(n){const percentile=p=>{let sum=0;return bins.find(row=>(sum+=row.n)>=Math.ceil(n*p)).bound;};item.latency={samples:n,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),source:'histogram_upper_bound_ms'};}
  }
  const snapshots=this.db.prepare('SELECT at,data FROM ops_snapshots ORDER BY at DESC LIMIT 1000').all();
  const gauges={jobs:{},outbox:{},reminders:{},calendars:{google:{},yandex:{}},calendarHealth:{google:{lastOk:null,errors:{}},yandex:{lastOk:null,errors:{}}},retries:{jobs:0,outbox:0,reminders:0},items:0,calendarLinks:0,calendarConflicts:0,icsItems:0,providerUsers:{groq:0,gigachat:0},lastCron:null,lastAlarm:null,lastJob:null,oldestJob:null,oldestOutbox:null,oldestReminder:null};
  let fresh=0,oldestSnapshot=null;
  for(const row of snapshots){const s=JSON.parse(row.data);if(Date.parse(now)-Date.parse(row.at)<7200000)fresh++;oldestSnapshot=!oldestSnapshot||row.at<oldestSnapshot?row.at:oldestSnapshot;
   for(const group of ['jobs','outbox','reminders'])for(const [status,n] of Object.entries(s[group]))gauges[group][status]=(gauges[group][status]??0)+n;
   for(const provider of ['google','yandex'])for(const [status,n] of Object.entries(s.calendars[provider]))gauges.calendars[provider][status]=(gauges.calendars[provider][status]??0)+n;
   for(const provider of ['google','yandex']){const health=s.calendarHealth[provider],target=gauges.calendarHealth[provider];if(health.lastOk&&(!target.lastOk||health.lastOk>target.lastOk))target.lastOk=health.lastOk;for(const [error,n] of Object.entries(health.errors))target.errors[error]=(target.errors[error]??0)+n;}
   for(const key of ['jobs','outbox','reminders'])gauges.retries[key]+=s.retries[key];
   for(const key of ['items','calendarLinks','calendarConflicts','icsItems'])gauges[key]+=s[key];
   for(const provider of ['groq','gigachat'])gauges.providerUsers[provider]+=s.providerUsers[provider];
   for(const key of ['lastCron','lastAlarm','lastJob'])if(s[key]&&(!gauges[key]||s[key]>gauges[key]))gauges[key]=s[key];
   for(const key of ['oldestJob','oldestOutbox','oldestReminder'])if(s[key]&&(!gauges[key]||s[key]<gauges[key]))gauges[key]=s[key];
  }
  const cronAt=this.db.prepare("SELECT value FROM ops_meta WHERE key='last_cron'").get()?.value;if(cronAt&&(!gauges.lastCron||cronAt>gauges.lastCron))gauges.lastCron=cronAt;
  const total=count(this.db,'SELECT COUNT(*) AS n FROM members'),activeAccess=count(this.db,'SELECT COUNT(*) AS n FROM members WHERE active=1');
  const since=this.db.prepare("SELECT value FROM ops_meta WHERE key='since'").get().value,matureDay=iso(Date.parse(now)-2*86400000).slice(0,10),cohortFrom=fromDay>since.slice(0,10)?fromDay:iso(Date.parse(since.slice(0,10)+'T00:00:00Z')+86400000).slice(0,10);
  const eligible=count(this.db,'SELECT COUNT(*) AS n FROM members WHERE substr(joined_at,1,10)>=? AND substr(joined_at,1,10)<=?',cohortFrom,matureDay);
  const retained=count(this.db,"SELECT COUNT(*) AS n FROM members m WHERE substr(m.joined_at,1,10)>=? AND substr(m.joined_at,1,10)<=? AND EXISTS (SELECT 1 FROM ops_activity a WHERE a.member=m.id AND a.day=date(substr(m.joined_at,1,10),'+1 day'))",cohortFrom,matureDay);
  const available=providers?['groq','gigachat'].map(provider=>{let limits=[];try{limits=providers.usage(control.admin,provider).limits.filter(row=>!row.personal);}catch{}return{provider,unit:provider==='groq'?'audio_seconds':'tokens',limits,source:'local_guard_ledger',providerBalance:null};}):[];
  const trends=this.db.prepare('SELECT hour,SUM(CASE WHEN component=\'inbound\' THEN n ELSE 0 END) AS inbound,SUM(CASE WHEN component=\'job\' THEN n ELSE 0 END) AS jobs,SUM(CASE WHEN component=\'filtered\' THEN n ELSE 0 END) AS filtered FROM ops_counts WHERE hour>=? GROUP BY hour ORDER BY hour').all(from);
  const data={generatedAt:now,from:from+':00:00.000Z',period,since:this.db.prepare("SELECT value FROM ops_meta WHERE key='since'").get().value,
   release:{commit:/^[a-f0-9]{40}$/u.test(env.BUILD_COMMIT??'')?env.BUILD_COMMIT:null,version:'0.2.0-alpha',registration:control.mode,uptime:null},
   users:{total,activeAccess,new:count(this.db,'SELECT COUNT(*) AS n FROM members WHERE joined_at>=?',from+':00:00.000Z'),active:count(this.db,'SELECT COUNT(DISTINCT member) AS n FROM ops_activity WHERE day>=?',fromDay),retentionD1:{eligible,returned:retained,rate:eligible?retained/eligible:null,completeSince:this.db.prepare("SELECT value FROM ops_meta WHERE key='since'").get().value.slice(0,10)}},
   components,trends,gauges,coverage:{snapshots:snapshots.length,availableSnapshots:count(this.db,'SELECT COUNT(*) AS n FROM ops_snapshots'),snapshotLimit:1000,fresh,registered:total,oldestSnapshot,maxFreshAgeSeconds:7200},
   providers:[{provider:'cloudflare',unit:'neurons',limits:[{period:'day',...control.usage()}],source:'local_guard_ledger',providerBalance:null},...available].map(row=>({...row,limits:row.limits.map(limit=>({...limit,remaining:limit.limit===null?null:Math.max(0,limit.limit-limit.spent-limit.reserved),resetsAt:limit.period==='pool'?null:iso(Math.floor(Date.parse(now)/({day:86400000,hour:3600000,minute:60000}[limit.period]))*({day:86400000,hour:3600000,minute:60000}[limit.period])+({day:86400000,hour:3600000,minute:60000}[limit.period]))})),configured:row.provider==='cloudflare'?Boolean(env.CLOUDFLARE_ACCOUNT_ID&&env.WORKERS_AI_TOKEN):providerAvailability(env,control.admin)[row.provider],public:row.provider!=='gigachat'||env.GIGACHAT_PUBLIC_USE_CONFIRMED==='true',keyExpiresDate:row.provider==='groq'&&/^\d{4}-\d{2}-\d{2}$/u.test(env.GROQ_KEY_EXPIRES_DATE??'')?env.GROQ_KEY_EXPIRES_DATE:null})),
   infrastructure:{workerCpu:null,workerMemory:null,freeRequestBalance:null,netlifyCredits:null,providerBilling:null,note:'Права на кабинетную аналитику и биллинг не подключены. Значения не измеряются.'},
   audit:{reads:count(this.db,'SELECT COUNT(*) AS n FROM ops_audit'),last:this.db.prepare('SELECT at,action FROM ops_audit ORDER BY rowid DESC LIMIT 10').all()},
   retentionDays:31,cached:false};
  this.cache.set(period,{at:Date.parse(now),data});return data;
 }
}

export function safeSnapshot(value){
 const result={};
 for(const group of ['jobs','outbox','reminders']){result[group]={};for(const [key,n] of Object.entries(value[group]??{}))if(['pending','processing','done','failed','sent','claimed','cancelled','skipped'].includes(key)&&Number.isInteger(n)&&n>=0)result[group][key]=n;}
 result.calendars={google:{},yandex:{}};
 for(const provider of ['google','yandex'])for(const [status,n] of Object.entries(value.calendars?.[provider]??{}))if(['active','choosing','off','error','auth','failed'].includes(status)&&Number.isInteger(n)&&n>=0)result.calendars[provider][status]=n;
 result.calendarHealth={google:{lastOk:null,errors:{}},yandex:{lastOk:null,errors:{}}};
 for(const provider of ['google','yandex']){const h=value.calendarHealth?.[provider];if(typeof h?.lastOk==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(h.lastOk)&&Number.isFinite(Date.parse(h.lastOk)))result.calendarHealth[provider].lastOk=h.lastOk;for(const [error,n] of Object.entries(h?.errors??{}).slice(0,30))if(Number.isInteger(n)&&n>=0)result.calendarHealth[provider].errors[code(error)]=n;}
 result.retries={};for(const key of ['jobs','outbox','reminders'])result.retries[key]=Number.isInteger(value.retries?.[key])&&value.retries[key]>=0?value.retries[key]:0;
 for(const key of ['items','calendarLinks','calendarConflicts','icsItems'])result[key]=Number.isInteger(value[key])&&value[key]>=0?value[key]:0;
 result.providerUsers={groq:value.providerUsers?.groq===1?1:0,gigachat:value.providerUsers?.gigachat===1?1:0};
 for(const key of ['lastCron','lastAlarm','lastJob','oldestJob','oldestOutbox','oldestReminder'])result[key]=typeof value[key]==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value[key])&&Number.isFinite(Date.parse(value[key]))?value[key]:null;
 return result;
}

export function tenantSnapshot(store,providers){
 const db=store.db,groups=table=>Object.fromEntries(db.prepare(`SELECT status,COUNT(*) AS n FROM ${table} GROUP BY status`).all().map(row=>[row.status,row.n]));
 const calendars={google:{},yandex:{}};for(const row of db.prepare('SELECT provider,status,COUNT(*) AS n FROM calendar_connections GROUP BY provider,status').all())if(calendars[row.provider])calendars[row.provider][row.status]=row.n;
 const calendarHealth={google:{lastOk:null,errors:{}},yandex:{lastOk:null,errors:{}}};for(const row of db.prepare('SELECT provider,MAX(last_ok) AS last_ok FROM calendar_connections GROUP BY provider').all())if(calendarHealth[row.provider])calendarHealth[row.provider].lastOk=row.last_ok;
 for(const row of db.prepare('SELECT provider,last_error,COUNT(*) AS n FROM calendar_connections WHERE last_error IS NOT NULL GROUP BY provider,last_error').all())if(calendarHealth[row.provider])calendarHealth[row.provider].errors[code(row.last_error)]=row.n;
 const retries={};for(const [key,table] of Object.entries({jobs:'telegram_jobs',outbox:'telegram_outbox',reminders:'reminders'}))retries[key]=count(db,`SELECT COALESCE(SUM(MAX(0,attempts-1)),0) AS n FROM ${table}`);
 const health=Object.fromEntries(db.prepare('SELECT key,value FROM runtime_health').all().map(row=>[row.key,row.value]));
 return safeSnapshot({jobs:groups('telegram_jobs'),outbox:groups('telegram_outbox'),reminders:groups('reminders'),calendars,calendarHealth,retries,
  items:count(db,"SELECT COUNT(*) AS n FROM items WHERE status='open'"),calendarLinks:count(db,'SELECT COUNT(*) AS n FROM calendar_links'),calendarConflicts:count(db,"SELECT COUNT(*) AS n FROM calendar_conflicts WHERE status='pending'"),icsItems:count(db,'SELECT COUNT(*) AS n FROM calendar_items'),
  providerUsers:{groq:providers.selected('groq')?1:0,gigachat:providers.selected('gigachat')?1:0},lastCron:health.last_cron,lastAlarm:health.last_alarm,lastJob:health.last_job,
  oldestJob:db.prepare("SELECT MIN(next_at) AS at FROM telegram_jobs WHERE status IN ('pending','processing')").get()?.at,oldestOutbox:db.prepare("SELECT MIN(next_at) AS at FROM telegram_outbox WHERE status='pending'").get()?.at,oldestReminder:db.prepare("SELECT MIN(COALESCE(next_retry,fire_at)) AS at FROM reminders WHERE status IN ('pending','claimed')").get()?.at});
}
