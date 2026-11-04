import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDate,verifyDatePhrase,cleanUserText } from '../src/dates.mjs';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
const NOW='2026-11-04T08:00:00.000Z'; // 15:00 Tomsk
const call=(name,args)=>({id:'test',function:{name,arguments:JSON.stringify(args)}});
const ai=(...steps)=>({count:0,async complete(){return{message:{tool_calls:steps[this.count++]}};}});
const make=provider=>{const store=new Store();return {store,bot:new Assistant(store,{provider,allowedOwners:['alice'],clock:()=>NOW})};};
for(const [phrase,expected] of [
 ['сегодня вечером где-то к 7 вечера пара по предмету есть','2026-11-04T12:00:00.000Z'],
 ['в 7 вечера пара по предмету','2026-11-04T12:00:00.000Z'],
 ['сегодня к семи вечера','2026-11-04T12:00:00.000Z'],
 ['Сегодня вечером в семь','2026-11-04T12:00:00.000Z'],
 ['сегодня в7вечера','2026-11-04T12:00:00.000Z'],
 ['завтра в 7 утра','2026-11-05T00:00:00.000Z'],
 ['завтра в 7 вечера','2026-11-05T12:00:00.000Z'],
 ['завтра в 19.30','2026-11-05T12:30:00.000Z'],
 ['завтра 19:30','2026-11-05T12:30:00.000Z'],
 ['12.11.2026 в 19:00','2026-11-12T12:00:00.000Z'],
 ['12 ноября, в 19:00.','2026-11-12T12:00:00.000Z'],
 ['в четверг в 19:00','2026-11-05T12:00:00.000Z'],
 ['в следующую пятницу в 19:00','2026-11-13T12:00:00.000Z'],
 ['в ближайшую пятницу в 19:00','2026-11-06T12:00:00.000Z'],
 ['через два часа','2026-11-04T10:00:00.000Z'],
 ['через полчаса','2026-11-04T08:30:00.000Z'],
 ['через 2 дня в 7 вечера','2026-11-06T12:00:00.000Z'],
 ['завтра в полседьмого вечера','2026-11-05T11:30:00.000Z'],
 ['завтра в половину восьмого вечера','2026-11-05T12:30:00.000Z'],
 ['завтра без четверти семь вечера','2026-11-05T11:45:00.000Z'],
 ['завтра в 12 ночи','2026-11-04T17:00:00.000Z'],
 ['завтра в 16:00 по Москве','2026-11-05T13:00:00.000Z'],
])test(`ordinary date phrase: ${phrase}`,()=>{assert.equal(resolveDate(phrase,{now:NOW,requireTime:true,defaultToday:true}).at,expected);});
for(const phrase of ['> Добавь задачу сдать отчёт к 12 ноября.','Добавь задачу сдать отчёт к 12 ноября.','**Добавь** задачу «сдать отчёт» к 12 ноября!','двенадцатого ноября','12-го ноября','12го'])test(`deadline survives formatting: ${phrase}`,()=>assert.equal(resolveDate(cleanUserText(phrase),{now:NOW}).day,'2026-11-12'));
test('unknown time and contradictory dates still ask for missing information',()=>{
 for(const phrase of ['сегодня вечером','завтра после пар'])assert.throws(()=>resolveDate(phrase,{now:NOW,requireTime:true,defaultToday:true}),error=>error.code==='TIME_MISSING');
 for(const phrase of ['завтра послезавтра в 19:00','12 ноября 14 ноября','сегодня в 7 утра и в 7 вечера'])assert.throws(()=>resolveDate(phrase,{now:NOW,requireTime:true,defaultToday:true}),error=>['DATE_CONFLICT','TIME_CONFLICT'].includes(error.code));
 assert.throws(()=>resolveDate('в 7 утра',{now:NOW,requireTime:true,defaultToday:true}),error=>error.code==='DATE_IN_PAST');
});
test('normalizing spoken numbers never grants permission to invent a date',()=>{
 assert.doesNotThrow(()=>verifyDatePhrase('сегодня в 19:00','сегодня к семи вечера пара'));
 assert.throws(()=>verifyDatePhrase('сегодня в 20:00','сегодня к семи вечера пара'));
 assert.throws(()=>verifyDatePhrase('2026-11-05 в 19:00','завтра в 7 вечера пара'));
});
test('the actual user sentence creates an approximate evening event and a reminder',async()=>{
 const source='сегодня вечером где-то к 7 вечера пара по предмету есть', {store,bot}=make(ai([call('create_event',{title:'Пара по предмету',when_text:source})]));
 try{const response=await bot.handle('alice',source);assert.equal(response.changed,1);const item=store.items('alice')[0];assert.equal(item.at,'2026-11-04T12:00:00.000Z');assert.equal(item.approximate,1);assert.match(response.text,/около/);assert.equal(store.pendingReminders('alice')[0].fire_at,'2026-11-04T11:00:00.000Z');assert.match((await bot.handle('alice','/today')).text,/Пара по предмету/);}finally{store.close();}
});
test('time clarification keeps the original day without requiring a formatted answer',async()=>{
 const provider=ai([call('create_event',{title:'Пара по предмету',when_text:'сегодня вечером'})]),{store,bot}=make(provider);
 try{assert.equal((await bot.handle('alice','сегодня вечером пара по предмету есть')).status,'clarify');const result=await bot.handle('alice','в 7 вечера пара по предмету');assert.equal(result.changed,1);assert.equal(provider.count,1);assert.equal(store.items('alice')[0].at,'2026-11-04T12:00:00.000Z');}finally{store.close();}
});
test('a quoted new request replaces a stale date clarification instead of corrupting it',async()=>{
 const {store,bot}=make(ai([call('create_event',{title:'Пара',when_text:'сегодня вечером'})],[call('create_task',{title:'Сдать отчёт',due_text:'Добавь задачу сдать отчёт к 12 ноября.'})]));
 try{await bot.handle('alice','Сегодня вечером пара.');const result=await bot.handle('alice','> Добавь задачу сдать отчёт к 12 ноября.');assert.equal(result.changed,1);assert.equal(store.items('alice').length,1);assert.equal(store.items('alice')[0].kind,'task');assert.equal(store.items('alice')[0].day,'2026-11-12');}finally{store.close();}
});

