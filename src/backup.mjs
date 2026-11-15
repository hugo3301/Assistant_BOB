import {requireThat} from './errors.mjs';
import {dayAt,addDays} from './dates.mjs';

export const BACKUP_LIMIT=4*1024*1024;
// Explicitly exclude credentials, consent tokens, conversations and delivery queues.
const tables={
 users:'id timezone morning_time reminder_minutes revision',
 projects:'owner name', alpha_preferences:'owner project area diet',
 items:'id owner kind title day at duration status version parent_id reminder_minutes created_at',
 item_context:'item_id project area series_id source_key', item_time_meta:'item_id approximate',
 weekly_series:'id owner title days time duration timezone active created_at',
 calendar_filters:'owner calendar_id selected_keys known_keys',
 calendar_items:'item_id owner calendar_id filter_key excluded',
 calendar_connections:'id owner provider calendar_id label created_at enabled_at',
 calendar_links:'connection_id owner remote_id item_id base_local base_remote remote_json state last_checked',
 calendar_conflicts:'id owner connection_id item_id remote_id local_json remote_json local_hash remote_hash status',
 calendar_item_meta:'item_id calendar_connection_id all_day end_day source_day',
 reminders:'id owner item_id kind fire_at event_at status attempts sent_at dedupe',
 ui_profiles:'owner onboarding morning_from',
};
const cols=table=>tables[table].split(' ');
const idValid=owner=>typeof owner==='string'&&/^[1-9]\d{0,19}$/u.test(owner);
const check=(ok,text='Некорректная резервная копия.')=>requireThat(ok,'BACKUP_INVALID',text);
export function createBackup(store,owner,now=new Date().toISOString()){
 check(idValid(owner)&&store.user(owner));
 return store.transaction(()=>{
  const data={};let count=0;
  for(const table of Object.keys(tables)){
   const where=table==='users'?'id=?':cols(table).includes('owner')?'owner=?':'item_id IN (SELECT id FROM items WHERE owner=?)';
   data[table]=store.db.prepare(`SELECT ${cols(table).join(',')} FROM ${table} WHERE ${where} LIMIT 20001`).all(owner).map(row=>({...row}));
   count+=data[table].length;check(count<=20000,'Копия превышает лимит записей; требуется отдельное резервирование.');
  }
  const backup={format:'bob-personal-backup',version:1,owner,createdAt:now,data};
  check(Buffer.byteLength(JSON.stringify(backup))<=BACKUP_LIMIT,'Копия превышает лимит размера.');return backup;
 });
}
export function restoreBackup(store,owner,backup,now=new Date().toISOString()){
 check(idValid(owner)&&backup?.format==='bob-personal-backup'&&backup.version===1&&backup.owner===owner);
 check(Number.isFinite(Date.parse(backup.createdAt))&&Number.isFinite(Date.parse(now)));
 check(Buffer.byteLength(JSON.stringify(backup))<=BACKUP_LIMIT);
 check(backup.data&&Object.keys(backup.data).length===Object.keys(tables).length);
 let count=0;const ids=new Set(),connections=new Set();
 for(const table of Object.keys(tables)){
  const rows=backup.data[table];check(Array.isArray(rows));count+=rows.length;check(count<=20000);
  for(const row of rows){
   check(row&&Object.keys(row).length===cols(table).length&&cols(table).every(col=>Object.hasOwn(row,col)));
   check(Object.values(row).every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)));
   if(cols(table).includes('owner'))check(row.owner===owner);
   if(table==='users')check(row.id===owner);
   if(table==='items'){check(!ids.has(row.id));ids.add(row.id);}
   if(table==='calendar_connections')connections.add(row.id);
  }
 }
 check(backup.data.users.length===1&&backup.data.alpha_preferences.length===1&&backup.data.ui_profiles.length===1);
 for(const [table,rows] of Object.entries(backup.data))for(const row of rows){
  if(row.item_id!==undefined&&row.item_id!==null)check(ids.has(row.item_id));
  if(row.parent_id!==undefined&&row.parent_id!==null)check(ids.has(row.parent_id));
  if(row.connection_id!==undefined)check(connections.has(row.connection_id));
  if(table==='calendar_item_meta')check(connections.has(row.calendar_connection_id));
 }
 const user=backup.data.users[0];new Intl.DateTimeFormat('en',{timeZone:user.timezone}).format();
 check(user.morning_time===null||/^([01]\d|2[0-3]):[0-5]\d$/u.test(user.morning_time));
 return store.transaction(()=>{
  // Refuse overwrite even when a tenant has only closed items or conversation history.
  const existing=store.user(owner);
  check(existing&&existing.revision===0&&!existing.history.length&&!existing.pending,'Восстановление разрешено только в пустое хранилище.');
  check(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n===1);
  const preferences=store.db.prepare('SELECT * FROM alpha_preferences WHERE owner=?').get(owner),profile=store.db.prepare('SELECT * FROM ui_profiles WHERE owner=?').get(owner);
  // A fresh non-admin tenant is initialized with onboarding=1 and morning_from.
  check(!preferences.project&&!preferences.diet&&preferences.area==='Личное'&&[0,1].includes(profile.onboarding),'Хранилище уже настроено.');
  for(const table of Object.keys(tables).filter(t=>!['users','alpha_preferences','ui_profiles'].includes(t))){check(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n===0,'Хранилище уже содержит данные.');}
  for(const table of ['turns','ui_state','action_records','provider_settings','calendar_setups','calendar_receipts'])check(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n===0,'Хранилище уже используется.');
  for(const table of ['telegram_jobs','telegram_outbox']){
   if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))check(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n===0,'Хранилище уже используется.');
  }
  for(const table of ['ui_profiles','alpha_preferences','users'])store.db.prepare(`DELETE FROM ${table} WHERE ${table==='users'?'id':'owner'}=?`).run(owner);
  for(const table of Object.keys(tables))for(const original of backup.data[table]){
   const row={...original};
   // No replay of overdue or previously in-flight notifications, including today's digest.
   if(table==='reminders'&&['pending','claimed'].includes(row.status))row.status=row.fire_at<=now?'skipped':'pending';
   if(table==='ui_profiles')row.morning_from=addDays(dayAt(now,user.timezone),1);
   const names=cols(table);store.db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`).run(...names.map(c=>row[c]));
  }
  // External integrations require fresh credentials and explicit opt-in after recovery.
  store.db.prepare("UPDATE calendar_connections SET status='off',is_default=0,credentials=NULL").run();
  store.db.prepare("UPDATE users SET focus_id=NULL,pending=NULL,history='[]' WHERE id=?").run(owner);
  return {restored:true,owner,items:backup.data.items.length,paused:true,reconnectCalendars:true};
 });
}
