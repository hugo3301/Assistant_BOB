import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {presentReply} from '../src/presentation.mjs';
const NOW='2026-11-07T02:00:00.000Z';
test('confirmation shows both interval boundaries and names the end day across midnight',async()=>{
 const store=new Store(),clock=()=>NOW,alpha=new Alpha(store,new Assistant(store,{allowedOwners:['alice'],clock}),{clock});store.ensureUser('alice',{timezone:'Asia/Tomsk'});try{
 const result=await alpha.handle('alice','завтра с23:30до00:30 встреча'),view=presentReply(result,store,'alice',NOW);assert.match(view.text,/23:30–00:30/);assert.match(view.text,/9 ноября/);assert.doesNotMatch(view.text,/event-/);
 }finally{store.close();}
});
test('batch confirmation displays individual saved items with their own endpoints, deadlines and undo',async()=>{
 const store=new Store(),clock=()=>NOW,alpha=new Alpha(store,new Assistant(store,{allowedOwners:['alice'],clock}),{clock});store.ensureUser('alice',{timezone:'Asia/Tomsk'});try{
 const result=await alpha.handle('alice','завтра с10:00до11:00 встреча с Иваном; послезавтра с15:30до16:00 созвон; сдать отчет к 12 ноября'),view=presentReply(result,store,'alice',NOW);assert.match(view.text,/Добавлено · 3/);assert.match(view.text,/10:00–11:00/);assert.match(view.text,/15:30–16:00/);assert.match(view.text,/12 ноября/);assert.doesNotMatch(view.text,/(?:event|task)-[a-f0-9]/);assert.ok(view.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data?.startsWith('j|')));
 }finally{store.close();}
});
