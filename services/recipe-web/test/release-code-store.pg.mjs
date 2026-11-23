import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, mkdtemp } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createReleaseCodeStore } from '../release-code-store.mjs';

// Run only against a new, empty database. Fixtures are deliberately not installed in an existing schema.
test('Postgres grant storage checks the active mapped account and login session on every renewal', async (t) => {
  const database = process.env.TEST_RELEASE_CODE_DATABASE_URL;
  assert.ok(database, 'Set TEST_RELEASE_CODE_DATABASE_URL to a dedicated empty local database');
  const admin = new pg.Client(database);
  await admin.connect();
  t.after(() => admin.end());
  const { rows } = await admin.query(
    "select current_schema() as schema,to_regnamespace('recipe_private') as existing,to_regnamespace('auth') as auth"
  );
  assert.deepEqual(rows, [{ schema: 'public', existing: null, auth: null }]);
  await admin.query(`create schema auth; create schema recipe_private;
    create table auth.users(id uuid primary key, deleted_at timestamptz, is_anonymous boolean,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
    create table recipe_private.accounts(id uuid primary key,status text);
    create table recipe_private.account_identities(account_id uuid,issuer text,subject uuid);
    create table recipe_private.identity_deployment(issuer text);`);
  const schema = await readFile(new URL('../release-code-oauth.sql', import.meta.url), 'utf8');
  await admin.query(schema);
  await admin.query(schema);
  const account = randomUUID(),
    sid = randomUUID(),
    subject = randomUUID();
  await admin.query("insert into recipe_private.accounts values($1,'active')", [account]);
  await admin.query("insert into recipe_private.identity_deployment values('test')");
  await admin.query("insert into recipe_private.account_identities values($1,'test',$2)", [account, subject]);
  await admin.query('insert into auth.users values ($1,null,false,null)', [subject]);
  await admin.query('insert into auth.sessions values ($1,$2,null)', [sid, subject]);
  await admin.query('create role vv_test_oauth_login login in role release_code_auth');
  const url = new URL(database);
  url.username = 'vv_test_oauth_login';
  const journal = await mkdtemp(join(tmpdir(), 'vonvon-code-logouts-'));
  const webSession = 'w'.repeat(43);
  const store = createReleaseCodeStore(url.href, journal);
  t.after(() => store.close());
  await store.bind('grant', account, sid, webSession);
  assert.equal(await store.validGrant('grant', account), true);
  const sessions = new store.Adapter('Session');
  await sessions.upsert('a', { uid: 'one' }, 5);
  await sessions.upsert('a', { uid: 'two' }, 5);
  assert.equal(await sessions.findByUid('one'), undefined);
  assert.deepEqual(await sessions.find('a'), { uid: 'two' });
  const codes = new store.Adapter('DeviceCode');
  await codes.upsert('a', { userCode: '12345', grantId: 'grant' }, 60);
  await Promise.allSettled([codes.consume('a'), codes.consume('a')]).then((results) =>
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  );
  assert.ok((await codes.findByUserCode('12345')).consumed);
  await admin.query("update recipe_private.accounts set status='disabled' where id=$1", [account]);
  assert.equal(await store.validGrant('grant', account), false);
  await admin.query("update recipe_private.accounts set status='active'");
  await store.logout(webSession);
  assert.equal(await store.validGrant('grant', account), false);
  await store.bind('another-grant', account, sid, 'x'.repeat(43));
  await admin.query('delete from auth.sessions');
  assert.equal(await store.validGrant('another-grant', account), false);
  await codes.revokeByGrantId('grant');
  assert.equal(await codes.find('a'), undefined);
});
