import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CoreStore } from './storage.mjs';
export class Store extends CoreStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const sqlite = new DatabaseSync(path);
    sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    super({ prepare: sql => sqlite.prepare(sql), exec: sql => sqlite.exec(sql), close: () => sqlite.close(), transaction: fn => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = fn(); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } });
  }
}
