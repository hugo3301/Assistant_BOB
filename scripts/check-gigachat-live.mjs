// Approved bounded evaluation: synthetic context only, proposals are never executed.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {modelContext} from '../src/context.mjs';
import {decodeCalls} from '../src/tools.mjs';
import {GigaChat,GigaTokenCache} from '../src/gigachat.mjs';
import {createGigaNodeFetch} from '../src/gigachat-node.mjs';
const CASES=[
 {id:'ordinary-evening',text:'Сегодня вечером где-то к 7 вечера пара по схемату есть',expected:'create_event'},
 {id:'quoted-task',text:'> Добавь задачу сдать отчёт к 12 ноября.',expected:'create_task'},
 {id:'ambiguous-target',text:'Перенеси лабу на пятницу',expected:'ask_user'},
 {id:'work-not-deadline',text:'Завтра в 15:00 час поработать над отчётом, срок сдачи не меняй',expected:'plan_work'},
 {id:'focused-completion',text:'Её я уже сдал',expected:'complete_task'},
 {id:'weekly-view',text:'Покажи план на неделю',expected:'list_items'},
];
const revision=createHash('sha256').update(readFileSync(new URL('../src/gigachat.mjs',import.meta.url))).digest('hex').slice(0,12);
const LIMIT=100000,MAX_CALLS=18,NOW='2026-11-06T02:00:00.000Z';
if(!process.argv.includes('--run')){console.log(JSON.stringify({network:false,synthetic:true,maximumCalls:MAX_CALLS,maximumAccountedTokens:LIMIT,cases:CASES.length}));process.exit(0);}
const caIndex=process.argv.indexOf('--ca');if(caIndex<0||!process.argv[caIndex+1]||!process.env.GIGACHAT_AUTH_KEY)throw Error('Supply excluded GIGACHAT_AUTH_KEY and --ca <official-root.pem>');
if(process.env.GIGACHAT_FREE_CONFIRMED!=='true')throw Error('Verify actual Free package first');
mkdirSync('work',{recursive:true});const trial='ultra-v2';if(!process.argv.includes('--ultra-validation'))throw Error('Use --ultra-validation only after approval for the 18-call Ultra trial');const path='work/gigachat-ultra-evaluation-ledger.json',ledger=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{calls:0,spent:0,reserved:0,entries:[]};ledger.spent+=ledger.reserved;ledger.reserved=0;const save=()=>writeFileSync(path,JSON.stringify(ledger,null,2));save();
const nodeFetch=createGigaNodeFetch({ca:readFileSync(process.argv[caIndex+1],'utf8')}),fetcher=async(url,init)=>{
 if(url.endsWith('/chat/completions')){if(ledger.calls>=MAX_CALLS)throw Error('Maximum approved API calls reached');ledger.calls++;save();}
 const response=await nodeFetch(url,init);if(response.ok&&url.endsWith('/chat/completions')){const payload=await response.clone().json();writeFileSync('work/gigachat-round'+trial+'-synthetic-response-'+ledger.calls+'.json',JSON.stringify({messages:payload.messages,finish_reason:payload.finish_reason,usage:payload.usage},null,2));}if(!response.ok){let debug={status:response.status};try{const body=await response.clone().json();debug={...debug,message:String(body.message??body.error?.message??body.error??'').replace(/[A-Za-z0-9+/_=-]{24,}/g,'[redacted]').slice(0,500)};}catch{}writeFileSync('work/gigachat-http-debug.json',JSON.stringify(debug));}return response;
};
const budget={async reserve(amount){if(ledger.spent+ledger.reserved+amount>LIMIT)throw Error('Maximum approved token budget reached');ledger.reserved=amount;save();return 'synthetic';},async settle(id,observed){ledger.spent+=Number.isFinite(observed)?observed:ledger.reserved;ledger.reserved=0;save();}},provider=new GigaChat({budget,tokens:new GigaTokenCache({authKey:process.env.GIGACHAT_AUTH_KEY,fetcher}),fetcher});
for(const sample of CASES){if(ledger.calls>=MAX_CALLS)break;if(ledger.entries.some(entry=>entry.id===sample.id&&entry.revision===revision&&entry.passed))continue;const store=new Store();try{
 store.ensureUser('evaluation');for(const item of [{id:'report',kind:'task',title:'Отчёт',day:'2026-11-12'},{id:'lab-a',kind:'task',title:'Лаба по сетям',day:'2026-11-11'},{id:'lab-b',kind:'task',title:'Лаба по вычислениям',day:'2026-11-10'}])store.putItem({...item,owner:'evaluation'},NOW,60);store.db.prepare('UPDATE users SET focus_id=? WHERE id=?').run('report','evaluation');
 const assistant=new Assistant(store,{allowedOwners:['evaluation'],clock:()=>NOW}),before=store.items('evaluation'),start=performance.now();let entry;
 try{const result=await provider.complete({context:modelContext(store,'evaluation',sample.text,NOW),text:sample.text}),calls=decodeCalls(result.message),prepared=assistant.prepare('evaluation',calls,sample.text,store.user('evaluation'),NOW);entry={id:sample.id,expected:sample.expected,actual:calls.map(call=>call.name),passed:calls.length===1&&calls[0].name===sample.expected,preparedKinds:prepared.map(item=>item.kind),tokens:result.usage.tokens,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,ms:Math.round(performance.now()-start)};
  if(sample.id==='ordinary-evening')entry.passed&&=prepared[0]?.item?.at==='2026-11-06T12:00:00.000Z';
  if(sample.id==='work-not-deadline')entry.passed&&=prepared[0]?.item?.duration===60&&prepared[0]?.item?.parent_id==='report'&&store.items('evaluation').find(item=>item.id==='report').day==='2026-11-12';
 }catch(error){entry={id:sample.id,expected:sample.expected,passed:false,code:error.code??'UNEXPECTED',ms:Math.round(performance.now()-start)};}
 if(JSON.stringify(store.items('evaluation'))!==JSON.stringify(before))throw Error('Evaluation must not execute actions');entry.revision=revision;ledger.entries.push(entry);save();console.log(JSON.stringify(entry));if(entry.code==='AI_HTTP'||entry.code==='PROVIDER_AUTH'||entry.code==='UNEXPECTED')break;
}finally{store.close();}}
const report={trial,revision,provider:'gigachat',model:'GigaChat-3-Ultra',synthetic:true,productionWrites:false,telegramCalls:0,maximumCalls:MAX_CALLS,maximumAccountedTokens:LIMIT,calls:ledger.calls,chargedTokens:ledger.spent,entries:ledger.entries,passed:CASES.every(sample=>ledger.entries.some(entry=>entry.id===sample.id&&entry.revision===revision&&entry.passed))};writeFileSync('work/gigachat-ultra-live-summary.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
