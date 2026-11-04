import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {WorkersAI} from '../src/ai.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const path=resolve('work/language-validation',new Date().toISOString().replaceAll(':','-'));mkdirSync(path,{recursive:true});
const entries=[];let totalCalls=0;
const scenarios=[
 {messages:['сегодня вечером где-то к 7 вечера пара по предмету есть'],check:items=>items.length===1&&items[0].at==='2026-11-04T12:00:00.000Z'},
 {messages:['сегодня вечером пара по предмету есть','в 7 вечера пара по предмету'],check:items=>items.length===1&&items[0].at==='2026-11-04T12:00:00.000Z'},
 {messages:['> Добавь задачу сдать отчёт к 12 ноября.'],check:items=>items.length===1&&items[0].day==='2026-11-12'},
 {messages:['завтра в полседьмого вечера встреча по проекту'],check:items=>items.length===1&&items[0].at==='2026-11-05T11:30:00.000Z'},
];
for(const [index,scenario] of scenarios.entries()){
 const store=new Store(resolve(path,`scenario-${index}.sqlite`));
 try{
  const provider=new WorkersAI(store,{accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,dailyBudget:250});
  const bot=new Assistant(store,{provider,allowedOwners:['validation'],clock:()=> '2026-11-04T08:00:00.000Z'}),responses=[];
  for(const text of scenario.messages){const response=await bot.handle('validation',text);responses.push({text,response});totalCalls+=response.modelCalls;}
  const passed=scenario.check(store.items('validation'));entries.push({index,passed,responses,items:store.items('validation'),usage:store.usage(new Date().toISOString().slice(0,10))});console.log(JSON.stringify({scenario:index+1,passed,replies:responses.map(entry=>entry.response.text)}));
 }finally{store.close();}
}
const neurons=entries.reduce((sum,entry)=>sum+entry.usage.spent,0);writeFileSync(resolve(path,'result.json'),JSON.stringify({entries,totalCalls,neurons},null,2));console.log(JSON.stringify({allPassed:entries.every(entry=>entry.passed),totalCalls,neurons}));if(entries.some(entry=>!entry.passed))process.exitCode=1;

