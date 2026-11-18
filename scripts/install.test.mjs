// install.sh and uninstall.sh (docs/plans/server-2-install-scripts.md 5.1), run for real by sh in a temporary HOME. The
// network is a curl stand-in that reads a directory, the package is a fake whose vonvon.mjs records each call and answers
// from scenario.json, and the manifest is signed with a key made here. No service manager is touched.
// main 必败: neither script exists on main.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { text as streamText } from 'node:stream/consumers';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_TARGETS, archiveName, tarHeader, writeTarGz } from './build-server.mjs';
import { fileEntries } from './package-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://dl.vonvon.cc/bot/server';
const GLOBAL = /^GLOBAL_BASE_URL="([^"]+)"$/m.exec(await readFile(new URL('./install.sh', import.meta.url), 'utf8'))[1];
const SH = '/bin/sh';
/** The launcher __standalone-setup writes (packages/daemon/src/cli/commands/standalone-setup.ts), checked below. */
const LAUNCHER = '#!/bin/sh\n# Vonvon Bot server CLI v1\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"\nPATH="$root/current/node/bin:$PATH"\nexport PATH\nexec "$root/current/node/bin/node" "$root/current/app/bin/vonvon.mjs" "$@"\n';
/** Whether install.sh, run with the fixture's PATH below, finds OpenSSL 3: macOS has LibreSSL in /usr/bin, Homebrew's is elsewhere. */
const openssl3 = (() => { try { return /^OpenSSL [3-9]/.test(execFileSync('openssl', ['version'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } })); } catch { return false; } })();
const availableOpenSSL = (() => {
  try {
    const executable = execFileSync('/bin/sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).trim();
    return /^OpenSSL [3-9]/.test(execFileSync(executable, ['version'], { encoding: 'utf8' })) ? executable : undefined;
  } catch { return undefined; }
})();

/**
 * The fake app/bin/vonvon.mjs: records its arguments; setup switches `current` and writes the launcher for real. A
 * scenario answer for setup with `afterSwitch` switches `current` first and then answers, as the real one does when it
 * cannot write the launcher.
 */
const fakeCli = base => `import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const base = ${JSON.stringify(base)};
const args = process.argv.slice(2);
appendFileSync(join(base, 'calls.log'), args.join(' ') + '\\n');
const key = args[0] === 'service' || args[0] === 'daemon' ? args.slice(0, 2).join(' ') : args[0];
let scenario = {};
try { scenario = JSON.parse(readFileSync(join(base, 'scenario.json'), 'utf8')); } catch {}
if (key === '__standalone-setup' && (!scenario[key] || scenario[key].afterSwitch)) {
  const root = args[args.indexOf('--install-root') + 1];
  const version = args[args.indexOf('--release') + 1];
  rmSync(join(root, 'current.next'), { force: true });
  symlinkSync('releases/' + version, join(root, 'current.next'));
  renameSync(join(root, 'current.next'), join(root, 'current'));
  if (scenario[key]) {
    process.stdout.write(scenario[key].stdout + '\\n');
    process.exit(scenario[key].exit ?? 0);
  }
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'vonvon.tmp'), ${JSON.stringify(LAUNCHER)}, { mode: 0o755 });
  renameSync(join(root, 'bin', 'vonvon.tmp'), join(root, 'bin', 'vonvon'));
  process.stdout.write(JSON.stringify({ ok: true, version, previous: null, launcher: join(root, 'bin', 'vonvon'), pathFiles: [], pathAlreadyOnPath: false }) + '\\n');
  process.exit(0);
}
const answer = scenario[key] ?? (key === '--version' ? { stdout: '1.0.0' } : { stdout: '{"ok":true}' });
process.stdout.write((answer.stdout ?? '') + '\\n');
process.exit(answer.exit ?? 0);
`;

const shim = async (dir, name, body) => { await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`); await chmod(join(dir, name), 0o755); };

async function fixture(t, { uname = ['Linux', 'x86_64'] } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const cdn = join(base, 'cdn');
  const globalCdn = join(base, 'global');
  const shims = join(base, 'shims');
  const scripts = join(base, 'scripts');
  for (const dir of [home, cdn, shims, scripts]) await mkdir(dir, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const original = await readFile(join(here, 'install.sh'), 'utf8');
  const block = /# BEGIN VONVON PUBKEY\n[^]*?# END VONVON PUBKEY\n/;
  assert.match(original, block);
  await writeFile(join(scripts, 'install.sh'), original.replace(block, `# BEGIN VONVON PUBKEY\nPUBKEY_PEM='${pem}'\n# END VONVON PUBKEY\n`));
  await writeFile(join(scripts, 'uninstall.sh'), await readFile(join(here, 'uninstall.sh')));
  await shim(shims, 'curl', `printf '%s\\n' "$*" >> '${shims}/curl.log'
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
case "$url" in ${BASE}/*) source='${cdn}/'"\${url#${BASE}/}" ;; ${GLOBAL}/*) source='${globalCdn}/'"\${url#${GLOBAL}/}" ;; *) exit 6 ;; esac
[ -f "$source" ] || exit 22
cp "$source" "$out"
printf '200'`);
  const setUname = async ([system, machine]) => shim(shims, 'uname', `case "$1" in -s) echo '${system}' ;; -m) echo '${machine}' ;; *) echo '${system}' ;; esac`);
  await setUname(uname);
  const root = join(home, '.local', 'share', 'vonvon-bot', 'server');
  const f = {
    base, home, cdn, globalCdn, shims, root, keys, setUname,
    mirror: () => cp(cdn, globalCdn, { recursive: true }),
    async network(scenario) {
      // The stand-in is the curl process itself (no child sleep), so loser cancellation is observable.
      await writeFile(join(shims, 'curl'), `#!${process.execPath}\n` + `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), url = args.find(arg => arg.startsWith('https://'));
const out = args[args.indexOf('-o') + 1];
const origin = url?.startsWith(${JSON.stringify(BASE + '/')}) ? 'domestic' : url?.startsWith(${JSON.stringify(GLOBAL + '/')}) ? 'global' : '';
if (!origin || !out) process.exit(6);
const kind = url.endsWith('/stable/manifest.json') ? 'manifest' : 'package';
const event = { origin, kind, url, pid: process.pid, at: Date.now() };
fs.appendFileSync(${JSON.stringify(join(base, 'network-events.jsonl'))}, JSON.stringify(event) + '\\n');
fs.appendFileSync(${JSON.stringify(join(shims, 'curl.log'))}, args.join(' ') + '\\n');
const answer = ${JSON.stringify(scenario)}[origin]?.[kind] ?? {};
setTimeout(() => {
  const prefix = origin === 'domestic' ? ${JSON.stringify(BASE)} : ${JSON.stringify(GLOBAL)};
  const directory = origin === 'domestic' ? ${JSON.stringify(cdn)} : ${JSON.stringify(globalCdn)};
  const file = path.join(directory, url.slice(prefix.length + 1));
  if (!fs.existsSync(file)) process.exit(22);
  let body = fs.readFileSync(file);
  if (answer.corrupt) body[0] ^= 1;
  if (answer.partial) body = body.subarray(0, answer.partial);
  fs.writeFileSync(out, body);
  process.stdout.write(String(answer.status ?? 200));
  process.exit(answer.code ?? 0);
}, answer.delay ?? 0);
`);
      await chmod(join(shims, 'curl'), 0o755);
    },
    events: async () => (await readFile(join(base, 'network-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    path: `${shims}:/usr/bin:/bin`,
    /** A package for `target` from a fake tree; `extra` adds archive members by hand (name → body or { link }). */
    async release(version = '1.0.0', target = 'linux-x64', { extra = [], tree = {} } = {}) {
      const dir = join(base, `tree-${version}-${target}`);
      const files = {
        'standalone.json': `${JSON.stringify({ v: 1, version, target, node: 'test' }, null, 2)}\n`,
        'app/package.json': JSON.stringify({ name: '@vonvon/daemon', version }),
        'app/bin/vonvon.mjs': fakeCli(base),
        'node/bin/node': `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
        ...tree,
      };
      for (const [name, body] of Object.entries(files)) {
        if (body === null) continue;
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), body);
      }
      if (files['node/bin/node'] !== null) await chmod(join(dir, 'node/bin/node'), 0o755);
      const out = join(cdn, version, archiveName(version, target));
      await mkdir(dirname(out), { recursive: true });
      await writeTarGz(dir, await fileEntries(dir), out, 1_700_000_000);
      if (extra.length) {
        // more members after the good ones, before the end-of-archive blocks
        const { gunzipSync, gzipSync } = await import('node:zlib');
        const tar = gunzipSync(await readFile(out));
        const members = extra.map(({ name, body = '', link }) => {
          const data = Buffer.from(body);
          const header = tarHeader(name, link ? 0 : data.length, 0o644, 1_700_000_000);
          if (link) {
            header.write('2', 156, 'ascii');
            header.write(link, 157, 'utf8');
            header.fill(' ', 148, 156);
            let sum = 0;
            for (const byte of header) sum += byte;
            Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
            return header;
          }
          return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
        });
        await writeFile(out, gzipSync(Buffer.concat([tar.subarray(0, tar.length - 1024), ...members, Buffer.alloc(1024)])));
      }
      const bytes = await readFile(out);
      return { sha512: createHash('sha512').update(bytes).digest('hex'), size: bytes.length };
    },
    /** The C1 payload for `version`, `file` describing `target`'s package; the other Linux one is a placeholder. */
    payload(version, target, file) {
      const files = Object.fromEntries(PUBLISHED_TARGETS.map(name => [name, name === target ? { url: `${BASE}/${version}/${archiveName(version, name)}`, ...file } : { url: `${BASE}/${version}/${archiveName(version, name)}`, sha512: 'a'.repeat(128), size: 1 }]));
      return { schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt: 1_800_000_000_000, files };
    },
    async publish(payload, key = keys.privateKey) {
      const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      await mkdir(join(cdn, 'stable'), { recursive: true });
      await writeFile(join(cdn, 'stable', 'manifest.json'), JSON.stringify({ payload: bytes.toString('base64'), signature: sign(null, bytes, key).toString('base64') }));
    },
    /** A release and its manifest, the usual case. */
    async ready(version = '1.0.0', target = 'linux-x64', options = {}) {
      const file = await f.release(version, target, options);
      await f.publish(f.payload(version, target, file));
      return file;
    },
    /** The unit `service install` would have written for ~/.vonvon-bot (D/service/identity.ts). */
    async defineService() {
      await mkdir(join(home, '.config/systemd/user'), { recursive: true });
      await writeFile(join(home, '.config/systemd/user/vonvon-bot.service'), `[Service]\nExecStart=${root}/current/node/bin/node ${root}/current/app/bin/vonvon.mjs daemon run\n`);
    },
    scenario: answers => writeFile(join(base, 'scenario.json'), JSON.stringify(answers)),
    calls: async () => (await readFile(join(base, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean),
    curls: async () => (await readFile(join(shims, 'curl.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean),
    run(script, env = {}, input) {
      const started = Date.now();
      const full = { ...process.env, HOME: home, PATH: f.path, ...env };
      for (const name of ['VONVON_HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'VONVON_SERVICE']) if (!(name in env)) delete full[name];
      return new Promise(resolve => {
        const child = execFile(SH, input === undefined ? [join(scripts, script)] : ['-s'], { env: full, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, elapsed: Date.now() - started }));
        if (input !== undefined) child.stdin.end(input);
      });
    },
    exists: path => lstat(path).then(() => true, () => false),
  };
  return f;
}

test('the launcher in the fake is the one __standalone-setup writes', async () => {
  const source = await readFile(join(here, '..', 'packages/daemon/src/cli/commands/standalone-setup.ts'), 'utf8');
  for (const line of LAUNCHER.trim().split('\n').slice(2)) assert.ok(source.includes(`\n${line}\n`), line);
});

test('installs: checks the signed manifest and the hash, unpacks, sets up, installs the service', async t => {
  const f = await fixture(t);
  await f.ready();
  const run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  // devices.md §15「安装脚本：开始」「安装脚本：完成」, line by line; 重开一个终端 sits between them while PATH is new
  const lines = run.stdout.split('\n');
  assert.ok(lines.includes('正在安装 Vonvon Bot 服务端 1.0.0（linux-x64）…'), run.stdout);
  // owner 2026-11-02: plain words only, nothing about systemd, linger or sudo when it all worked
  const done = lines.indexOf('装好了。Vonvon Bot 已在后台运行，开机自动启动。');
  assert.ok(done >= 0, run.stdout);
  assert.deepEqual(lines.slice(done + 1), ['试一下：`vonvon --version`', '重开一个终端，或 `. ~/.bashrc`（zsh 用 `. ~/.zshrc`）再运行 `vonvon`。', '要从别的电脑连过来管理？看 https://vonvon.bot/docs/remote/', '']);
  assert.doesNotMatch(run.stdout, /保持这个账号登录着/);
  assert.doesNotMatch(run.stdout, /systemd|linger|sudo/);
  if (openssl3) assert.doesNotMatch(run.stdout, /没能核对发布签名/);
  assert.equal(await readlink(join(f.root, 'current')), 'releases/1.0.0');
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0.part')), false);
  assert.deepEqual(await f.calls(), [`__standalone-setup --install-root ${f.root} --release 1.0.0 --json`, 'service install --linger --json']);
  const curls = await f.curls();
  assert.equal(curls.length, 3);
  for (const line of curls) assert.match(line, /^--proto =https --tlsv1\.2 -f(?:sS|S --progress-bar) --connect-timeout 5 /);
  assert.equal(curls.filter(line => line.endsWith('/stable/manifest.json')).length, 2);
  const archiveRequest = curls.find(line => line.endsWith('.tar.gz'));
  assert.ok(archiveRequest.endsWith(`${BASE}/1.0.0/vonvon-server-1.0.0-linux-x64.tar.gz`));
  assert.match(archiveRequest, /--speed-limit 1 --speed-time 15/);
  assert.doesNotMatch(archiveRequest, /--max-time/);
  // the temporary directory is gone
  const temporary = /-o (\S+)\/(?:domestic|global)\/manifest\.json/.exec(curls[0])?.[1];
  assert.ok(temporary && !(await f.exists(temporary)));
});

test('without OpenSSL 3 the signature is not checked, and the script says so; with it a wrong one is refused', async t => {
  const f = await fixture(t);
  await f.ready();
  await shim(f.shims, 'openssl', `case "$1" in version) echo 'OpenSSL 1.1.1w  11 Sep 2023' ;; *) exit 127 ;; esac`);
  let run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  // devices.md §15「安装脚本：没验签名」
  assert.ok(run.stdout.split('\n').includes('这台机器没有 openssl 3，没能核对发布签名；已核对下载内容的哈希，来源是 https://dl.vonvon.cc。'), run.stdout);

  // the trust boundary, written down: without OpenSSL 3 a manifest signed by another key still installs when the hash matches
  const other = await fixture(t);
  const file = await other.release();
  await other.publish(other.payload('1.0.0', 'linux-x64', file), generateKeyPairSync('ed25519').privateKey);
  await shim(other.shims, 'openssl', `case "$1" in version) echo 'LibreSSL 3.3.6' ;; *) exit 127 ;; esac`);
  run = await other.run('install.sh');
  assert.equal(run.code, 0, run.stderr);

  if (!openssl3) return t.skip('no OpenSSL 3 on this machine');
  const bad = await fixture(t);
  await bad.publish(bad.payload('1.0.0', 'linux-x64', await bad.release()), generateKeyPairSync('ed25519').privateKey);
  run = await bad.run('install.sh');
  assert.equal(run.code, 4);
  assert.match(run.stderr, /签名不对/);
  assert.equal(await bad.exists(join(bad.root, 'releases')), false);
  assert.equal((await bad.curls()).length, 2);
});

test('a manifest that is not exactly the C1 shape is refused before the package is fetched', async t => {
  const f = await fixture(t);
  const file = await f.release();
  const good = f.payload('1.0.0', 'linux-x64', file);
  const cases = {
    'an extra key': { ...good, extra: 1 },
    'channel beta': { ...good, channel: 'beta' },
    'version 1.0': { ...good, version: '1.0' },
    'another host': { ...good, files: { ...good.files, 'linux-x64': { ...good.files['linux-x64'], url: `https://example.com/1.0.0/${archiveName('1.0.0', 'linux-x64')}` } } },
    'sha512 of 127': { ...good, files: { ...good.files, 'linux-x64': { ...good.files['linux-x64'], sha512: file.sha512.slice(1) } } },
    'a target missing': { ...good, files: Object.fromEntries(Object.entries(good.files).filter(([name]) => name !== 'linux-arm64')) },
    // the manifest lists the two Linux packages only (owner 2026-11-01)
    'a target more': { ...good, files: { ...good.files, 'darwin-arm64': { url: `${BASE}/1.0.0/${archiveName('1.0.0', 'darwin-arm64')}`, sha512: 'a'.repeat(128), size: 1 } } },
    'another product': { ...good, product: 'vonvon-bot' },
    'pretty-printed': JSON.stringify(good, null, 1),
  };
  for (const [name, payload] of Object.entries(cases)) {
    await rm(join(f.shims, 'curl.log'), { force: true });
    await f.publish(payload);
    const run = await f.run('install.sh');
    assert.equal(run.code, 4, `${name}: ${run.stderr}`);
    assert.equal((await f.curls()).length, 2, name);
    assert.equal(await f.exists(join(f.root, 'releases')), false, name);
  }
  // notes, the one optional key, last
  await f.publish({ ...good, notes: 'fixes "quotes" and \\ too' });
  assert.equal((await f.run('install.sh')).code, 0);
});

test('a package that does not match the manifest is refused: hash, then size, and nothing is unpacked', async t => {
  const f = await fixture(t);
  const file = await f.release();
  await f.publish(f.payload('1.0.0', 'linux-x64', { ...file, sha512: createHash('sha512').update('other').digest('hex') }));
  let run = await f.run('install.sh');
  assert.equal(run.code, 4);
  assert.match(run.stderr, /下载内容和发布清单不一致/);
  assert.deepEqual(await f.exists(join(f.root, 'releases')), false);
  await f.publish(f.payload('1.0.0', 'linux-x64', { ...file, size: file.size + 1 }));
  run = await f.run('install.sh');
  assert.equal(run.code, 4);
  assert.match(run.stderr, /大小/);
  assert.doesNotMatch(run.stderr, /sha512/);
});

test('a ready overseas manifest wins without waiting for a stalled domestic connection and reaps its curl', async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  await f.network({ domestic: { manifest: { delay: 30_000 } } });
  const run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  const events = await f.events();
  assert.ok(run.elapsed < 5000, JSON.stringify(run));
  const domestic = events.find(event => event.origin === 'domestic' && event.kind === 'manifest');
  const archive = events.find(event => event.kind === 'package');
  assert.equal(archive.origin, 'global');
  assert.ok(archive.at - domestic.at < 1800, JSON.stringify(events));
  assert.throws(() => process.kill(domestic.pid, 0), { code: 'ESRCH' });
  assert.equal(events.filter(event => event.kind === 'package').length, 1);
  assert.equal(await readlink(join(f.root, 'current')), 'releases/1.0.0');
});

