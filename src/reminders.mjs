import { randomUUID } from 'node:crypto';
import { dayAt, localToUtc, formatDate } from './dates.mjs';
import { overview } from './views.mjs';

export class ReminderWorker {
  constructor(store, { clock = () => new Date().toISOString(), maxAttempts = 5 } = {}) { this.store = store; this.clock = clock; this.maxAttempts = maxAttempts; }
  queueMornings(now) {
    for (const user of this.store.db.prepare('SELECT * FROM users WHERE morning_time IS NOT NULL').all()) {
      const day = dayAt(now, user.timezone);
      let fire;
      try { fire = localToUtc(day, user.morning_time, user.timezone); } catch { continue; }
      if (fire > now || Date.parse(now) - Date.parse(fire) > 8 * 3600000) continue;
      this.store.db.prepare('INSERT OR IGNORE INTO reminders(id,owner,kind,fire_at,text,dedupe) VALUES (?,?,?,?,?,?)').run(randomUUID(), user.id, 'morning', fire, overview(this.store, user.id, 'today', now), `morning:${user.id}:${day}:${user.timezone}`);
    }
  }
  claim(now) {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM reminders WHERE fire_at<=? AND ((status='pending' AND (next_retry IS NULL OR next_retry<=?)) OR (status='claimed' AND lease_until<=?)) ORDER BY fire_at LIMIT 1").get(now, now, now);
      if (!row) return null;
      const token = randomUUID();
      this.store.db.prepare("UPDATE reminders SET status='claimed',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, new Date(Date.parse(now) + 120000).toISOString(), row.id);
      return { ...row, lease: token, attempts: row.attempts + 1 };
    });
  }
  async tick(send, { limit = 20 } = {}) {
    const now = this.clock();
    this.queueMornings(now);
    const results = [];
    for (let i = 0; i < limit; i++) {
      const row = this.claim(this.clock());
      if (!row) break;
      const current = this.store.db.prepare('SELECT status,lease FROM reminders WHERE id=?').get(row.id);
      if (current.status !== 'claimed' || current.lease !== row.lease) continue;
      const item = row.item_id ? this.store.item(row.owner, row.item_id) : null;
      if ((row.item_id && (!item || item.status !== 'open' || item.at !== row.event_at || row.event_at <= this.clock())) || (row.kind === 'morning' && Date.parse(this.clock()) - Date.parse(row.fire_at) > 8 * 3600000)) {
        this.store.db.prepare("UPDATE reminders SET status='skipped' WHERE id=? AND lease=?").run(row.id, row.lease);
        results.push({ id: row.id, status: 'skipped' }); continue;
      }
      const user = this.store.user(row.owner);
      const text = item ? `Бро, ${item.kind === 'task' ? 'приближается срок: ' : 'скоро '}${item.title} — ${formatDate(item.day, item.at, user.timezone)}.` : overview(this.store, row.owner, 'today', this.clock());
      try {
        await send({ id: row.id, owner: row.owner, text, dedupeKey: row.dedupe });
        this.store.db.prepare("UPDATE reminders SET status='sent',sent_at=? WHERE id=? AND lease=? AND status='claimed'").run(this.clock(), row.id, row.lease);
        results.push({ id: row.id, status: 'sent' });
      } catch (error) {
        const failed = row.attempts >= this.maxAttempts;
        const delay = Math.max(Math.min(300000, 5000 * 2 ** (row.attempts - 1)), Math.min(86400000, Number(error?.retryAfter ?? 0) * 1000));
        this.store.db.prepare('UPDATE reminders SET status=?,next_retry=?,last_error=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND status=\'claimed\'').run(failed ? 'failed' : 'pending', new Date(Date.parse(this.clock()) + delay).toISOString(), 'DELIVERY_FAILED', row.id, row.lease);
        results.push({ id: row.id, status: failed ? 'failed' : 'retry' });
      }
    }
    return results;
  }
}
