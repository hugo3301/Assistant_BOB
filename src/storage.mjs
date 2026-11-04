import { randomUUID, createHash } from 'node:crypto';
import { requireThat } from './errors.mjs';
export class CoreStore {
  constructor(db) {
    this.db = db;
    this.db.exec('CREATE TABLE IF NOT EXISTS bob_schema(version INTEGER PRIMARY KEY)');
    const version = this.db.prepare('SELECT MAX(version) AS version FROM bob_schema').get().version ?? 1;
    requireThat(version <= 1, 'SCHEMA_NEWER', 'База создана более новой версией BOB.');
    this.db.exec(`      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, timezone TEXT NOT NULL, morning_time TEXT, reminder_minutes INTEGER NOT NULL, focus_id TEXT, revision INTEGER NOT NULL DEFAULT 0, pending TEXT, history TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL, day TEXT, at TEXT, duration INTEGER, status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 1, parent_id TEXT, reminder_minutes INTEGER, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_owner_day ON items(owner,status,day);
      CREATE TABLE IF NOT EXISTS turns(owner TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, hash TEXT NOT NULL, lease TEXT NOT NULL, lease_until TEXT NOT NULL, response TEXT, PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), item_id TEXT, kind TEXT NOT NULL, fire_at TEXT NOT NULL, event_at TEXT, text TEXT, status TEXT NOT NULL DEFAULT 'pending', lease TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_retry TEXT, last_error TEXT, sent_at TEXT, dedupe TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,fire_at,next_retry);
      CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY, spent REAL NOT NULL DEFAULT 0, reserved REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, amount REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(owner TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(owner,name));
      CREATE TABLE IF NOT EXISTS alpha_preferences(owner TEXT PRIMARY KEY, project TEXT, area TEXT NOT NULL DEFAULT 'Личное', diet TEXT);
      CREATE TABLE IF NOT EXISTS item_context(item_id TEXT PRIMARY KEY, project TEXT, area TEXT NOT NULL, series_id TEXT, source_key TEXT);
      CREATE TABLE IF NOT EXISTS item_time_meta(item_id TEXT PRIMARY KEY,approximate INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS weekly_series(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, days TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER NOT NULL, timezone TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_previews(owner TEXT PRIMARY KEY, body TEXT NOT NULL, selected TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_filters(owner TEXT PRIMARY KEY,calendar_id TEXT NOT NULL,selected_keys TEXT NOT NULL,known_keys TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_items(item_id TEXT PRIMARY KEY,owner TEXT NOT NULL,calendar_id TEXT NOT NULL,filter_key TEXT NOT NULL,excluded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ui_views(token TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_state(owner TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_profiles(owner TEXT PRIMARY KEY,onboarding INTEGER NOT NULL DEFAULT 0,morning_from TEXT);
      CREATE TABLE IF NOT EXISTS calendar_item_meta(item_id TEXT PRIMARY KEY,calendar_connection_id TEXT NOT NULL,all_day INTEGER NOT NULL DEFAULT 0,end_day TEXT,source_day TEXT);
      CREATE TABLE IF NOT EXISTS action_records(token TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL);
`);
    this.db.prepare('INSERT OR IGNORE INTO bob_schema VALUES (1)').run();
  }
  close() { this.db.close(); }
  transaction(fn) { return this.db.transaction(fn); }
  ensureUser(owner, settings = {}) {
    requireThat(typeof owner === 'string' && /^[\w:-]{1,100}$/.test(owner), 'INVALID_OWNER', 'Некорректный владелец.');
    this.db.prepare('INSERT OR IGNORE INTO users(id,timezone,morning_time,reminder_minutes) VALUES (?,?,?,?)').run(owner, settings.timezone ?? 'Asia/Tomsk', settings.morningTime ?? null, settings.reminderMinutes ?? 60);
    this.db.prepare('INSERT OR IGNORE INTO alpha_preferences(owner) VALUES (?)').run(owner);
    this.db.prepare('INSERT OR IGNORE INTO ui_profiles(owner) VALUES (?)').run(owner);
    return this.user(owner);
  }
  user(owner) {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(owner);
    return row ? { ...row, pending: row.pending ? JSON.parse(row.pending) : null, history: JSON.parse(row.history) } : null;
  }
  settings(owner, patch) {
    const user = this.user(owner);
    const zone = patch.timezone ?? user.timezone;
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    const morning = Object.hasOwn(patch, 'morningTime') ? patch.morningTime : user.morning_time;
    requireThat(morning === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(morning), 'INVALID_MORNING', 'Укажи время сводки HH:MM.');
    const minutes = patch.reminderMinutes ?? user.reminder_minutes;
    requireThat(Number.isInteger(minutes) && minutes >= 0 && minutes <= 43200, 'INVALID_REMINDER', 'Некорректный интервал напоминания.');
    this.transaction(() => {
      this.db.prepare('UPDATE users SET timezone=?,morning_time=?,reminder_minutes=?,revision=revision+1 WHERE id=?').run(zone, morning, minutes, owner);
      this.db.prepare("UPDATE reminders SET status='cancelled' WHERE owner=? AND kind='morning' AND status IN ('pending','claimed')").run(owner);
    });
    return this.user(owner);
  }
  items(owner, { includeClosed = false } = {}) {
    return this.db.prepare(`SELECT items.*,item_context.project,COALESCE(item_context.area,'Личное') AS area,item_context.series_id,item_context.source_key,COALESCE(item_time_meta.approximate,0) AS approximate,calendar_item_meta.calendar_connection_id,calendar_item_meta.all_day,calendar_item_meta.end_day,calendar_item_meta.source_day FROM items LEFT JOIN item_context ON item_context.item_id=items.id LEFT JOIN item_time_meta ON item_time_meta.item_id=items.id LEFT JOIN calendar_item_meta ON calendar_item_meta.item_id=items.id WHERE items.owner=? ${includeClosed ? '' : "AND items.status='open'"} ORDER BY COALESCE(at,day,'9999'),created_at,id`).all(owner);
  }
  item(owner, id) { return this.db.prepare("SELECT items.*,item_context.project,COALESCE(item_context.area,'Личное') AS area,item_context.series_id,item_context.source_key,COALESCE(item_time_meta.approximate,0) AS approximate,calendar_item_meta.calendar_connection_id,calendar_item_meta.all_day,calendar_item_meta.end_day,calendar_item_meta.source_day FROM items LEFT JOIN item_context ON item_context.item_id=items.id LEFT JOIN item_time_meta ON item_time_meta.item_id=items.id LEFT JOIN calendar_item_meta ON calendar_item_meta.item_id=items.id WHERE items.owner=? AND items.id=?").get(owner, id); }
  beginTurn(owner, requestId, text, now) {
    requireThat(typeof requestId === 'string' && requestId.length <= 150, 'INVALID_REQUEST_ID', 'Некорректный идентификатор сообщения.');
    const hash = createHash('sha256').update(text).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM turns WHERE owner=? AND request_id=?').get(owner, requestId);
      if (previous) {
        requireThat(previous.hash === hash, 'REQUEST_REUSED', 'Этот идентификатор сообщения уже использован для другого текста.');
        if (previous.response) return { cached: JSON.parse(previous.response) };
        requireThat(previous.lease_until <= now, 'TURN_BUSY', 'Это сообщение ещё обрабатывается.');
      }
      const lease = randomUUID();
      this.db.prepare('INSERT INTO turns VALUES (?,?,?,?,?,NULL) ON CONFLICT(owner,request_id) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until').run(owner, requestId, hash, lease, new Date(Date.parse(now) + 180000).toISOString());
      return { lease };
    });
  }
  cachedTurn(owner,requestId,text) {
    const row=this.db.prepare('SELECT hash,response FROM turns WHERE owner=? AND request_id=?').get(owner,requestId);
    if(!row)return null;
    requireThat(row.hash===createHash('sha256').update(text).digest('hex'),'REQUEST_REUSED','Это сообщение уже обработано с другим содержимым.');
    return row.response?{...JSON.parse(row.response),replayed:true}:null;
  }
  finishTurn(owner, requestId, lease, revision, text, response, mutate = () => {}) {
    return this.transaction(() => {
      const turn = this.db.prepare('SELECT * FROM turns WHERE owner=? AND request_id=?').get(owner, requestId);
      requireThat(turn?.lease === lease && !turn.response, 'LEASE_LOST', 'Обработка сообщения уже передана другому процессу.');
      const user = this.user(owner);
      requireThat(user.revision === revision, 'STALE_CONTEXT', 'Данные уже изменились. Повтори запрос по актуальному списку.');
      const before=response.changed>0&&!response.noUndo?this.mutationState(owner):null;
      mutate();
      if(before){const token=this.journal(owner,before,new Date(Date.parse(turn.lease_until)-180000).toISOString());if(token)response={...response,undoToken:token,replyMarkup:response.replyMarkup??{inline_keyboard:[[{text:'↩ Отменить изменение',callback_data:`j|${token}`}]]}};}
      const nextHistory = [...user.history, { user: text, assistant: response.text }].slice(-5);
      this.db.prepare('UPDATE users SET focus_id=?,pending=?,history=?,revision=revision+1 WHERE id=?').run(Object.hasOwn(response, 'focusId') ? response.focusId : user.focus_id, Object.hasOwn(response, 'pending') ? response.pending ? JSON.stringify(response.pending) : null : user.pending ? JSON.stringify(user.pending) : null, JSON.stringify(nextHistory), owner);
      this.db.prepare('UPDATE turns SET response=? WHERE owner=? AND request_id=? AND lease=?').run(JSON.stringify(response), owner, requestId, lease);
      return response;
    });
  }
  mutationState(owner){return{items:this.items(owner,{includeClosed:true}),series:this.db.prepare('SELECT * FROM weekly_series WHERE owner=?').all(owner)};}
  journal(owner,before,now){
    const after=this.mutationState(owner),old=new Map(before.items.map(item=>[item.id,item])),series=new Map(before.series.map(item=>[item.id,item]));
    const items=after.items.filter(item=>item.version!==old.get(item.id)?.version).map(item=>({before:old.get(item.id)??null,id:item.id,version:item.version,status:item.status}));
    const changedSeries=after.series.filter(item=>item.active!==series.get(item.id)?.active).map(item=>({id:item.id,before:series.get(item.id)?.active??0,after:item.active}));
    if(!items.length&&!changedSeries.length)return null;
    const token=randomUUID().replaceAll('-','').slice(0,20),expires=new Date(Date.parse(now)+600000).toISOString();
    const targets=new Set(items.map(item=>item.id)),seriesIds=new Set(changedSeries.map(item=>item.id)),dependents=after.items.filter(item=>!targets.has(item.id)&&(targets.has(item.parent_id)||seriesIds.has(item.series_id))).map(item=>({id:item.id,version:item.version}));
    this.db.prepare('INSERT INTO action_records VALUES (?,?,?,?,?,?)').run(token,owner,JSON.stringify({type:'undo',items,series:changedSeries,dependents}),now,expires,'ready');
    this.db.prepare('DELETE FROM action_records WHERE owner=? AND expires_at<?').run(owner,now);return token;
  }
  undo(owner,token,now){
    const row=this.db.prepare("SELECT * FROM action_records WHERE owner=? AND token=? AND state='ready' AND expires_at>?").get(owner,token,now);requireThat(row,'UNDO_EXPIRED','Это изменение уже отменено или прошло больше 10 минут.');const action=JSON.parse(row.data);requireThat(action.type==='undo','UNDO_EXPIRED','Это действие нельзя отменить.');
    for(const entry of action.items){const item=this.item(owner,entry.id);requireThat(item&&item.version===entry.version&&item.status===entry.status,'UNDO_STALE','После этого дела уже менялись. Автоматическая отмена затронула бы новые правки — открой актуальный список.');}
    for(const entry of action.series){const series=this.db.prepare('SELECT active FROM weekly_series WHERE owner=? AND id=?').get(owner,entry.id);requireThat(series?.active===entry.after,'UNDO_STALE','Серия уже изменилась. Открой актуальный список.');}
    const ids=new Set(action.items.map(item=>item.id)),seriesIds=new Set(action.series.map(item=>item.id)),dependents=new Map((action.dependents??[]).map(item=>[item.id,item.version]));
    for(const item of this.items(owner,{includeClosed:true}).filter(item=>!ids.has(item.id)&&(ids.has(item.parent_id)||seriesIds.has(item.series_id))))requireThat(dependents.get(item.id)===item.version,'UNDO_STALE','После этого появились или изменились связанные дела. Автоматическая отмена их затронет — открой актуальный список.');
    for(const entry of action.items){const item=entry.before;if(!item){this.changeItem(owner,entry.id,{status:'cancelled'},now);continue;}
      this.db.prepare('UPDATE items SET title=?,day=?,at=?,duration=?,status=?,reminder_minutes=?,version=version+1 WHERE owner=? AND id=?').run(item.title,item.day,item.at,item.duration,item.status,item.reminder_minutes,owner,item.id);
      this.db.prepare('INSERT INTO item_time_meta VALUES (?,?) ON CONFLICT(item_id) DO UPDATE SET approximate=excluded.approximate').run(item.id,item.approximate?1:0);this.replaceReminder(owner,item.id,now,item.reminder_minutes);
    }
    for(const entry of action.series)this.db.prepare('UPDATE weekly_series SET active=? WHERE owner=? AND id=?').run(entry.before,owner,entry.id);
    this.db.prepare("UPDATE action_records SET state='undone' WHERE owner=? AND token=?").run(owner,token);return action.items.length;
  }
  putItem(item, now, reminderMinutes) {
    this.db.prepare('INSERT INTO items(id,owner,kind,title,day,at,duration,parent_id,reminder_minutes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(item.id, item.owner, item.kind, item.title, item.day ?? null, item.at ?? null, item.duration ?? null, item.parent_id ?? null, reminderMinutes, now);
    const preferences = this.db.prepare('SELECT project,area FROM alpha_preferences WHERE owner=?').get(item.owner);
    this.db.prepare('INSERT INTO item_context(item_id,project,area,series_id,source_key) VALUES (?,?,?,?,?)').run(item.id, item.project === undefined ? preferences?.project ?? null : item.project, item.area ?? preferences?.area ?? 'Личное', item.series_id ?? null, item.source_key ?? null);
    this.db.prepare('INSERT INTO item_time_meta(item_id,approximate) VALUES (?,?)').run(item.id,item.approximate?1:0);
    this.replaceReminder(item.owner, item.id, now, reminderMinutes);
  }
  changeItem(owner, id, changes, now, reminderMinutes) {
    const item = this.item(owner, id);
    requireThat(item && item.status === 'open', 'ITEM_GONE', 'Дело уже закрыто или отсутствует.');
    const next = { ...item, ...changes, reminder_minutes: reminderMinutes === undefined ? item.reminder_minutes : reminderMinutes };
    this.db.prepare('UPDATE items SET title=?,day=?,at=?,duration=?,status=?,reminder_minutes=?,version=version+1 WHERE owner=? AND id=?').run(next.title, next.day, next.at, next.duration, next.status, next.reminder_minutes, owner, id);
    if(Object.hasOwn(changes,'approximate'))this.db.prepare('INSERT INTO item_time_meta VALUES (?,?) ON CONFLICT(item_id) DO UPDATE SET approximate=excluded.approximate').run(id,changes.approximate?1:0);
    this.replaceReminder(owner, id, now, next.reminder_minutes);
  }
  replaceReminder(owner, id, now, minutes) {
    this.db.prepare("UPDATE reminders SET status='cancelled' WHERE owner=? AND item_id=? AND status IN ('pending','claimed')").run(owner, id);
    const item = this.item(owner, id);
    if (item.status !== 'open' || !item.at || minutes === null) return;
    const due = new Date(Math.max(Date.parse(now), Date.parse(item.at) - minutes * 60000)).toISOString();
    if (item.at <= now) return;
    this.db.prepare('INSERT OR IGNORE INTO reminders(id,owner,item_id,kind,fire_at,event_at,dedupe) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), owner, id, 'item', due, item.at, `item:${owner}:${id}:${item.version}`);
  }
  pendingReminders(owner) { return this.db.prepare('SELECT * FROM reminders WHERE owner=? ORDER BY fire_at').all(owner); }
  reserveBudget(now, amount, limit) {
    return this.transaction(() => {
      const day = now.slice(0, 10), id = randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO budget(day) VALUES (?)').run(day);
      const current = this.db.prepare('SELECT * FROM budget WHERE day=?').get(day);
      requireThat(current.spent + current.reserved + amount <= limit, 'AI_BUDGET', 'Достигнут локальный лимит ИИ. Команды и сохранённые напоминания продолжают работать.');
      this.db.prepare('UPDATE budget SET reserved=reserved+? WHERE day=?').run(amount, day);
      this.db.prepare('INSERT INTO reservations VALUES (?,?,?)').run(id, day, amount);
      return id;
    });
  }
  settleBudget(id, observed = null) {
    this.transaction(() => {
      const reservation = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
      if (!reservation) return;
      const spent = Number.isFinite(observed) && observed >= 0 ? observed : reservation.amount;
      this.db.prepare('UPDATE budget SET reserved=MAX(0,reserved-?),spent=spent+? WHERE day=?').run(reservation.amount, spent, reservation.day);
      this.db.prepare('DELETE FROM reservations WHERE id=?').run(id);
    });
  }
  usage(day) { return this.db.prepare('SELECT * FROM budget WHERE day=?').get(day) ?? { day, spent: 0, reserved: 0 }; }
}
