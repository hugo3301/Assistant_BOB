import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';

export async function checkAdminBrowser(html,{sdk='ready',api='ok',moduleRuns=true}={}){
 const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)],module=scripts.find(s=>/type="module"/u.test(s[1]))?.[2],guard=scripts.find(s=>s[2].includes('__bobAdminSettled')&&!/type="module"/u.test(s[1]))?.[2];
 assert.ok(module&&guard,'Both the browser client and independent boot guard must be published');assert.doesNotMatch(module,/\b__name\(/u,'Worker build helper leaked into browser source');
 const nodes=new Map(),timers=new Map(),events=new Map(),requests=[];let timerId=0;
 const element=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:id==='content'?'Проверяю доступ к панели…':'',textContent:'',hidden:id==='boot-error',disabled:false,checked:false,dataset:{},attrs:{},listeners:new Map(),setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.listeners.set(k,fn);},removeEventListener(k,fn){if(this.listeners.get(k)===fn)this.listeners.delete(k);},showModal(){},close(){},click(){}});return nodes.get(id);};
 const tabs=['overview','components','providers','calendars','audit'].map(tab=>Object.assign(element('tab-'+tab),{dataset:{tab}})),periods=['day','week','month'].map(period=>Object.assign(element(period),{dataset:{period}}));
 const now='2026-11-08T00:00:00.000Z',payload={generatedAt:now,from:now,period:'day',since:now,release:{version:'test',registration:'open',commit:'a'.repeat(40)},users:{total:1,activeAccess:1,new:0,active:1,retentionD1:{rate:null,eligible:0,returned:0}},components:{inbound:{requests:2,errors:0,outcomes:{ok:2},usage:{},latency:null}},trends:[],gauges:{jobs:{},outbox:{},reminders:{},calendars:{google:{},yandex:{}},calendarHealth:{google:{lastOk:null,errors:{}},yandex:{lastOk:null,errors:{}}},retries:{jobs:0,outbox:0,reminders:0},providerUsers:{groq:0,gigachat:0},calendarConflicts:0,calendarLinks:0,icsItems:0,items:0},coverage:{snapshots:1,fresh:1,registered:1,availableSnapshots:1,snapshotLimit:1000},providers:[],audit:{last:[]},retentionDays:31};
 const webApp={initData:'synthetic-browser-fixture',ready(){},expand(){}},window={addEventListener:(key,fn)=>events.set(key,fn)};
 if(sdk==='ready')window.Telegram={WebApp:webApp};
 const context={window,document:{getElementById:element,querySelectorAll:selector=>selector==='[data-tab]'?tabs:periods,createElement:()=>element('link')},location:{reload(){}},AbortController,DOMException,Date,Intl,Blob,URL,navigator:{clipboard:{writeText:async()=>{}}},setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,fetch:async(path,options)=>{assert.equal(path,'/dashboard/data');assert.equal(JSON.parse(options.body).initData,webApp.initData);requests.push(path);if(api==='timeout')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));if(api==='network')throw Error('Connection interrupted');return {ok:api==='ok',json:async()=>api==='ok'?payload:{text:'Панель доступна только владельцу BOB.'}};}};
 const tick=()=>new Promise(resolve=>setImmediate(resolve)),fire=delay=>{for(const [id,timer] of [...timers])if(timer.delay===delay){timers.delete(id);timer.fn();}};
 runInNewContext(guard,context,{timeout:1000});
 if(moduleRuns)runInNewContext("'use strict';\n"+module,context,{timeout:1000});
 await tick();
 if(sdk==='late'){window.Telegram={WebApp:webApp};element('telegram-sdk').listeners.get('load')?.();}
 if(sdk==='error')element('telegram-sdk').listeners.get('error')?.();
 if(sdk==='timeout')fire(6000);
 await tick();if(api==='timeout')fire(12000);await tick();
 if(!moduleRuns){fire(20000);assert.equal(element('boot-error').hidden,false);assert.equal(element('content').textContent,'');}
 else if(sdk==='timeout'||sdk==='error'){assert.match(element('notice').innerHTML,/компонент Telegram/u);assert.equal(requests.length,0);assert.equal(window.__bobAdminSettled,true);}
 else if(api==='ok'){assert.match(element('content').innerHTML,/Ритм обращений/u);assert.equal(requests.length,1);for(const tab of tabs){tab.listeners.get('click')();assert.equal(element('content').attrs['aria-labelledby'],tab.id);assert.ok(element('content').innerHTML.length>100);}assert.equal(window.__bobAdminSettled,true);}
 else {assert.match(element('notice').innerHTML,api==='timeout'?/слишком долго/u:api==='network'?/Connection interrupted/u:/только владельцу/u);assert.doesNotMatch(element('content').innerHTML,/Проверяю доступ/u);assert.equal(window.__bobAdminSettled,true);}
 return {settled:window.__bobAdminSettled===true||!moduleRuns,requests:requests.length,hasFallback:!element('boot-error').hidden};
}