test('terminating an installer during parallel probes stops both owned curl children', async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  await f.network({ domestic: { manifest: { delay: 30_000 } }, global: { manifest: { delay: 30_000 } } });
  const child = spawn(SH, [join(f.base, 'scripts', 'install.sh')], { env: { ...process.env, HOME: f.home, PATH: f.path }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  const closed = once(child, 'close');
  let events = [];
  for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
    events = await f.events().catch(() => []);
    if (events.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(events.length, 2);
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 130);
  for (const event of events) assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await f.calls(), []);
});

test('domestic manifest arriving during the short preference window keeps the artifact domestic', async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  await f.network({ domestic: { manifest: { delay: 150 } } });
  const run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual((await f.events()).filter(event => event.kind === 'package').map(event => event.origin), ['domestic']);
});

test('a fast malformed mirror manifest cannot win over a slower valid domestic manifest', async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  await f.network({ domestic: { manifest: { delay: 450 } }, global: { manifest: { corrupt: true } } });
  const run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual((await f.events()).filter(event => event.kind === 'package').map(event => event.origin), ['domestic']);
});

test('parallel selection verifies the actual Ed25519 signature before a mirror can win', { skip: !availableOpenSSL }, async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  const executable = `'${availableOpenSSL.replaceAll("'", "'\\''")}'`;
  await shim(f.shims, 'openssl', `exec ${executable} "$@"`);
  const file = join(f.globalCdn, 'stable', 'manifest.json');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.signature = Buffer.alloc(64).toString('base64');
  await writeFile(file, JSON.stringify(envelope));
  await f.network({ domestic: { manifest: { delay: 450 } } });
  const run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /没能核对发布签名/);
  assert.deepEqual((await f.events()).filter(event => event.kind === 'package').map(event => event.origin), ['domestic']);
});

