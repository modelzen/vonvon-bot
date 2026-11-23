import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makePool} from '../src/database.mjs';

const bin = process.env.PG_BINDIR ?? execFileSync('pg_config', ['--bindir'], {encoding:'utf8'}).trim();
const dir = mkdtempSync(join(tmpdir(), 'vv-pool-'));
const db = join(dir, 'db');
const run = (name, args) => execFileSync(join(bin, name), args, {stdio:'pipe'});
const url = new URL('postgresql://pool_test@localhost/postgres');
url.searchParams.set('host', dir);
url.searchParams.set('port', '5432');
const pool = makePool(url.href);
let running = false;
try {
  run('initdb', ['-D', db, '-U', 'pool_test', '--auth=trust', '--no-locale']);
  run('pg_ctl', ['-D', db, '-w', '-l', join(dir, 'pg.log'), '-o', "-k '"+dir+"' -p 5432 -c listen_addresses=''", 'start']);
  running = true;
  for (const idle of [false, true]) {
    const client = await pool.connect();
    const {rows:[{pid}]} = await client.query('select pg_backend_pid() as pid');
    const ended = new Promise(resolve => client.once('end', resolve));
    if (idle) client.release();
    run('psql', ['-X', '-h', dir, '-p', '5432', '-U', 'pool_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'select pg_terminate_backend('+Number(pid)+')']);
    await ended;
    if (!idle) client.release();
    const {rows:[fresh]} = await pool.query('select pg_backend_pid() as pid');
    assert.notEqual(fresh.pid, pid);
  }
  console.log('Fresh database connections served queries after both borrowed and idle connections closed.');
} finally {
  await pool.end();
  if (running) run('pg_ctl', ['-D', db, '-m', 'fast', '-w', 'stop']);
  rmSync(dir, {recursive:true, force:true});
}
