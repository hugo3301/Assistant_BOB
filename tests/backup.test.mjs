import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {CalendarService} from '../src/calendars/service.mjs';
import {ProviderSettings} from '../src/provider-settings.mjs';
import {createBackup,restoreBackup} from '../src/backup.mjs';
import {encryptBackup,decryptBackup} from '../scripts/backup.mjs';
import {ReminderWorker} from '../src/reminders.mjs';
const owner='123',before='2026-11-15T00:00:00.000Z',after='2026-11-15T02:00:00.000Z';
function fresh(){const s=new Store();s.ensureUser(owner);new CalendarService(s,owner,{CALENDAR_SECRET_KEY:'c'.repeat(64)});new ProviderSettings(s,owner,{});return s;}
function seed(s){
 s.settings(owner,{timezone:'Asia/Tomsk',morningTime:'08:00',reminderMinutes:60});
 s.db.prepare('INSERT INTO projects VALUES (?,?)').run(owner,'Синтетический проект');
 s.db.prepare('INSERT INTO weekly_series VALUES (?,?,?,?,?,?,?,?,?)').run('series',owner,'Зал','[1,3,5]','18:00',60,'Asia/Tomsk',0,before);
 s.putItem({id:'future',owner,kind:'event',title:'Будущая встреча',day:'2026-11-16',at:'2026-11-16T10:00:00.000Z',duration:45,series_id:'series',project:'Синтетический проект'},before,60);
 s.putItem({id:'overdue',owner,kind:'event',title:'Старое',day:'2026-11-15',at:'2026-11-15T04:00:00.000Z'},before,180);
 s.putItem({id:'sent',owner,kind:'event',title:'Уже доставлено',day:'2026-11-16',at:'2026-11-16T11:00:00.000Z'},before,60);
 s.db.prepare("UPDATE reminders SET status='sent',sent_at=? WHERE item_id='sent'").run(before);
 s.db.prepare("UPDATE reminders SET status='claimed',lease='old-lease' WHERE item_id='overdue'").run();
 s.db.prepare('INSERT INTO calendar_items VALUES (?,?,?,?,?)').run('future',owner,'tpu','group',1);
 s.db.prepare('INSERT INTO calendar_filters VALUES (?,?,?,?)').run(owner,'tpu','["group"]','["group"]');
 s.db.prepare("UPDATE users SET history='[{\"user\":\"private conversation\"}]',pending='{}' WHERE id=?").run(owner);
 s.db.prepare("INSERT INTO calendar_connections(id,owner,provider,label,credentials,created_at) VALUES (?,?,?,?,?,?)").run('conn',owner,'yandex','Test','secret-credential-must-not-export',before);
}
test('encrypted personal copy restores settings, projects, series, exclusions and future reminders without replay',async()=>{
 const source=fresh(),target=fresh();try{
  seed(source);const snapshot=createBackup(source,owner,before),text=JSON.stringify(snapshot);
  assert.ok(!text.includes('secret-credential'));assert.ok(!text.includes('private conversation'));assert.ok(!text.includes('old-lease'));
  const key=Buffer.alloc(32,7),encrypted=encryptBackup(snapshot,key);assert.ok(!encrypted.includes('Будущая встреча'));assert.deepEqual(decryptBackup(encrypted,key),snapshot);
  assert.throws(()=>decryptBackup(encrypted,Buffer.alloc(32,8)));const tampered=JSON.parse(encrypted);tampered.body='AAAA'+tampered.body.slice(4);assert.throws(()=>decryptBackup(JSON.stringify(tampered),key));
  restoreBackup(target,owner,snapshot,after);
  assert.equal(target.user(owner).timezone,'Asia/Tomsk');assert.equal(target.user(owner).morning_time,'08:00');assert.equal(target.user(owner).reminder_minutes,60);assert.deepEqual(target.user(owner).history,[]);
  assert.equal(target.items(owner).length,3);assert.equal(target.db.prepare('SELECT active FROM weekly_series').get().active,0);assert.equal(target.db.prepare('SELECT excluded FROM calendar_items').get().excluded,1);
  assert.equal(target.db.prepare('SELECT name FROM projects').get().name,'Синтетический проект');assert.equal(target.db.prepare('SELECT credentials FROM calendar_connections').get().credentials,null);assert.equal(target.db.prepare('SELECT status FROM calendar_connections').get().status,'off');
  assert.equal(target.db.prepare("SELECT status FROM reminders WHERE item_id='overdue'").get().status,'skipped');
  assert.equal(target.db.prepare("SELECT status FROM reminders WHERE item_id='sent'").get().status,'sent');
  const sends=[];await new ReminderWorker(target,{clock:()=>after}).tick(m=>sends.push(m));assert.equal(sends.length,0);
  const futureId=target.db.prepare("SELECT id FROM reminders WHERE item_id='future'").get().id;
  await new ReminderWorker(target,{clock:()=> '2026-11-16T09:00:00.000Z'}).tick(m=>sends.push(m));assert.equal(sends.filter(m=>m.id===futureId).length,1);
  await new ReminderWorker(target,{clock:()=> '2026-11-16T09:00:00.000Z'}).tick(m=>sends.push(m));assert.equal(sends.filter(m=>m.id===futureId).length,1);
  assert.throws(()=>restoreBackup(target,owner,snapshot,after));
 }finally{source.close();target.close();}
});
test('restore rejects foreign ownership, malformed columns, newer format and nonempty target atomically',()=>{
 const source=fresh(),target=fresh();try{seed(source);const snapshot=createBackup(source,owner,before);
  for(const mutate of [b=>b.owner='456',b=>b.data.items[0].owner='456',b=>b.data.items[0].extra='x',b=>b.version=999,b=>b.data.item_context[0].item_id='foreign',b=>b.data.items[0].duration={sql:'x'}]){const b=structuredClone(snapshot);mutate(b);assert.throws(()=>restoreBackup(target,owner,b,after));assert.equal(target.items(owner).length,0);}
  target.settings(owner,{morningTime:'09:00'});assert.throws(()=>restoreBackup(target,owner,snapshot,after));assert.equal(target.user(owner).morning_time,'09:00');
 }finally{source.close();target.close();}
});
test('fresh participant onboarding does not prevent restoration',()=>{
 const source=fresh(),target=fresh();try{seed(source);target.db.prepare('UPDATE ui_profiles SET onboarding=1,morning_from=? WHERE owner=?').run('2026-11-16',owner);restoreBackup(target,owner,createBackup(source,owner,before),after);assert.equal(target.items(owner).length,3);}finally{source.close();target.close();}
});