test('a redirect response cannot win even if its body contains an otherwise valid signed manifest', async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  await f.network({ domestic: { manifest: { status: 302 } } });
  const run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual((await f.events()).filter(event => event.kind === 'package').map(event => event.origin), ['global']);
});

test('an interrupted or corrupt artifact restarts from the other trusted source and verifies the whole file', async t => {
  for (const answer of [{ partial: 32, code: 28 }, { corrupt: true }]) {
    const f = await fixture(t);
    await f.ready(); await f.mirror();
    await f.network({ domestic: { package: answer }, global: { manifest: { delay: 150 } } });
    const run = await f.run('install.sh');
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual((await f.events()).filter(event => event.kind === 'package').map(event => event.origin), ['domestic', 'global']);
    assert.equal(await readlink(join(f.root, 'current')), 'releases/1.0.0');
    assert.ok((await f.curls()).filter(line => line.endsWith('.tar.gz')).every(line => !line.includes('--continue-at')));
  }
});

test('both corrupt artifact copies fail closed before extraction or setup', async t => {
  const f = await fixture(t);
  await f.ready(); await f.mirror();
  await f.network({ domestic: { package: { corrupt: true } }, global: { package: { corrupt: true } } });
  const run = await f.run('install.sh');
  assert.equal(run.code, 4, run.stderr);
  assert.match(run.stderr, /sha512/);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await f.exists(join(f.root, 'releases')), false);
});

test('a package with a path out of its directory, or a link, is refused before anything lands', async t => {
  const f = await fixture(t);
  await f.ready('1.0.0', 'linux-x64', { extra: [{ name: '../evil', body: 'x' }] });
  let run = await f.run('install.sh');
  assert.equal(run.code, 4, run.stderr);
  assert.match(run.stderr, /越界/);
  assert.equal(await f.exists(join(f.root, 'releases', 'evil')), false);
  assert.equal(await f.exists(join(f.root, 'evil')), false);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0.part')), false);

  const g = await fixture(t);
  await g.ready('1.0.0', 'linux-x64', { extra: [{ name: 'app/escape', link: '/etc' }] });
  run = await g.run('install.sh');
  assert.equal(run.code, 4, run.stderr);
  assert.match(run.stderr, /链接/);
  assert.equal(await g.exists(join(g.root, 'releases', '1.0.0')), false);
});

// owner 2026-11-03: root installs like any account, with no word about it, as Paseo and Orca do
test('root installs like any account, and nothing is said about root', async t => {
  const f = await fixture(t);
  await f.ready();
  const user = await f.run('install.sh');
  assert.equal(user.code, 0, user.stderr);
  const g = await fixture(t);
  await g.ready();
  await shim(g.shims, 'id', `case "$1" in -u) echo 0 ;; *) echo root ;; esac`);
  const run = await g.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, user.stdout.replaceAll(f.base, g.base));
  assert.doesNotMatch(run.stdout, /root/);
});

