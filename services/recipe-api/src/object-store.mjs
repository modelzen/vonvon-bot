import { ApiError, UUID } from './errors.mjs';

const rowCalls = new Set(['member','open_member','ready']);
const calls = new Set([...rowCalls, 'start_write','saw_bytes','saw_absence','begin_delete','end_ingress',
  'close_package','inventory','pin_backup','prune_closed','confirm_quiescence','pending_cleanup','storage_absent','business_actor','read_descriptor','record_text_check']);
const limit = code => new ApiError(429, code, 10);

export function objectPackageScope(actor, operationId) {
  if (typeof actor !== 'string' || actor.length !== 36 || !UUID.test(actor) ||
      typeof operationId !== 'string' || operationId.length !== 36 || !UUID.test(operationId)) {
    throw new ApiError(422,'invalid_object_member');
  }
  return [actor.toLowerCase(),operationId.toLowerCase()];
}

export function objectMemberScope(actor, operationId, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 65) {
    throw new ApiError(422,'invalid_object_member');
  }
  return [...objectPackageScope(actor,operationId),ordinal];
}

export async function createObjectStore(pool) {
  const {rows:[login]} = await pool.query(`
    select not exists(select from pg_roles r where pg_has_role(session_user,r.oid,'member')
        and (r.rolname not in (session_user,'recipe_object_verifier') or r.rolbypassrls or r.rolsuper
          or r.rolcreaterole or r.rolreplication or r.rolcreatedb)) and
      pg_has_role(session_user,'recipe_object_verifier','member')
      and not (select rolcanlogin from pg_roles where rolname='recipe_object_verifier')
      and not pg_has_role(session_user,d.datdba,'member') as dedicated
    from pg_database d where d.datname=current_database()`);
  if (!login?.dedicated) throw new Error('object_verifier_login_required');
  async function transaction(client, fn) {
    await client.query('begin');
    try {
      await client.query('set local role recipe_object_verifier');
      await client.query("set local statement_timeout='5s'");
      const result = await fn();
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      if (['object_capacity','object_stream_limit'].includes(error.message)) throw limit(error.message);
      throw error;
    }
  }

  function session(client) {
    return async (verb,...args) => {
      if (!calls.has(verb)) throw new Error('unknown_object_call');
      const params = args.map((_,i) => '$' + (i+1)).join(',');
      const expr = 'recipe_objects.' + verb + '(' + params + ')';
      const sql = rowCalls.has(verb) ? 'select to_jsonb(m) as result from ' + expr + ' m' : 'select ' + expr + ' as result';
      return transaction(client, async () => (await client.query(sql,args)).rows[0].result);
    };
  }

  async function connect() {
    if (pool.waitingCount >= 32) throw new ApiError(503,'object_broker_busy',1);
    return pool.connect();
  }

  return {
    async call(verb,...args) {
      const client = await connect();
      try { return await session(client)(verb,...args); }
      finally { client.release(); }
    },
    async withMember(actor, operationId, ordinal, work) {
      const scope = objectMemberScope(actor,operationId,ordinal);
      const client = await connect();
      const key = scope.join('/');
      let locked = false;
      let discard = false;
      try {
        const lock = await client.query('select pg_try_advisory_lock(hashtextextended($1,187519)) as held',[key]);
        locked = lock.rows[0].held;
        if (!locked) throw new ApiError(409,'object_member_busy',1);
        return await work(session(client));
      } finally {
        try {
          if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1,187519))',[key]);
        } catch { discard = true; }
        client.release(discard);
      }
    },
  };
}
