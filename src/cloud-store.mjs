import { CoreStore } from './storage.mjs';
export class CloudStore extends CoreStore {
  constructor(storage) {
    super({
      exec: sql => storage.sql.exec(sql),
      prepare: sql => ({
        all: (...args) => storage.sql.exec(sql, ...args).toArray(),
        get: (...args) => storage.sql.exec(sql, ...args).toArray()[0],
        run: (...args) => { const cursor = storage.sql.exec(sql, ...args); return { changes: cursor.rowsWritten }; },
      }),
      transaction: fn => storage.transactionSync(fn),
      close: () => {},
    });
  }
}