// review F5: sudo keeps the user's HOME (macOS, sudo -s, sudo -E), and root writing there takes the user's files
test('root with a HOME that is not its own is refused by both scripts, before anything is written', async t => {
  const f = await fixture(t);
  await f.ready();
  await shim(f.shims, 'id', `case "$1" in -u) echo 0 ;; *) echo root ;; esac`);
  // a HOME this process does not own: one that is not there (a HOME owned by another user needs a second account)
  const other = join(f.base, 'someone-else');
  let run = await f.run('install.sh', { HOME: other });
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /HOME（.*someone-else）不是 root 的，没有安装。.*`sudo -H` 或 `su -`/);
  assert.deepEqual(await f.curls(), []);
  run = await f.run('uninstall.sh', { HOME: other });
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /不是 root 的，什么都没删/);
  assert.equal(await f.exists(other), false);
  // root's own HOME is fine
  run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /卸载的是 root 这个账号下的服务端/);
});

test('an install that is there already is left alone: no network, no file', async t => {
  const cases = [
    ['a running daemon', async f => { await mkdir(join(f.home, '.vonvon-bot'), { recursive: true }); await writeFile(join(f.home, '.vonvon-bot', 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: 'x' })); }, /已经装过 Vonvon Bot，不用再装/],
    ['current and a launcher that runs', async f => { await mkdir(join(f.root, 'bin'), { recursive: true }); await symlink('releases/0.9.0', join(f.root, 'current')); await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\n# Vonvon Bot server CLI v1\nexit 0\n', { mode: 0o755 }); }, /已经装过 Vonvon Bot，不用再装/],
    ['a systemd unit', async f => { await mkdir(join(f.home, '.config/systemd/user'), { recursive: true }); await writeFile(join(f.home, '.config/systemd/user/vonvon-bot-0123456789ab.service'), ''); }, /已经装过/],
    ['the server\'s command', async f => { await f.command('# Vonvon Bot server CLI v1'); }, /^这台机器已经装过 Vonvon Bot，不用再装。直接用：`vonvon --version`。\n$/],
  ];
  for (const [name, arrange, text] of cases) {
    const f = await fixture(t);
    await f.ready();
    f.command = async marker => {
      const bin = join(f.base, 'elsewhere');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'vonvon'), `#!/bin/sh\n${marker}\n`, { mode: 0o755 });
      f.path = `${f.path}:${bin}`;
    };
    await arrange(f);
    const run = await f.run('install.sh');
    assert.equal(run.code, 0, `${name}: ${run.stderr}`);
    assert.match(run.stdout, text, name);
    assert.deepEqual(await f.curls(), [], name);
    assert.equal(await f.exists(join(f.root, 'releases')), false, name);
  }
});

test('musl, an unknown system and a missing tool are refused with exit 2', async t => {
  const f = await fixture(t);
  await f.ready();
  await shim(f.shims, 'ldd', `echo 'musl libc (x86_64)'; exit 1`);
  let run = await f.run('install.sh');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /musl/);
  await rm(join(f.shims, 'ldd'));
  await f.setUname(['FreeBSD', 'amd64']);
  run = await f.run('install.sh');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /FreeBSD/);
  await f.setUname(['Linux', 'x86_64']);
  // everything the script needs except tar
  const limited = join(f.base, 'limited');
  await mkdir(limited);
  for (const tool of ['mktemp', 'sed', 'grep', 'head', 'tr', 'wc', 'find', 'mkdir', 'mv', 'rm', 'cat', 'base64', 'sha512sum', 'shasum', 'openssl', 'expr', 'id', 'cp']) {
    try { await symlink(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(limited, tool)); } catch {}
  }
  run = await f.run('install.sh', { PATH: `${f.shims}:${limited}` });
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /缺少这些命令： tar/);
  assert.deepEqual(await f.curls(), []);
});

// review F6: Debian and Ubuntu put /lib/ld-musl-*.so.1 beside glibc when the musl package is installed
test('a musl loader beside glibc is not musl: ldd, then getconf, decide; the loader counts only when neither knows glibc', async t => {
  const prepare = async () => {
    const f = await fixture(t);
    await f.ready();
    const script = join(f.base, 'scripts', 'install.sh');
    const text = await readFile(script, 'utf8');
    assert.equal(text.split('for loader in /lib/ld-musl-*.so.1;').length, 2);
    await writeFile(script, text.replace('for loader in /lib/ld-musl-*.so.1;', `for loader in ${f.base}/lib/ld-musl-*.so.1;`));
    await mkdir(join(f.base, 'lib'));
    await writeFile(join(f.base, 'lib', 'ld-musl-x86_64.so.1'), '');
    await shim(f.shims, 'getconf', 'exit 1');
    return f;
  };
  const f = await prepare();
  await shim(f.shims, 'ldd', `echo 'ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39'`);
  let run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);

  const g = await prepare();
  await shim(g.shims, 'ldd', 'exit 1');
  run = await g.run('install.sh');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /不支持 musl/);
  await shim(g.shims, 'getconf', `[ "$1" = GNU_LIBC_VERSION ] && echo 'glibc 2.39'`);
  run = await g.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
});

test('a manifest or package that cannot be downloaded exits 3 and leaves no .part', async t => {
  const f = await fixture(t);
  let run = await f.run('install.sh');
  assert.equal(run.code, 3);
  assert.match(run.stderr, /下载发布清单失败/);
  await f.ready();
  await rm(join(f.cdn, '1.0.0'), { recursive: true });
  run = await f.run('install.sh');
  assert.equal(run.code, 3);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0.part')), false);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0')), false);
});

test('the service: linger left off, the fallbacks to a detached daemon, and failures', async t => {
  const refusal = reason => ({ stdout: JSON.stringify({ ok: false, error: { kind: 'refused', message: 'm', reason, fallback: 'detached', hint: 'h' }, exitCode: 4 }), exit: 4 });
  const f = await fixture(t);
  await f.ready();
  await f.scenario({ 'service install': { stdout: JSON.stringify({ ok: true, action: 'install', linger: 'off', lingerUser: 'alice', notes: [] }) } });
  let run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  // devices.md §15「安装脚本：开机自启要管理员」: installed all the same, then the one optional line, last but the usual three
  const lines = run.stdout.split('\n');
  const done = lines.indexOf('装好了。Vonvon Bot 已在后台运行。');
  assert.ok(done >= 0, run.stdout);
  assert.equal(lines[done + 1], '这台机器没让它开机自动启动，退出登录后它会停。需要的话运行一次：`sudo loginctl enable-linger alice`');
  assert.doesNotMatch(run.stdout, /开机自动启动。/);

  // devices.md §15「安装脚本：没有 systemd」「安装脚本：用户实例不可用」
  const userInstance = '连不上这个账号的 systemd（用 sudo 切过来时常见）。已直接启动一次；用这个账号 SSH 登录后运行 `vonvon service install` 装成后台服务。';
  for (const [reason, text] of [
    ['no_systemd', '这台机器没有 systemd（可能是容器）。已改为直接启动，崩溃后不会自动重启；需要时运行 `vonvon daemon start`。'],
    ['user_instance_down', userInstance],
    ['no_runtime_dir', userInstance],
  ]) {
    const g = await fixture(t);
    await g.ready();
    await g.scenario({ 'service install': refusal(reason), 'daemon start': { stdout: '{"ok":true,"running":true,"pid":4242}' } });
    run = await g.run('install.sh');
    assert.equal(run.code, 0, `${reason}: ${run.stderr}`);
    assert.ok(run.stdout.split('\n').includes(text), `${reason}: ${run.stdout}`);
    assert.match(run.stdout, /装好了。已直接启动一次。/);
    assert.doesNotMatch(run.stdout, /自动启动/);
    assert.equal((await g.calls())[2], 'daemon start --json');
  }

  const h = await fixture(t);
  await h.ready();
  await h.scenario({ 'service install': { stdout: JSON.stringify({ ok: false, error: { kind: 'failed', message: 'm', reason: 'install_incomplete' }, exitCode: 1 }), exit: 1 } });
  run = await h.run('install.sh');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /后台服务没装上/);
  assert.match(run.stderr, /再运行安装命令不会重做这一步；问题解决后运行 `.*\/bin\/vonvon service install`/);
  assert.equal((await h.calls()).includes('daemon start --json'), false);

  // a refusal the script knows, but the detached start fails too
  const i = await fixture(t);
  await i.ready();
  await i.scenario({ 'service install': refusal('no_systemd'), 'daemon start': { stdout: '{"ok":false,"error":{"kind":"failed","message":"m"},"exitCode":1}', exit: 1 } });
  run = await i.run('install.sh');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /问题解决后运行 `.*\/bin\/vonvon daemon start`/);
});

