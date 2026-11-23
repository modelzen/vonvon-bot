import pg from 'pg';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const active = '(expires_at is null or expires_at > now())';
const table = 'release_code_oauth.objects';

const sessionKey = /^[A-Za-z0-9_-]{43}$/;

// A browser logout must invalidate the local cookie even during a database outage.
// Entries contain the public display-session nonce, never the authentication cookie.
export function logoutJournal(directory, removeGrants) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!statSync(directory).isDirectory() || statSync(directory).mode & 0o077)
    throw new Error('Invalid release-code logout journal permissions');
  const pending = new Set(readdirSync(directory));
  if ([...pending].some((id) => !sessionKey.test(id))) throw new Error('Invalid release-code logout journal');
  const unwritten = new Set();
  let flushing;
  let revision = 0;
  function persist(id) {
    try {
      writeFileSync(join(directory, id), '', { mode: 0o600, flush: true });
      unwritten.delete(id);
    } catch {
      unwritten.add(id);
    }
  }
  async function drain() {
    for (const id of pending) {
      if (unwritten.has(id)) persist(id);
      try {
        await removeGrants(id);
      } catch {
        continue;
      }
      try {
        unlinkSync(join(directory, id));
      } catch (error) {
        if (error.code !== 'ENOENT') continue;
      }
      pending.delete(id);
      unwritten.delete(id);
      revision++;
    }
  }
  function flush() {
    if (!flushing && pending.size) {
      flushing = drain().finally(() => {
        flushing = undefined;
      });
    }
    return flushing ?? Promise.resolve();
  }
  const timer = setInterval(flush, 15000);
  timer.unref();
  void flush();
  return {
    contains: (id) => pending.has(id),
    get revision() {
      return revision;
    },
    record(id) {
      if (!sessionKey.test(id)) throw new Error('Invalid browser session');
      pending.add(id);
      persist(id);
      void flush();
    },
    flush,
    close() {
      clearInterval(timer);
    }
  };
}

export function createReleaseCodeStore(connectionString, logoutDirectory) {
  const url = new URL(connectionString);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname)
    throw new Error('Invalid release-code database URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode' || value !== 'verify-full') throw new Error('Unsupported database connection option');
  }
  url.searchParams.delete('sslmode');
  const pool = new pg.Pool({
    connectionString: url.href,
    ssl: local ? undefined : { rejectUnauthorized: true },
    max: 4,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    application_name: 'vonvon-release-code-auth'
  });
  // A broken idle connection is discarded by pg; the next request retries.
  pool.on('error', () => {});
  const query = (sql, args) => pool.query(sql, args);
  const revocations = logoutJournal(logoutDirectory, (id) =>
    query('delete from release_code_oauth.bindings where web_session=$1', [id])
  );
  class Adapter {
    constructor(model) {
      this.model = model;
    }
    async upsert(id, payload, seconds) {
      await query(
        `insert into ${table}(model,id,payload,expires_at)
        values ($1,$2,$3,now()+($4::integer * interval '1 second'))
        on conflict(model,id) do update set payload=excluded.payload ||
        case when ${table}.payload ? 'consumed' then jsonb_build_object('consumed',${table}.payload->'consumed') else '{}'::jsonb end,
        expires_at=excluded.expires_at`,
        [this.model, id, payload, seconds ?? null]
      );
    }
    async lookup(predicate, key) {
      const { rows } = await query(
        `select payload from ${table} where model=$1 and ${predicate}=$2 and ${active}`,
        [this.model, key]
      );
      return rows[0]?.payload;
    }
    find(id) {
      return this.lookup('id', id);
    }
    findByUid(uid) {
      return this.lookup("payload->>'uid'", uid);
    }
    findByUserCode(code) {
      return this.lookup("payload->>'userCode'", code);
    }
    async destroy(id) {
      await query(`delete from ${table} where model=$1 and id=$2`, [this.model, id]);
    }
    async consume(id) {
      const { rowCount } = await query(
        `update ${table} set payload=payload||jsonb_build_object('consumed',floor(extract(epoch from now()))::bigint)
        where model=$1 and id=$2 and not payload ? 'consumed' and ${active}`,
        [this.model, id]
      );
      if (rowCount !== 1) throw new Error('OAuth grant already consumed');
    }
    async revokeByGrantId(id) {
      await query(`delete from ${table} where payload->>'grantId'=$1`, [id]);
      await query('delete from release_code_oauth.bindings where grant_id=$1', [id]);
    }
  }
  const timer = setInterval(async () => {
    try {
      await query(`delete from ${table} where expires_at<=now()`);
      await query('delete from release_code_oauth.bindings where expires_at<=now()');
    } catch {
      /* expired entries are also rejected at read time */
    }
  }, 300000);
  timer.unref();
  return {
    Adapter,
    async bind(grant, account, session, webSession) {
      const { rowCount } = await query(
        `insert into release_code_oauth.bindings
        select $1,$2::uuid,$3::uuid,$4,now()+interval '30 days' where release_code_oauth.active($2,$3)`,
        [grant, account, session, webSession]
      );
      if (rowCount !== 1) throw new Error('Inactive login');
    },
    async validGrant(grant, account) {
      // A revocation can commit while Postgres is returning the old snapshot.
      let revision;
      do {
        revision = revocations.revision;
        const { rows } = await query(
          `select web_session, release_code_oauth.active(account_id,session_id) as ok
          from release_code_oauth.bindings where grant_id=$1 and account_id=$2 and expires_at>now()`,
          [grant, account]
        );
        if (rows[0]?.ok !== true || revocations.contains(rows[0].web_session)) return false;
      } while (revision !== revocations.revision);
      return true;
    },
    logout: revocations.record,
    close() {
      clearInterval(timer);
      revocations.close();
      return pool.end();
    }
  };
}
