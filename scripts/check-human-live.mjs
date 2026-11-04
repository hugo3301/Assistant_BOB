// Real free Workers AI, isolated synthetic data. No Telegram calls or production writes.
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {WorkersAI} from '../src/ai.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
const store=new Store(),clock=()=> '2026-11-04T02:00:00.000Z',results=[];
const provider=new WorkersAI(store,{accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,dailyBudget:200});
const alpha=new Alpha(store,new Assistant(store,{provider,allowedOwners:['validation'],clock}),{clock});
const steps=[
 ['what-tomorrow','Что у меня завтра?',response=>response.modelCalls===0&&response.changed===0],
 ['ordinary-event','завтра в 7 вечера встреча по проекту',response=>response.changed===1&&store.items('validation')[0].at==='2026-11-05T12:00:00.000Z'],
 ['complex-event','Зафиксируй консультацию по учёбе на завтра, начало в 16:20, напоминание за полчаса.',response=>response.changed===1&&store.items('validation').some(item=>item.at==='2026-11-05T09:20:00.000Z'&&item.reminder_minutes===30)],
 ['complex-follow-up','Слушай, её теперь нужно перенести на завтра в 17:20.',response=>response.changed===1&&store.items('validation').some(item=>item.at==='2026-11-05T10:20:00.000Z')],
 ['unknown-time','Давай потом выберем день для следующей встречи, точного времени пока нет.',response=>response.changed===0&&response.status==='clarify'],
];
try{
 for(const [id,text,check]of steps){const start=performance.now(),response=await alpha.handle('validation',text,{requestId:id}),result={case:id,passed:check(response),status:response.status,code:response.code??null,modelCalls:response.modelCalls,ms:Math.round(performance.now()-start)};results.push(result);console.log(JSON.stringify(result));if(response.status==='error')break;}
 const result={synthetic:true,productionWrites:false,telegramCalls:0,results,neurons:store.usage(new Date().toISOString().slice(0,10)).spent,allPassed:results.length===steps.length&&results.every(item=>item.passed)};
 mkdirSync('work',{recursive:true});writeFileSync('work/human-live-summary.json',JSON.stringify(result,null,2));console.log(JSON.stringify({allPassed:result.allPassed,neurons:result.neurons}));if(!result.allPassed)process.exitCode=1;
}finally{store.close();}