// review F2: the real setup switches `current` before it writes bin/vonvon, and `current` alone used to read as installed
test('a setup that failed after switching current is finished by the next run, not taken for an install', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.scenario({ '__standalone-setup': { afterSwitch: true, stdout: '{"ok":false,"error":{"kind":"failed","message":"m","reason":"launcher_write_failed"},"exitCode":1}', exit: 1 } });
  let run = await f.run('install.sh');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /再运行一次安装命令会从这一步接着做/);
  assert.equal(await readlink(join(f.root, 'current')), 'releases/1.0.0');
  assert.equal(await f.exists(join(f.root, 'bin', 'vonvon')), false);
  await f.scenario({});
  run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /已经装过/);
  assert.match(run.stdout, /不再下载/);
  assert.equal(await readFile(join(f.root, 'bin', 'vonvon'), 'utf8'), LAUNCHER);
  assert.equal((await f.calls()).filter(line => line.startsWith('__standalone-setup')).length, 2);
  // now it is an install: the launcher runs the release
  run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /已经装过 Vonvon Bot，不用再装/);
  assert.equal((await f.calls()).at(-1), '--version');
});

test('a setup that fails keeps the release; the next run skips the download and sets up again', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.scenario({ '__standalone-setup': { stdout: '{"ok":false,"error":{"kind":"failed","message":"m","reason":"launcher_write_failed"},"exitCode":1}', exit: 1 } });
  let run = await f.run('install.sh');
  assert.equal(run.code, 1);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true);
  assert.equal(await f.exists(join(f.root, 'current')), false);
  await f.scenario({});
  await rm(join(f.shims, 'curl.log'));
  run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual((await f.curls()).length, 2);
  assert.match(run.stdout, /不再下载/);
});

test('an incomplete releases/<version> is not deleted; a leftover .part is', async t => {
  const f = await fixture(t);
  await f.ready();
  await mkdir(join(f.root, 'releases', '1.0.0'), { recursive: true });
  let run = await f.run('install.sh');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /残缺/);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0')), true);

  const g = await fixture(t);
  await g.ready();
  await mkdir(join(g.root, 'releases', '1.0.0.part'), { recursive: true });
  await writeFile(join(g.root, 'releases', '1.0.0.part', 'junk'), 'x');
  run = await g.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await g.exists(join(g.root, 'releases', '1.0.0', 'junk')), false);
  assert.equal(await g.exists(join(g.root, 'releases', '1.0.0.part')), false);
});

// main 必败: the scripts installed a server on a Mac too. owner 2026-11-01: Mac and Windows install the desktop app,
// which carries the server; the scripts are for Linux only
test('on a Mac both scripts point to the desktop installer and exit 2: nothing written, no network, root or not', async t => {
  const f = await fixture(t, { uname: ['Darwin', 'arm64'] });
  await f.ready();
  // no temporary directory either
  await shim(f.shims, 'mktemp', `echo "$*" >> '${f.shims}/mktemp.log'; exit 1`);
  // once as a user, then as root (the id shim at the end of the first round)
  for (let round = 0; round < 2; round++) {
    const run = await f.run('install.sh');
    assert.equal(run.code, 2, run.stderr);
    assert.equal(run.stdout, '');
    // devices.md §15「安装脚本：在 Mac 上」
    assert.equal(run.stderr, 'Mac 请下载安装包：https://vonvon.bot/get/ ，安装包里已经带了服务端和 vonvon 命令。这个脚本只用于 Linux，什么都没动。\n');
    await shim(f.shims, 'id', `case "$1" in -u) echo 0 ;; *) echo root ;; esac`);
  }
  assert.deepEqual(await readdir(f.home), []);
  assert.deepEqual(await f.curls(), []);
  assert.equal(await f.exists(join(f.shims, 'mktemp.log')), false);

  // an install root there by hand stays as it is
  await mkdir(join(f.root, 'releases', '1.0.0'), { recursive: true });
  await writeFile(join(f.root, 'releases', '1.0.0', 'standalone.json'), '{}');
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 2, run.stderr);
  // devices.md §15「卸载脚本：在 Mac 上」
  assert.equal(run.stderr, '这个脚本只卸载 Linux 上的服务端。Mac 上的 Vonvon Bot 是桌面端安装包装的，说明见 https://vonvon.bot/get/\n');
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await f.exists(join(f.shims, 'mktemp.log')), false);
});

// main 必败: only Darwin was refused up front; elsewhere the root, HOME and "already installed" checks ran first, so
// Windows Git Bash with the desktop's live daemon.pid was told to use a `vonvon` that Windows does not have
test('on any other system both scripts exit 2 first, with the only-Linux text: before root, the already-installed check and the key', async t => {
  for (const system of ['FreeBSD', 'MINGW64_NT-10.0-19045', '']) {
    const f = await fixture(t, { uname: [system, 'x86_64'] });
    await f.ready();
    // the desktop's daemon running in this HOME, root, a script without its key: none of them is reached
    await mkdir(join(f.home, '.vonvon-bot'), { recursive: true });
    await writeFile(join(f.home, '.vonvon-bot', 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: 'x' }));
    await shim(f.shims, 'id', `case "$1" in -u) echo 0 ;; *) echo root ;; esac`);
    await shim(f.shims, 'mktemp', `echo "$*" >> '${f.shims}/mktemp.log'; exit 1`);
    await writeFile(join(f.base, 'scripts', 'install-unkeyed.sh'), await readFile(join(here, 'install.sh')));
    const shown = system || '认不出的系统';
    for (const script of ['install.sh', 'install-unkeyed.sh']) {
      const run = await f.run(script);
      assert.equal(run.code, 2, `${system} ${script}: ${run.stderr}`);
      assert.equal(run.stdout, '', `${system} ${script}`);
      // devices.md §15「安装脚本：不是 Linux、也不是 Mac」
      assert.equal(run.stderr, `这个安装脚本只支持 Linux（这台是 ${shown}）。Mac、Windows 请下载 Vonvon Bot 桌面端安装包：https://vonvon.bot/get/\n`, `${system} ${script}`);
    }
    await mkdir(join(f.root, 'releases', '1.0.0'), { recursive: true });
    await writeFile(join(f.root, 'releases', '1.0.0', 'standalone.json'), '{}');
    const run = await f.run('uninstall.sh');
    assert.equal(run.code, 2, `${system}: ${run.stderr}`);
    assert.equal(run.stdout, '', system);
    // devices.md §15「卸载脚本：不是 Linux、也不是 Mac」
    assert.equal(run.stderr, `这个脚本只卸载 Linux 上的服务端（这台是 ${shown}），什么都没动。\n`, system);
    assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true, system);
    assert.deepEqual(await f.curls(), [], system);
    assert.deepEqual(await f.calls(), [], system);
    assert.equal(await f.exists(join(f.shims, 'mktemp.log')), false, system);
    assert.deepEqual((await readdir(f.home)).sort(), ['.local', '.vonvon-bot'], system);
  }
});

test('a script cut short anywhere before its last line does nothing', async t => {
  const f = await fixture(t);
  await f.ready();
  const text = await readFile(join(f.base, 'scripts', 'install.sh'), 'utf8');
  const last = text.lastIndexOf('main "$@"');
  assert.equal(text.slice(last), 'main "$@"\n');
  for (const at of [Math.floor(last / 4), Math.floor(last / 2), Math.floor(last * 3 / 4), last - 1, last]) {
    const run = await f.run(undefined, {}, text.slice(0, at));
    assert.doesNotMatch(run.stdout, /正在安装/, `cut at ${at}`);
    assert.deepEqual(await f.curls(), [], `cut at ${at}`);
    assert.equal(await f.exists(f.root), false, `cut at ${at}`);
  }
});

