import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {ControlStore} from '../src/control.mjs';
import {ProviderLedger} from '../src/provider-ledger.mjs';
import {OpsStore,safeSnapshot} from '../src/ops.mjs';
import {adminPublic} from '../src/admin/public.mjs';
import {APP_ORIGIN} from '../src/calendars/pages.mjs';
import {createHmac} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {ADMIN_CLIENT} from '../src/admin/client-source.mjs';
let seq=0;
function setup(){let now='2026-11-07T02:00:00.000Z';const store=new Store(),clock=()=>now,control=new ControlStore(store.db,{admin:'123',clock,mode:'open'}),ops=new OpsStore(store.db,{clock}),providers=new ProviderLedger(control,{gigachatCap:49900000});return {store,control,ops,providers,advance:ms=>now=new Date(Date.parse(now)+ms).toISOString(),read:(options={})=>ops.read(control,providers,{},options),event:(component,fields={})=>({id:'e-'+(++seq),component,outcome:'ok',...fields})};}
test('metrics aggregate once, measure histogram percentiles and keep unknown usage distinct from zero',()=>{
 const {store,ops,read,event}=setup();try{const a=event('llm_cloudflare',{durationMs:120,tokens:20,inputTokens:15,outputTokens:5,neurons:2});ops.record('123',[a,a,event('llm_cloudflare',{durationMs:900,outcome:'AI_QUOTA'}),event('filtered',{outcome:'filtered'})]);const data=read();assert.equal(data.components.llm_cloudflare.requests,2);assert.equal(data.components.llm_cloudflare.errors,1);assert.deepEqual(data.components.llm_cloudflare.latency,{samples:2,p50:250,p95:1000,p99:1000,source:'histogram_upper_bound_ms'});assert.equal(data.components.llm_cloudflare.usage.tokens.value,20);assert.equal(data.components.llm_cloudflare.usage.cachedTokens,undefined);assert.equal(data.providers[0].unit,'neurons');assert.equal(data.providers[1].unit,'audio_seconds');assert.equal(data.providers[2].unit,'tokens');assert.equal(data.providers.every(p=>p.providerBalance===null),true);}finally{store.close();}
});
test('snapshots and export cannot include private fields, labels, owner IDs, or arbitrary dimensions',()=>{
 const {store,ops,read,event}=setup();try{ops.record('123',[{...event('job'),text:'PRIVATE',title:'PRIVATE',token:'PRIVATE'}],{jobs:{pending:2,PRIVATE:3},items:4,token:'PRIVATE',calendars:{google:{active:1}},calendarHealth:{google:{lastOk:'2026-11-07T01:00:00.000Z',errors:{CALENDAR_AUTH:1,'PRIVATE text':1}}},providerUsers:{groq:1}});const data=read({exporting:true}),json=JSON.stringify(data);assert.equal(json.includes('PRIVATE'),false);assert.equal(json.includes('Владелец'),false);assert.equal(json.includes('"member"'),false);assert.equal(data.gauges.jobs.pending,2);assert.equal(data.gauges.providerUsers.groq,1);assert.equal(data.gauges.calendarHealth.google.errors.CALENDAR_AUTH,1);assert.throws(()=>ops.record('123',[event('user supplied component')]),/метрика/);}finally{store.close();}
});
test('periods, database-backed rate limit, cache, pruning and restart preserve bounded observations',()=>{
 const {store,control,providers,ops,read,event,advance}=setup();try{
 ops.record('123',[event('inbound')]);read();assert.equal(read().cached,true);for(let i=0;i<28;i++)read();assert.throws(()=>read(),/Подожди минуту/);advance(60000);assert.equal(read().cached,false);
 advance(32*86400000);ops.record('123',[event('job')]);const data=read({period:'month'});assert.equal(data.components.inbound,undefined);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ops_seen').get().n,1);assert.throws(()=>read({period:'year'}),/Выбери/);
 advance(2500);const restored=new OpsStore(store.db,{clock:()=>new Date(Date.parse(data.generatedAt)+2500).toISOString()});assert.equal(restored.read(control,providers,{}).components.job.requests,1);
 }finally{store.close();}
});
test('activity and D1 retention use mature cohorts after collection began',()=>{
 const {store,control,ops,read,event,advance}=setup();try{
 advance(86400000);control.access('456',{start:true,label:'PRIVATE NAME'});ops.record('456',[event('inbound')]);advance(86400000);ops.record('456',[event('inbound')]);advance(86400000);
 const data=read({period:'week'});assert.equal(data.users.retentionD1.eligible,1);assert.equal(data.users.retentionD1.returned,1);assert.equal(data.users.retentionD1.rate,1);assert.equal(data.users.active,1);assert.equal(JSON.stringify(data).includes('PRIVATE NAME'),false);
 }finally{store.close();}
});
const token='123456789:'+'A'.repeat(35);
function signed(id,authDate=Math.floor(Date.now()/1000)){const q=new URLSearchParams({auth_date:String(authDate),user:JSON.stringify({id,first_name:'Synthetic'})}),text=[...q].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>key+'='+value).join('\n'),secret=createHmac('sha256','WebAppData').update(token).digest();q.set('hash',createHmac('sha256',secret).update(text).digest('hex'));return q.toString();}
test('dashboard denies anonymous, forged, expired, foreign users and cross-origin before internal reads',async()=>{
 let internal=0;const env={TELEGRAM_BOT_TOKEN:token,TELEGRAM_OWNER_ID:'123',CONTROL:{idFromName:()=>1,get:()=>({fetch:()=>{internal++;throw Error('must not reach');}})}};
 for(const [body,origin] of [[{},APP_ORIGIN],[{initData:'forged'},APP_ORIGIN],[{initData:signed(456)},APP_ORIGIN],[{initData:signed(123,1)},APP_ORIGIN],[{initData:signed(123)},'https://evil.example']]){const r=await adminPublic(new Request(APP_ORIGIN+'/dashboard/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);assert.ok([401,403].includes(r.status));}assert.equal(internal,0);
});
test('valid owner can read and export only bounded aggregate data; page contains no private credentials',async()=>{
 const paths=[],env={TELEGRAM_BOT_TOKEN:token,TELEGRAM_OWNER_ID:'123',CONTROL:{idFromName:()=>1,get:()=>({fetch:async(url,init)=>{paths.push(new URL(url).pathname);const data=JSON.parse(init.body);if(url.endsWith('/access'))return Response.json({allowed:true});assert.equal(data.owner,'123');assert.equal(data.period,'week');return Response.json({users:{total:2},providers:[{provider:'groq',unit:'audio_seconds'}]});}})}};
 const response=await adminPublic(new Request(APP_ORIGIN+'/dashboard/export',{method:'POST',headers:{Origin:APP_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({initData:signed(123),period:'week',owner:'456'})}),env);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(paths,['/access','/ops']);
 const page=await adminPublic(new Request(APP_ORIGIN+'/dashboard'),env);const html=await page.text();assert.equal(html.includes(token),false);assert.ok(page.headers.get('Content-Security-Policy').includes("default-src 'none'"));assert.equal(html.includes('ADMIN_SECRET'),false);assert.equal(html.includes('initDataUnsafe'),false);
});
test('bundled dashboard client renders every tab, changes periods, exports and handles missing Telegram login',async()=>{
 const {store,ops,read,event}=setup();try{
 ops.record('123',[event('inbound'),event('job',{durationMs:123}),event('llm_gigachat',{tokens:0,cachedTokens:0})],{jobs:{done:1},calendars:{google:{active:1}},calendarHealth:{google:{lastOk:'2026-11-07T01:00:00Z'}}});const payload=read();
 const nodes=new Map(),make=id=>({id,innerHTML:'',textContent:'',disabled:false,checked:false,value:'',dataset:{},attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.events[k]=fn;},showModal(){this.open=true;},close(){this.open=false;},click(){this.clicked=true;}});
 const node=id=>{if(!nodes.has(id))nodes.set(id,make(id));return nodes.get(id);},tabs=['overview','components','providers','calendars','audit'].map(tab=>Object.assign(make('tab-'+tab),{dataset:{tab}})),periods=['day','week','month'].map(period=>Object.assign(make(period),{dataset:{period}}));
 const paths=[],context={document:{hidden:false,getElementById:node,querySelectorAll:selector=>selector==='[data-tab]'?tabs:periods,createElement:()=>make('a')},window:{Telegram:{WebApp:{initData:'synthetic',ready(){},expand(){}}}},fetch:async(url,init)=>{paths.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>payload};},AbortController,AbortSignal,Intl,Date,Blob,URL,console,setInterval(){},setTimeout(){},clearTimeout(){},navigator:{clipboard:{writeText:async()=>{}}}};
 const tick=()=>new Promise(resolve=>setImmediate(resolve));runInNewContext(ADMIN_CLIENT,context);await tick();assert.match(node('content').innerHTML,/Ритм обращений/);
 for(const tab of tabs){tab.events.click();assert.ok(node('content').innerHTML.length>100);assert.equal(node('content').attrs['aria-labelledby'],tab.id);}
 tabs[2].events.click();assert.match(node('content').innerHTML,/Баланс провайдера/);assert.match(node('content').innerHTML,/0<\/td>/);
 periods[1].events.click();await tick();assert.equal(paths.at(-1).body.period,'week');await node('export').events.click();await tick();assert.equal(paths.at(-1).url,'/dashboard/export');assert.ok(node('export-dialog').open);assert.equal(JSON.parse(node('copy').value).users.total,1);
 context.window={};runInNewContext(ADMIN_CLIENT,context);node('telegram-sdk').events.error();await tick();assert.match(node('notice').innerHTML,/личном чате BOB/);
 }finally{store.close();}
});
