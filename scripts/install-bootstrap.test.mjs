import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { linuxInstallCommand } from './install-command.mjs';

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const realCurl = execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();

async function fixture(t, answers) {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-bootstrap-'));
  const bin = join(dir, 'bin'), temporary = join(dir, 'temporary'), result = join(dir, 'selected');
  await mkdir(bin); await mkdir(temporary);
  const events = [], timers = new Set();
  const server = createServer((request, response) => {
    const origin = request.url.slice(1), answer = answers[origin] ?? {};
    const event = { origin, at: Date.now(), closed: false }; events.push(event);
    response.on('close', () => { event.closed = true; });
    if (answer.hang) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const body = answer.installerHangs ? `#!/bin/sh
main() {
  owned=''
  trap 'if [ -n "$owned" ]; then kill "$owned" 2>/dev/null || true; wait "$owned" 2>/dev/null || true; fi' EXIT
  trap 'exit 130' HUP INT TERM
  sleep 30 &
  owned=$!
  printf '%s %s\\n' "$$" "$owned" >${shellQuote(result)}
  wait "$owned"
}
main "$@"
` : answer.body ?? `#!/bin/sh\nmain() { printf '%s\\n' '${origin}' >${shellQuote(result)}; }\nmain "$@"\n`;
      response.writeHead(answer.status ?? 200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
      if (answer.cut) { response.write(body.slice(0, answer.cut)); response.destroy(); }
      else response.end(body);
    }, answer.delay ?? 0);
    timers.add(timer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const original = await readFile(new URL('./install-bootstrap.sh', import.meta.url), 'utf8');
  await writeFile(join(dir, 'bootstrap.sh'), original);
  const domestic = /domestic='([^']+)'/.exec(original)[1], global = /global='([^']+)'/.exec(original)[1];
  await writeFile(join(bin, 'curl'), `#!/bin/sh
proto=''
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in --proto) proto=$2; shift ;; -o) out=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
[ "$proto" = '=https' ] && [ -n "$out" ] || exit 2
case "$url" in ${shellQuote(domestic + '/install.sh')}) origin=domestic ;; ${shellQuote(global + '/install.sh')}) origin=global ;; *) exit 6 ;; esac
exec ${shellQuote(realCurl)} --noproxy '*' -fsS --connect-timeout 5 --max-time 8 --max-filesize 131072 --write-out '%{http_code}' -o "$out" "http://127.0.0.1:${server.address().port}/$origin"
`);
  await chmod(join(bin, 'curl'), 0o755);
  return {
    events,
    selected: () => readFile(result, 'utf8'),
    temporary: () => readdir(temporary),
    start() {
      const child = spawn('/bin/sh', [join(dir, 'bootstrap.sh')], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = once(child, 'close');
      child.stdout.resume(); child.stderr.resume();
      t.after(() => child.kill('SIGTERM'));
      return { child, closed };
    },
    async run() {
      const command = await linuxInstallCommand(), started = Date.now();
      const outcome = await new Promise(resolve => {
        const child = execFile('/bin/sh', ['-s'], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temporary }, timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
        child.stdin.end(command);
      });
      return { ...outcome, elapsed: Date.now() - started, selected: await readFile(result, 'utf8').catch(() => undefined), temporary: await readdir(temporary) };
    },
  };
}

test('bootstrap races real HTTP downloads and runs a complete mirror script without waiting for the stalled domestic source', async t => {
  const f = await fixture(t, { domestic: { hang: true } });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.selected, 'global\n');
  assert.ok(result.elapsed < 3000, JSON.stringify(result));
  assert.ok(f.events.some(event => event.origin === 'domestic' && event.closed), JSON.stringify(f.events));
  assert.deepEqual(result.temporary, []);
});

test('bootstrap prefers domestic when it completes during the short mirror grace window', async t => {
  const f = await fixture(t, { domestic: { delay: 150 } });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.selected, 'domestic\n');
  assert.deepEqual(result.temporary, []);
});

test('bootstrap never executes truncated, syntactically invalid or missing-terminal-marker script bodies', async t => {
  for (const domestic of [{ cut: 20 }, { body: '#!/bin/sh\nmain() {\nmain "$@"\n' }, { body: '#!/bin/sh\nexit 99\n' }, { status: 302 }]) {
    const f = await fixture(t, { domestic, global: { delay: 100 } });
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.selected, 'global\n');
    assert.deepEqual(result.temporary, []);
  }
});

test('bootstrap reports both sources failing without executing anything or retaining temporary files', async t => {
  const f = await fixture(t, { domestic: { status: 503 }, global: { status: 404 } });
  const result = await f.run();
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /未返回完整安装脚本/);
  assert.equal(result.selected, undefined);
  assert.deepEqual(result.temporary, []);
});

test('bootstrap script transports match the installer and its generated command embeds both origins', async () => {
  const script = await readFile(new URL('./install.sh', import.meta.url), 'utf8');
  const command = await linuxInstallCommand();
  assert.ok(command.includes(/^BASE_URL="([^"]+)"$/m.exec(script)[1]));
  assert.ok(command.includes(/^GLOBAL_BASE_URL="([^"]+)"$/m.exec(script)[1]));
  assert.ok(command.startsWith("sh <<'VONVON_INSTALL'\n"));
  assert.ok(command.endsWith('VONVON_INSTALL\n'));
});

test('terminating the bootstrap shell during probes closes both owned HTTP downloads', async t => {
  const f = await fixture(t, { domestic: { hang: true }, global: { hang: true } });
  const { child, closed } = f.start();
  for (const deadline = Date.now() + 3000; f.events.length < 2 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.events.length, 2);
  child.kill('SIGTERM');
  assert.equal((await closed)[0], 130);
  for (const deadline = Date.now() + 1000; f.events.some(event => !event.closed) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(f.events.every(event => event.closed), JSON.stringify(f.events));
  assert.deepEqual(await f.temporary(), []);
});

test('terminating the bootstrap during installer execution stops the installer and its owned child', async t => {
  const f = await fixture(t, { domestic: { installerHangs: true } });
  const { child, closed } = f.start();
  let selected;
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
    selected = await f.selected().catch(() => undefined);
    if (selected) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(selected ?? '', /^\d+ \d+\n$/);
  child.kill('SIGTERM');
  assert.equal((await closed)[0], 130);
  for (const pid of selected.trim().split(' ').map(Number)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await f.temporary(), []);
});