const PUBKEY_BLOCK = /# BEGIN VONVON PUBKEY\n[^]*?# END VONVON PUBKEY\n/;

test('the script without a public key refuses to install', async t => {
  const f = await fixture(t);
  await f.ready();
  const original = await readFile(join(here, 'install.sh'), 'utf8');
  await writeFile(join(f.base, 'scripts', 'install.sh'), original.replace(PUBKEY_BLOCK, "# BEGIN VONVON PUBKEY\nPUBKEY_PEM=''\n# END VONVON PUBKEY\n"));
  const run = await f.run('install.sh');
  assert.equal(run.code, 4);
  assert.match(run.stderr, /没有带发布公钥/);
  assert.deepEqual(await f.curls(), []);
});

// server-5 4.2: the release key is in two places, install.sh (SPKI PEM) and the daemon's server-update.json (raw base64).
// publish-server's plan checks them against the private key; this keeps the two in the repository the same key.
test('install.sh and server-update.json carry the same release public key', async () => {
  const text = await readFile(join(here, 'install.sh'), 'utf8');
  const pem = /PUBKEY_PEM='([^']*)'/.exec(text.match(PUBKEY_BLOCK)?.[0] ?? '')?.[1] ?? '';
  const { publicKey } = JSON.parse(await readFile(join(here, '..', 'packages', 'daemon', 'server-update.json'), 'utf8'));
  if (!pem && !publicKey) return;
  const raw = createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  assert.equal(raw, publicKey);
});

test('uninstall: stops the service and the daemon, takes the PATH out, deletes the install root, keeps the data', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.defineService();
  await mkdir(join(f.home, '.vonvon-bot'), { recursive: true });
  await writeFile(join(f.home, '.vonvon-bot', 'config.json'), '{}');
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /已卸载服务端。数据目录 `~\/\.vonvon-bot`（Bot、记忆、设置）保留着/);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
  assert.deepEqual((await f.calls()).slice(-3), ['service uninstall --json', 'daemon stop --json', `__standalone-teardown --install-root ${f.root} --json`]);
  const again = await f.run('uninstall.sh');
  assert.equal(again.code, 0);
  assert.match(again.stdout, /没有装过服务端/);
});

test('uninstall: a launcher that does not run is replaced by the release\'s own Node', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.defineService();
  await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
  assert.ok((await f.calls()).includes('service uninstall --json'));
});

test('uninstall: nothing in the install root runs; a unit still naming it keeps every file, without one the root goes', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(f.root, 'releases', '1.0.0', 'node', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
  await f.defineService();
  let run = await f.run('uninstall.sh');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /没有能运行的 vonvon/);
  assert.equal(await f.exists(join(f.root, 'current')), true);
  await rm(join(f.home, '.config/systemd/user/vonvon-bot.service'));
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /# >>> Vonvon Bot CLI >>>/);
  assert.equal(await f.exists(f.root), false);
});

// review 216/217: with nothing that runs and no unit, the daemon the fallback started directly was not looked for, and
// the install root went while it ran. A PID that now belongs to another program (a restarted container hands out the
// same small numbers) or to an earlier boot is not the server.
test('uninstall: nothing runs and no unit, but the daemon in daemon.pid still runs from the install root: nothing is deleted', async t => {
  const sleep = execFileSync(SH, ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();
  const bootId = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(text => text.trim(), () => undefined);
  const brokenInstall = async () => {
    const f = await fixture(t);
    await f.ready();
    assert.equal((await f.run('install.sh')).code, 0);
    await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
    await writeFile(join(f.root, 'releases', '1.0.0', 'node', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
    await mkdir(join(f.home, '.vonvon-bot'), { recursive: true });
    return f;
  };
  /** A program from the install root, standing in for the release's Node running `daemon run`; named sleep for a multi-call binary. */
  const startInRoot = async f => {
    const program = join(f.root, 'releases', '1.0.0', 'node', 'bin', 'sleep');
    await copyFile(sleep, program);
    await chmod(program, 0o755);
    const child = spawn(program, ['120'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    await once(child, 'spawn');
    return child;
  };
  // the lock pid-lock.ts writes
  const lock = (f, pid, boot = bootId) => writeFile(join(f.home, '.vonvon-bot', 'daemon.pid'), JSON.stringify({ pid, startedAt: new Date().toISOString(), listen: '127.0.0.1:7766', version: '1.0.0', ...boot ? { bootId: boot } : {} }));

  const f = await brokenInstall();
  const daemon = await startInRoot(f);
  await lock(f, daemon.pid);
  const before = (await f.calls()).length;
  let run = await f.run('uninstall.sh');
  assert.equal(run.code, 1, run.stdout);
  if (process.platform === 'linux') assert.equal(run.stderr, `安装目录里没有能运行的 vonvon，服务端还在运行（进程 ${daemon.pid}），什么都没删。先停掉它：\`kill ${daemon.pid}\`，等它退出后再运行一次卸载。\n`);
  // without /proc it cannot tell what the process runs, and does not guess
  else assert.match(run.stderr, new RegExp(`进程 ${daemon.pid} 还在，看不出它是不是服务端，什么都没删`));
  assert.equal(run.stdout, '');
  assert.equal(await f.exists(join(f.root, 'current')), true);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true);
  // the script stops nothing by itself
  assert.equal(daemon.exitCode, null);
  assert.equal(daemon.signalCode, null);
  assert.deepEqual((await f.calls()).slice(before), []);

  if (process.platform === 'linux') {
    // this test's own Node: alive, but not a program from the install root
    const reused = await brokenInstall();
    await lock(reused, process.pid);
    run = await reused.run('uninstall.sh');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(await reused.exists(reused.root), false);
    // the daemon's PID, written before a reboot: daemon.pid does not name it, but /proc still shows a program from the
    // install root running, so the root stays until it stops
    const rebooted = await brokenInstall();
    const after = await startInRoot(rebooted);
    await lock(rebooted, after.pid, '00000000-0000-4000-8000-000000000000');
    run = await rebooted.run('uninstall.sh');
    assert.equal(run.code, 1, run.stdout);
    assert.equal(run.stderr, `还有程序在用安装目录里的文件运行（进程 ${after.pid}），可能是用别的数据目录启动的服务端，安装目录没删。先停掉它们：\`kill ${after.pid}\`，等它们退出后再运行一次卸载。\n`);
    after.kill('SIGTERM');
    await once(after, 'exit');
    run = await rebooted.run('uninstall.sh');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(await rebooted.exists(rebooted.root), false);
  }

  // stopped: the root goes, the data directory stays
  daemon.kill('SIGTERM');
  await once(daemon, 'exit');
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'daemon.pid')), true);
});

// independent check of 246067b7 (P3): only ~/.vonvon-bot/daemon.pid was looked at, so a server started from the install
// root for another data directory (VONVON_HOME=…, detached), or one whose daemon.pid does not read, was missed:
// `daemon stop` answered stopped:false for the default data directory, and the root went while it ran.
const LINUX_PROC = { skip: process.platform !== 'linux' && 'reads /proc' };
const runningRefused = pid => `还有程序在用安装目录里的文件运行（进程 ${pid}），可能是用别的数据目录启动的服务端，安装目录没删。先停掉它们：\`kill ${pid}\`，等它们退出后再运行一次卸载。\n`;
function fromRoot(t) {
  return {
    async installed() {
      const f = await fixture(t);
      await f.ready();
      assert.equal((await f.run('install.sh')).code, 0);
      await mkdir(join(f.home, '.vonvon-bot'), { recursive: true });
      await writeFile(join(f.home, '.vonvon-bot', 'config.json'), '{}');
      return f;
    },
    /** A detached executable in the install root, waiting on stdin for another data directory. */
    async start(f) {
      const program = join(f.root, 'releases', '1.0.0', 'node', 'bin', 'sh');
      await copyFile(SH, program);
      await chmod(program, 0o755);
      // A spawn event alone does not mean the program has finished starting. In particular,
      // Ubuntu's uutils sleep can reject its own executable name if it is unlinked during startup.
      const child = spawn(program, ['-c', 'printf ready; exec 1>&-; read -r line'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true, env: { ...process.env, VONVON_HOME: join(f.base, 'other-data') } });
      t.after(() => child.kill('SIGKILL'));
      await once(child, 'spawn');
      assert.equal(await streamText(child.stdout), 'ready');
      return { child, program };
    },
    async stop(child) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
    /** Refused: exit 1, the root and the process as they were. */
    async refused(f, run, child) {
      assert.equal(run.code, 1, run.stdout);
      assert.equal(run.stderr, runningRefused(child.pid));
      assert.equal(run.stdout, '');
      assert.equal(await f.exists(join(f.root, 'current')), true);
      assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true);
      assert.equal(await f.exists(join(f.root, 'bin', 'vonvon')), true);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    },
  };
}

