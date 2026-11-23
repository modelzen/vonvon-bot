import pg from 'pg';
import { loopback } from './auth.mjs';
import { ApiError } from './errors.mjs';
import { authorizationMaterial, binary32 } from './install-proof.mjs';
import { authoringMaterial } from './authoring-proof.mjs';

// Static parameterized calls. No request field becomes an SQL identifier.
const calls = Object.freeze({
  readerLatest: 'recipe_api.reader_latest($1::uuid)',
  readerLibrary: 'recipe_api.reader_library($1::uuid)',
  readerPublications: 'recipe_api.reader_publications()',
  readerDrafts: 'recipe_api.reader_drafts()',
  readerAcquire: 'recipe_api.reader_acquire($1::uuid,$2::text,$3::text)',
  me: 'recipe_api.me()',
  catalog: 'recipe_api.catalog($1::text, $2::uuid)',
  versionDetail: 'recipe_api.version_detail($1::uuid, $2::uuid)',
  getDraft: 'recipe_api.get_draft($1::uuid)',
  listDrafts: 'recipe_api.list_drafts()',
  saveDraft: 'recipe_api.save_draft($1::uuid,$2::int,$3::jsonb,$4::jsonb,$5::uuid,$6::uuid,$7::uuid)',
  deleteDraft: 'recipe_api.delete_draft($1::uuid,$2::int,$3::uuid)',
  publishDraft: 'recipe_api.publish_draft($1::uuid,$2::int,$3::uuid)',
  library: 'recipe_api.library($1::uuid)',
  publications: 'recipe_api.publications()',
  acquire: 'recipe_api.acquire($1::uuid,$2::text,$3::text)',
  issueCodes: 'recipe_api.issue_codes($1::uuid,$2::int,$3::uuid)',
  listCodes: 'recipe_api.list_codes($1::uuid,$2::uuid)',
  disableCode: 'recipe_api.disable_code($1::uuid)',
  revealCode: 'recipe_api.reveal_code($1::uuid)',
  unredeemableOperation: 'recipe_api.unredeemable_operation($1::uuid,$2::uuid)',
  latestInstallVersion: 'recipe_api.latest_install_version($1::uuid)',
  installPreview: 'recipe_api.install_preview($1::uuid)',
  authorizeOperation: 'recipe_api.authorize_operation($1::uuid,$2::jsonb,$3::bytea,$4::bytea,$5::bytea,$6::bigint)',
  cancelOperation: 'recipe_api.cancel_operation($1::uuid)',
  redeemOperation: 'recipe_api.possess_operation($1::uuid,$2::bytea,$3::bytea,$4::bytea)',
  completeOperation: 'recipe_api.possess_operation($1::uuid,$2::bytea,$3::bytea,$4::bytea,$5::text)',
  sourceHistory: 'recipe_api.source_history($1::uuid[])',
  registerAuthoring: 'recipe_api.register_authoring($1::uuid,$2::jsonb)',
  recoverAuthoring: 'recipe_api.recover_authoring($1::uuid)',
  getAuthoring: 'recipe_api.get_authoring($1::uuid)',
  cancelAuthoring: 'recipe_api.cancel_authoring($1::uuid)',
  authorizeAuthoring: 'recipe_api.authorize_authoring($1::uuid,$2::jsonb,$3::bytea,$4::bytea,$5::bytea,$6::bigint)',
  dispatchAuthoring: "recipe_api.possess_authoring($1::uuid,$2::bytea,$3::bytea,$4::bytea,$5::bytea,'dispatch')",
  acceptAuthoring: "recipe_api.possess_authoring($1::uuid,$2::bytea,$3::bytea,$4::bytea,$5::bytea,'accept')",
  patchDraft: 'recipe_api.patch_draft($1::uuid,$2::jsonb,$3::uuid)',
});

const businessErrors = new Map(Object.entries({
  source_unavailable:403, object_unavailable:409, object_capacity:429, object_stream_limit:429,
  auth_required: 401, account_disabled: 403, not_found: 404, forbidden: 403, invalid_input: 422, incomplete_setup: 422,
  conflict: 409, quota_exceeded: 422, rate_limited: 429, invalid_code: 422,
  operation_pending_limit: 429, operation_expired: 410, operation_clock_skew: 422,
  operation_cancelled: 409, invalid_operation_proof: 403,
  proposal_active: 409, acquire_rate_limited: 429, request_upgrade_required: 409, integrity_error: 503,
}));

