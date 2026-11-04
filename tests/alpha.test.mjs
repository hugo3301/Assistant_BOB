import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Assistant } from '../src/assistant.mjs';
import { Alpha } from '../src/alpha.mjs';
import { calendarImport,calendarPreview } from '../src/calendar.mjs';
import { splitMessage,isOwnerUpdate,Telegram } from '../src/telegram.mjs';
const NOW = '2026-11-04T02:00:00.000Z';
function setup() { const store = new Store(); const assistant = new Assistant(store,{allowedOwners:['alice'],clock:()=>NOW}); const alpha = new Alpha(store,assistant,{clock:()=>NOW}); let id = 0; return {store,alpha,run:(text,documentText)=>alpha.handle('alice',text,{requestId:`alpha-${++id}`,documentText})}; }
const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:networks\r\nSUMMARY:Сети\r\nDESCRIPTION:Подгруппа 1\r\nDTSTART;TZID=Asia/Tomsk:20261105T150000\r\nDTEND;TZID=Asia/Tomsk:20261105T163000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;TZID=Asia/Tomsk:20261112T150000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:other\r\nSUMMARY:Сети\r\nDESCRIPTION:Подгруппа 2\r\nDTSTART:20261106T080000Z\r\nDTEND:20261106T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
test('Telegram ownership includes chat and sender and rejects group/foreign/bot updates',()=>{
  const update={update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},text:'/start'}};
  assert.equal(isOwnerUpdate(update,'123'),true);
  for(const value of [{...update,message:{...update.message,from:{id:456}}},{...update,message:{...update.message,chat:{id:123,type:'group'}}},{...update,message:{...update.message,from:{id:123,is_bot:true}}}]) assert.equal(isOwnerUpdate(value,'123'),false);
});
test('plain text chunking preserves Unicode and keeps every message within Telegram limits',()=>{
  const input='🙂'.repeat(5000); const chunks=splitMessage(input);
  assert.equal(chunks.join(''),input); assert.ok(chunks.every(text=>text.length<=3500 && !/^[\uDC00-\uDFFF]/.test(text)));
});
test('Telegram API errors are sanitized and preserve retry-after without leaking URL/token',async()=>{
  const token='123456789:'+ 'A'.repeat(35), telegram=new Telegram(token,{fetcher:async()=>Response.json({ok:false,parameters:{retry_after:40}},{status:429})});
  await assert.rejects(telegram.send('123','text'),error=>error.code==='TG_API' && error.retryAfter===40 && !error.message.includes(token));
});
test('profile commands are idempotent and reject invalid settings',async()=>{
  const {store,run,alpha}=setup();
  try{
    assert.equal((await run('/morning 25:61')).status,'error');
    assert.equal((await run('/morning 08:00')).status,'ok');
    assert.equal(store.user('alice').morning_time,'08:00');
    const one=await alpha.handle('alice','/remind 45',{requestId:'same'}), two=await alpha.handle('alice','/remind 45',{requestId:'same'});
    assert.equal(two.replayed,true); assert.equal(one.text,two.text); assert.equal(store.user('alice').reminder_minutes,45);
    assert.match((await run('/settings')).text,/08:00/);
  }finally{store.close();}
});
test('new tasks inherit selected project and category, and projects include undated work',async()=>{
  const {store,run,alpha}=setup();try{
    await run('/project Диплом');await run('/area Учёба');
    store.putItem({id:'work-one',owner:'alice',kind:'task',title:'Разобрать статью'},NOW,60);
    assert.equal(store.item('alice','work-one').project,'Диплом');assert.equal(store.item('alice','work-one').area,'Учёба');
    const projects=await run('/projects');assert.match(projects.text,/Диплом · 1/);
    const project=await alpha.handle('alice','',{requestId:'project-card',callback:{id:'project-card',data:projects.replyMarkup.inline_keyboard[0][0].callback_data}});assert.match(project.text,/Разобрать статью/);assert.match(project.text,/Без срока/);
    await run('/project off');store.putItem({id:'work-two',owner:'alice',kind:'task',title:'Лабораторная'},NOW,60);
    assert.equal(store.item('alice','work-two').project,null);
  }finally{store.close();}
});
test('weekly series expand without duplicates and stopping cancels future notifications',async()=>{
  const {store,run,alpha}=setup();try{
    await run('/repeat пн,ср,пт 18:00 60 Зал');
    const count=store.items('alice').length;assert.equal(count,18);assert.equal(alpha.expandSeries('alice',NOW),0);
    const id=store.db.prepare('SELECT id FROM weekly_series').get().id;
    await run(`/repeat stop ${id}`);assert.equal(store.items('alice').length,0);
    assert.equal(store.pendingReminders('alice').filter(row=>row.status==='pending').length,0);
  }finally{store.close();}
});
test('ICS preview does not write; only selected classes import, RRULE and EXDATE are applied',()=>{
  const {store}=setup();try{
    store.ensureUser('alice');const preview=calendarPreview(ics,'Asia/Tomsk',NOW);assert.equal(preview.groups.length,2);assert.equal(store.items('alice').length,0);
    const result=calendarImport(store,'alice',ics,[1],NOW);assert.equal(result.added,2);
    assert.equal(store.items('alice')[0].at,'2026-11-05T08:00:00.000Z');assert.equal(store.items('alice')[0].duration,90);
    assert.equal(calendarImport(store,'alice',ics,[1],NOW).added,0);
    assert.throws(()=>calendarImport(store,'alice',ics,[3],NOW));
  }finally{store.close();}
});
test('ICS selection persists and duplicate import leaves one event per occurrence',async()=>{
  const {store,run}=setup();try{
    const preview=await run('calendar',ics);assert.match(preview.text,/Ничего не импортировано/);
    await run('/ical keep 2');await run('/ical keep 2');assert.equal(store.items('alice').length,1);
    assert.equal(store.items('alice')[0].at,'2026-11-06T08:00:00.000Z');
  }finally{store.close();}
});
test('unknown timezone and date-only calendar events fail before any import',()=>{
  const {store}=setup();try{
    store.ensureUser('alice');
    assert.throws(()=>calendarImport(store,'alice',ics.replaceAll('Asia/Tomsk','Unknown/Zone'),[1],NOW));
    const dateOnly=ics.replace('DTSTART;TZID=Asia/Tomsk:20261105T150000','DTSTART;VALUE=DATE:20261105').replace('DTEND;TZID=Asia/Tomsk:20261105T163000','DTEND;VALUE=DATE:20261106');
    assert.throws(()=>calendarImport(store,'alice',dateOnly,[1],NOW));assert.equal(store.items('alice').length,0);
  }finally{store.close();}
});
test('diet and export retain user data without credentials or conversation secrets',async()=>{
  const {store,run}=setup();try{
    await run('/diet Мой существующий рацион');assert.equal((await run('/diet')).text,'Мой существующий рацион');
    const result=await run('/export'), data=JSON.parse(result.file.text);
    assert.equal(data.preferences.diet,'Мой существующий рацион');assert.equal(data.user.timezone,'Asia/Tomsk');assert.doesNotMatch(result.file.text,/TOKEN|SECRET|history|pending/);
  }finally{store.close();}
});