test('uninstall: a server running from the install root for another data directory keeps the root; stopped, it goes', LINUX_PROC, async t => {
  const r = fromRoot(t);
  const f = await r.installed();
  const { child } = await r.start(f);
  const before = (await f.calls()).length;
  let run = await f.run('uninstall.sh');
  await r.refused(f, run, child);
  // `daemon stop` for ~/.vonvon-bot found nothing; the PATH block is not taken out either
  assert.deepEqual((await f.calls()).slice(before), ['--version', 'daemon stop --json']);
  await r.stop(child);
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /已卸载服务端。/);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
});

test('uninstall: nothing in the root runs and daemon.pid does not read, but a program from the root runs: the root stays', LINUX_PROC, async t => {
  const r = fromRoot(t);
  const f = await r.installed();
  await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(f.root, 'releases', '1.0.0', 'node', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(f.home, '.vonvon-bot', 'daemon.pid'), '{"pid":');
  const { child } = await r.start(f);
  await r.refused(f, await f.run('uninstall.sh'), child);
  await r.stop(child);
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
});

test('uninstall: a program from the install root deleted while it runs (" (deleted)") still keeps the root', LINUX_PROC, async t => {
  const r = fromRoot(t);
  const f = await r.installed();
  const { child, program } = await r.start(f);
  await rm(program);
  assert.match(await readlink(`/proc/${child.pid}/exe`), / \(deleted\)$/);
  await r.refused(f, await f.run('uninstall.sh'), child);
  await r.stop(child);
  assert.equal((await f.run('uninstall.sh')).code, 0);
  assert.equal(await f.exists(f.root), false);
});

test('uninstall: HOME through a symbolic link still finds the program, by the real path /proc shows', LINUX_PROC, async t => {
  const r = fromRoot(t);
  const f = await r.installed();
  const link = join(f.base, 'home-link');
  await symlink(f.home, link);
  const { child } = await r.start(f);
  assert.equal((await readlink(`/proc/${child.pid}/exe`)).startsWith(`${link}/`), false);
  await r.refused(f, await f.run('uninstall.sh', { HOME: link }), child);
  await r.stop(child);
  const run = await f.run('uninstall.sh', { HOME: link });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
});

// review 223 (P2): a process of this account whose exe does not read (it set PR_SET_DUMPABLE to 0) was taken for another
// account's, and the root went while it ran. Python's ctypes calls prctl(PR_SET_DUMPABLE, 0) for real; without python3
// or prctl the test is skipped. ssh-agent and gpg-agent do the same on purpose, so one that does not name the install
// root does not keep it.
const python3 = (() => { try { return execFileSync(SH, ['-c', 'command -v python3'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; } })();
const NOT_DUMPABLE = 'import ctypes, sys, time\nif ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0: sys.exit(3)\nprint("ready", flush=True)\ntime.sleep(120)\n';
/** `program` (a python3) started for another data directory, not dumpable; undefined when it cannot get there. */
async function notDumpable(t, program, f, options = {}) {
  const child = spawn(program, ['-c', NOT_DUMPABLE], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: { ...process.env, VONVON_HOME: join(f.base, 'other-data') }, ...options });
  t.after(() => child.kill('SIGKILL'));
  const ready = await new Promise(resolve => {
    let out = '';
    child.stdout.on('data', data => { out += data; if (out.includes('ready')) resolve(true); });
    child.on('exit', () => resolve(false));
    child.on('error', () => resolve(false));
  });
  if (!ready) return undefined;
  // root reads any exe; anyone else gets EACCES now
  if (process.getuid?.() !== 0) await assert.rejects(readlink(`/proc/${child.pid}/exe`), { code: 'EACCES' });
  return child;
}

test('uninstall: a program from the install root whose exe this account cannot read keeps the root; stopped, it goes', { ...LINUX_PROC, ...!python3 && { skip: 'needs python3' } }, async t => {
  const r = fromRoot(t);
  const f = await r.installed();
  // nothing that runs, no unit, no daemon.pid: only the scan can see it
  await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(f.root, 'releases', '1.0.0', 'node', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
  const program = join(f.root, 'releases', '1.0.0', 'node', 'bin', 'python3');
  await copyFile(await realpath(python3), program);
  await chmod(program, 0o755);
  const child = await notDumpable(t, program, f);
  if (!child) return t.skip('python3 cannot set PR_SET_DUMPABLE here');
  await r.refused(f, await f.run('uninstall.sh'), child);
  // HOME through a link: the real path the command line does not show is matched as well
  const link = join(f.base, 'home-link');
  await symlink(f.home, link);
  await r.refused(f, await f.run('uninstall.sh', { HOME: link }), child);
  await r.stop(child);
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
});

// review of c678aa41 (P3): its cwd reads no more than its exe, so only the command line tells. An absolute path through a
// symbolic link (to the root, or to the program) is resolved; a relative one is known only by the install directory's name.
test('uninstall: a program from the install root whose exe cannot be read, started through a link or by a relative path naming the root, keeps the root', { ...LINUX_PROC, ...!python3 && { skip: 'needs python3' } }, async t => {
  const r = fromRoot(t);
  const f = await r.installed();
  await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(f.root, 'releases', '1.0.0', 'node', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
  const program = join(f.root, 'releases', '1.0.0', 'node', 'bin', 'python3');
  await copyFile(await realpath(python3), program);
  await chmod(program, 0o755);
  await symlink(f.root, join(f.base, 'root-link'));
  await symlink(program, join(f.base, 'python3-link'));
  for (const [command, options] of [
    [join(f.base, 'root-link', 'releases', '1.0.0', 'node', 'bin', 'python3'), {}],
    [join(f.base, 'python3-link'), {}],
    ['.local/share/vonvon-bot/server/releases/1.0.0/node/bin/python3', { cwd: f.home }],
  ]) {
    const child = await notDumpable(t, command, f, options);
    if (!child) return t.skip('python3 cannot set PR_SET_DUMPABLE here');
    if (process.getuid?.() !== 0) await assert.rejects(readlink(`/proc/${child.pid}/cwd`), { code: 'EACCES' });
    assert.equal((await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).split('\0')[0], command);
    await r.refused(f, await f.run('uninstall.sh'), child);
    await r.stop(child);
  }
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
});

test('uninstall: a program of this account whose exe cannot be read, not from the install root, does not keep the root', { ...LINUX_PROC, ...!python3 && { skip: 'needs python3' } }, async t => {
  for (const cli of [true, false]) {
    const r = fromRoot(t);
    const f = await r.installed();
    if (!cli) {
      await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\nexit 1\n');
      await writeFile(join(f.root, 'releases', '1.0.0', 'node', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
    }
    // the second as an ssh login session shows itself (this account's, not dumpable, a relative path with a slash in it)
    const child = await notDumpable(t, python3, f, cli ? {} : { argv0: 'sshd: me@pts/0' });
    if (!child) return t.skip('python3 cannot set PR_SET_DUMPABLE here');
    const run = await f.run('uninstall.sh');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(await f.exists(f.root), false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    await r.stop(child);
  }
});

test('uninstall: not registered as a service still stops the daemon, then deletes', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.defineService();
  await f.scenario({ 'service uninstall': { stdout: JSON.stringify({ ok: true, action: 'uninstall', result: 'not-installed', reason: 'not_registered' }) }, 'daemon stop': { stdout: JSON.stringify({ ok: false, error: { kind: 'connection', message: 'm' }, exitCode: 3 }), exit: 3 } });
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.ok((await f.calls()).includes('daemon stop --json'));
  assert.equal(await f.exists(f.root), false);
});

// main 必败: the detached fallback (no systemd, no user manager) left no unit, and asking the service manager there fails
test('uninstall: with no service definition the service manager is not asked; the daemon is stopped and the root deleted', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.scenario({ 'service uninstall': { stdout: JSON.stringify({ ok: false, error: { kind: 'failed', message: 'systemctl show failed', reason: 'uninstall_incomplete' }, exitCode: 1 }), exit: 1 } });
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  const calls = await f.calls();
  assert.equal(calls.includes('service uninstall --json'), false);
  assert.deepEqual(calls.slice(-2), ['daemon stop --json', `__standalone-teardown --install-root ${f.root} --json`]);
  assert.equal(await f.exists(f.root), false);
});

// review F4: a service set up with the server's vonvon for another VONVON_HOME has a hashed name and was left behind
test('uninstall: another data directory\'s service still naming the install root keeps everything; one naming something else does not', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.defineService();
  const units = join(f.home, '.config/systemd/user');
  await writeFile(join(units, 'vonvon-bot-0123456789ab.service'), `[Service]\nExecStart=${f.root}/current/node/bin/node ${f.root}/current/app/bin/vonvon.mjs daemon run\n`);
  await writeFile(join(units, 'vonvon-bot-ba9876543210.service'), `[Service]\nExecStart=${join(f.base, 'other', 'node')} daemon run\n`);
  const before = (await f.calls()).length;
  let run = await f.run('uninstall.sh');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /vonvon-bot-0123456789ab\.service 还指着安装目录，什么都没删。先用它的数据目录卸掉它/);
  assert.equal(await f.exists(join(f.root, 'current')), true);
  assert.equal(await f.exists(join(units, 'vonvon-bot.service')), true);
  // nothing was stopped or taken out
  assert.deepEqual((await f.calls()).slice(before), ['--version']);
  await rm(join(units, 'vonvon-bot-0123456789ab.service'));
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(join(units, 'vonvon-bot-ba9876543210.service')), true);
});

test('uninstall: a service that will not uninstall keeps every file', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.defineService();
  await f.scenario({ 'service uninstall': { stdout: JSON.stringify({ ok: false, error: { kind: 'failed', message: 'm', reason: 'uninstall_incomplete' }, exitCode: 1 }), exit: 1 } });
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 1);
  assert.equal(await f.exists(join(f.root, 'current')), true);
  assert.equal((await f.calls()).some(line => line.startsWith('__standalone-teardown')), false);
});

