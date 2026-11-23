import { DatabaseSync } from 'node:sqlite';

// This is the entire stored access record. No queries, paths, credentials, or response bodies.
export function usageStore(file, { maxCallsPerHour = 240 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS calls (' +
      'hour INTEGER NOT NULL, account TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL,' +
      'PRIMARY KEY (account, hour, tool)) WITHOUT ROWID'
  );
  const total = db.prepare('SELECT coalesce(sum(calls),0) AS total FROM calls WHERE account=? AND hour=?');
  const increment = db.prepare(
    'INSERT INTO calls VALUES(?,?,?,1) ON CONFLICT(account,hour,tool) DO UPDATE SET calls=calls+1'
  );
  return {
    take(account, tool, now = Date.now()) {
      const hour = Math.floor(now / 3600000);
      db.exec('BEGIN IMMEDIATE');
      try {
        const allowed = total.get(account, hour).total < maxCallsPerHour;
        if (allowed) increment.run(hour, account, tool);
        db.exec('COMMIT');
        return allowed;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