export function makePool(connectionString) {
  const url = new URL(connectionString);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Invalid RECIPE_DATABASE_URL');
  }
  const local = loopback(url.hostname);
  // pg also accepts a host override and TLS options in the query string.
  // Only a loopback URL may point at a local Unix socket (used by isolated tests).
  for (const [key, value] of url.searchParams) {
    if (local && key === 'host' && value.startsWith('/')) continue;
    if (local && key === 'port' && /^\d+$/.test(value)) continue;
    if (!local && key === 'sslmode' && value === 'verify-full') continue;
    throw new Error('Unsupported database connection option');
  }
  if (!local) url.searchParams.delete('sslmode');
  return new pg.Pool({
    connectionString: url.toString(), ssl: local ? undefined : { rejectUnauthorized: true },
    max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    application_name: 'vonvon-recipe-api',
  });
}

export async function openDatabase(url, codeKey, issuer) {
  if (!/^[0-9a-f]{64}$/i.test(codeKey)) throw new Error('Invalid RECIPE_CODE_KEY');
  const pool = makePool(url);
  pool.on('error', () => console.error('Recipe database connection unavailable'));
  try {
    const { rows: [role] } = await pool.query(`
      SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
             AND NOT r.rolcreatedb AND NOT r.rolreplication
             AND NOT pg_has_role(session_user, d.datdba, 'MEMBER')
             AND pg_has_role(session_user, 'recipe_api', 'MEMBER')
             AND NOT api.rolsuper AND NOT api.rolbypassrls AND NOT api.rolcreaterole
             AND NOT api.rolcreatedb AND NOT api.rolreplication AND NOT api.rolcanlogin
             AND NOT EXISTS (
               SELECT FROM pg_roles AS inherited
               WHERE inherited.rolname NOT IN (session_user, 'recipe_api')
                 AND pg_has_role(session_user, inherited.oid, 'MEMBER')
             ) AS ok
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      JOIN pg_roles api ON api.rolname='recipe_api'
      WHERE r.rolname=session_user`);
    if (!role?.ok) throw new Error('Database login must be dedicated to recipe_api');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE recipe_api');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT recipe_api.bind_identity_issuer($1::text)', [issuer]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    await pool.end();
    throw err;
  }

  async function execute(identity, operation, args = []) {
    if (pool.waitingCount >= 32) throw new ApiError(503, 'database_unavailable', 1);
    let client;
    let discard = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE recipe_api');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SELECT set_config('app.recipe_account','',true), set_config('app.recipe_code_key',$1,true)", [codeKey]);
      if (identity) {
        const { rows: [mapped] } = await client.query('SELECT recipe_api.resolve_identity($1::text,$2::uuid) AS account_id',
          [identity.issuer, identity.subject]);
        await client.query("SELECT set_config('app.recipe_account',$1,true)", [mapped.account_id]);
      }
      if (operation.startsWith('rich')) {
        const {richExecute}=await import('./rich-database.mjs');
        const result=await richExecute(client,operation,args);
        await client.query('COMMIT');return result;
      }
      if (operation === 'authorizeOperation') {
        const { rows:[context] } = await client.query('SELECT recipe_api.operation_context() AS result');
        const [operationId, request] = args;
        const { accountId, deadline } = context.result;
        const material = authorizationMaterial({ ...request, operationId, accountId, deadline });
        args = [operationId, request, binary32(material.serverPublicKey), material.ticket, material.proofHash, deadline];
      }
      if (operation === 'authorizeAuthoring') {
        const [operationId, request] = args;
        const { rows:[context] } = await client.query('SELECT recipe_api.authoring_context($1::uuid,$2::jsonb) AS result', args);
        const material = authoringMaterial(context.result);
        args = [operationId, request, binary32(material.serverPublicKey), material.ticket, material.proofHash, context.result.deadline];
      }
      const { rows } = await client.query('SELECT ' + calls[operation] + ' AS result', args);
      await client.query('COMMIT');
      return rows[0].result;
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); }
        catch { discard = true; }
      }
      if (err instanceof ApiError) throw err;
      if (err.code === 'P0001' && businessErrors.has(err.message)) {
        // SQL publishing/issuing quotas use UTC calendar days.
        const dayMs = 86_400_000;
        const retryAfter = err.message === 'acquire_rate_limited'
          ? (/^[1-9][0-9]{0,12}$/.test(err.detail ?? '') && Number.isSafeInteger(Number(err.detail)) ? Number(err.detail) : undefined)
          : err.message === 'rate_limited'
          ? Math.ceil((dayMs - Date.now() % dayMs) / 1000) : err.message === 'operation_pending_limit' ? 300 : undefined;
        throw new ApiError(businessErrors.get(err.message), err.message, retryAfter);
      }
      // Database internals and rejected query parameters can contain private text or codes.
      throw new ApiError(503, 'database_unavailable');
    } finally {
      if (client) client.release(discard);
    }
  }
  return { execute, close: () => pool.end() };
}