// fix check of 216-218 (P3): an rm -rf cut short (Ctrl-C, SSH gone) could leave an install root whose markers were
// already gone; the next uninstall refused it (exit 2) and install.sh called its release incomplete. The root is now
// renamed to server.removing first, and the next run finishes that.
test('uninstall: a removal cut short leaves server.removing, which the next run finishes; an install beside it goes on', async t => {
  const f = await fixture(t);
  const left = `${f.root}.removing`;
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await mkdir(join(f.home, '.vonvon-bot'), { recursive: true });
  await writeFile(join(f.home, '.vonvon-bot', 'config.json'), '{}');
  // root may empty a directory it cannot write
  if (process.getuid?.() !== 0) {
    // rm cannot empty a directory it may not write: the run stops halfway, as a Ctrl-C would
    await chmod(join(f.root, 'releases', '1.0.0', 'app', 'bin'), 0o555);
    try {
      let run = await f.run('uninstall.sh');
      assert.equal(run.code, 1);
      assert.match(run.stderr, /安装目录已经改名成 \S*server\.removing，但没删完。看一下上面 rm 说的原因，解决后再运行一次卸载，会接着删。\n$/);
      assert.equal(await f.exists(f.root), false);
      assert.equal(await f.exists(join(left, 'releases', '1.0.0', 'app', 'bin', 'vonvon.mjs')), true);
      run = await f.run('uninstall.sh');
      assert.equal(run.code, 1);
      assert.match(run.stderr, /上次卸载没删完的 \S*server\.removing 还是没删完/);
    } finally {
      await chmod(join(left, 'releases', '1.0.0', 'app', 'bin'), 0o755).catch(() => undefined);
      await chmod(join(f.root, 'releases', '1.0.0', 'app', 'bin'), 0o755).catch(() => undefined);
    }
    const before = (await f.calls()).length;
    const run = await f.run('uninstall.sh');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, `已删完上次卸载没删完的 ${left}。数据目录 \`~/.vonvon-bot\`（Bot、记忆、设置）保留着；不要了就自己删。\n`);
    assert.equal(await f.exists(left), false);
    assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
    // nothing to stop: the services were stopped before the rename
    assert.deepEqual((await f.calls()).slice(before), []);
    assert.equal((await f.run('install.sh')).code, 0);
  }
  // what a Ctrl-C in the middle of rm -rf may leave: no marker in it any more
  await mkdir(join(left, 'releases', '1.0.0', 'app', 'node_modules', 'x'), { recursive: true });
  await writeFile(join(left, 'releases', '1.0.0', 'app', 'node_modules', 'x', 'index.js'), '');
  await rm(f.root, { recursive: true });
  assert.equal((await f.run('install.sh')).code, 0);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true);
  // installed again beside it: one uninstall takes both
  const run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /已卸载服务端。/);
  assert.equal(await f.exists(f.root), false);
  assert.equal(await f.exists(left), false);
  assert.equal(await f.exists(join(f.home, '.vonvon-bot', 'config.json')), true);
});

test('uninstall refuses an empty or root HOME, a linked install root and one without a marker, deleting nothing', async t => {
  const f = await fixture(t);
  const keep = join(f.base, 'home2', 'keep');
  await mkdir(keep, { recursive: true });
  for (const home of ['', '/', '//', 'relative']) {
    const run = await f.run('uninstall.sh', { HOME: home });
    assert.equal(run.code, 2, `HOME=${home}`);
    assert.match(run.stderr, /HOME/);
  }
  assert.equal(await f.exists(keep), true);

  const elsewhere = join(f.base, 'elsewhere');
  await mkdir(join(elsewhere, 'releases', '1.0.0'), { recursive: true });
  await writeFile(join(elsewhere, 'releases', '1.0.0', 'standalone.json'), '{}');
  await mkdir(dirname(f.root), { recursive: true });
  await symlink(elsewhere, f.root);
  let run = await f.run('uninstall.sh');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /符号链接/);
  assert.equal(await f.exists(join(elsewhere, 'releases', '1.0.0', 'standalone.json')), true);

  await rm(f.root);
  await mkdir(join(f.root, 'stuff'), { recursive: true });
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /没有服务端的标记/);
  assert.equal(await f.exists(join(f.root, 'stuff')), true);
  assert.deepEqual(await f.calls(), []);

  // server.removing is only what an earlier uninstall renamed: a link or a file by that name is someone else's, and
  // is found before anything is stopped
  await rm(f.root, { recursive: true });
  await f.ready();
  assert.equal((await f.run('install.sh')).code, 0);
  await f.defineService();
  const left = `${f.root}.removing`;
  for (const make of [() => symlink(elsewhere, left), () => writeFile(left, 'keep')]) {
    await make();
    const before = (await f.calls()).length;
    run = await f.run('uninstall.sh');
    assert.equal(run.code, 2);
    assert.match(run.stderr, /server\.removing (是符号链接|不是目录)，不是卸载脚本留下的，什么都没删。/);
    assert.equal(await f.exists(join(elsewhere, 'releases', '1.0.0', 'standalone.json')), true);
    assert.equal(await f.exists(join(f.root, 'current')), true);
    assert.deepEqual((await f.calls()).slice(before), []);
    await rm(left);
  }
});
