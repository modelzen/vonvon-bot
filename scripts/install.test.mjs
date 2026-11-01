// install.sh and uninstall.sh (docs/plans/server-2-install-scripts.md 5.1), run for real by sh in a temporary HOME. The
// network is a curl stand-in that reads a directory, the package is a fake whose vonvon.mjs records each call and answers
// from scenario.json, and the manifest is signed with a key made here. No service manager is touched.
// main 必败: neither script exists on main.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_TARGETS, archiveName, tarHeader, writeTarGz } from './build-server.mjs';
import { fileEntries } from './package-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://dl.vonvon.cc/bot/server';
const SH = '/bin/sh';
/** The launcher __standalone-setup writes (packages/daemon/src/cli/commands/standalone-setup.ts), checked below. */
const LAUNCHER = '#!/bin/sh\n# Vonvon Bot server CLI v1\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"\nPATH="$root/current/node/bin:$PATH"\nexport PATH\nexec "$root/current/node/bin/node" "$root/current/app/bin/vonvon.mjs" "$@"\n';
const openssl3 = (() => { try { return /^OpenSSL [3-9]/.test(execFileSync('openssl', ['version'], { encoding: 'utf8' })); } catch { return false; } })();

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
case "$url" in ${BASE}/*) source='${cdn}/'"\${url#${BASE}/}" ;; *) exit 6 ;; esac
[ -f "$source" ] || exit 22
cp "$source" "$out"`);
  const setUname = async ([system, machine]) => shim(shims, 'uname', `case "$1" in -s) echo '${system}' ;; -m) echo '${machine}' ;; *) echo '${system}' ;; esac`);
  await setUname(uname);
  const root = join(home, '.local', 'share', 'vonvon-bot', 'server');
  const f = {
    base, home, cdn, shims, root, keys, setUname,
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
      const full = { ...process.env, HOME: home, PATH: f.path, ...env };
      for (const name of ['VONVON_HOME', 'VONVON_ALLOW_ROOT', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'VONVON_SERVICE']) if (!(name in env)) delete full[name];
      return new Promise(resolve => {
        const child = execFile(SH, input === undefined ? [join(scripts, script)] : ['-s'], { env: full, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
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
  assert.match(run.stdout, /正在安装 Vonvon Bot 服务端 1\.0\.0（linux-x64）…/);
  assert.match(run.stdout, /装好了。后台服务已启动，登录后自动运行。/);
  assert.match(run.stdout, /重开一个终端/);
  assert.doesNotMatch(run.stdout, /保持这个账号登录着/);
  if (openssl3) assert.doesNotMatch(run.stdout, /没能核对发布签名/);
  assert.equal(await readlink(join(f.root, 'current')), 'releases/1.0.0');
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0.part')), false);
  assert.deepEqual(await f.calls(), [`__standalone-setup --install-root ${f.root} --release 1.0.0 --json`, 'service install --linger --json']);
  const curls = await f.curls();
  assert.equal(curls.length, 2);
  for (const line of curls) assert.match(line, /^--proto =https --tlsv1\.2 -fsSL --retry 3 --retry-delay 2 -o /);
  assert.match(curls[0], /\/stable\/manifest\.json$/);
  assert.ok(curls[1].endsWith(`${BASE}/1.0.0/vonvon-server-1.0.0-linux-x64.tar.gz`));
  // the temporary directory is gone
  const temporary = /-o (\S+)\/manifest\.json/.exec(curls[0])?.[1];
  assert.ok(temporary && !(await f.exists(temporary)));
});

test('without OpenSSL 3 the signature is not checked, and the script says so; with it a wrong one is refused', async t => {
  const f = await fixture(t);
  await f.ready();
  await shim(f.shims, 'openssl', `case "$1" in version) echo 'OpenSSL 1.1.1w  11 Sep 2023' ;; *) exit 127 ;; esac`);
  let run = await f.run('install.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /这台机器没有 openssl 3，没能核对发布签名；已核对下载内容的哈希，来源是 https:\/\/dl\.vonvon\.cc。/);

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
  assert.equal((await bad.curls()).length, 1);
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
    assert.equal((await f.curls()).length, 1, name);
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

test('root is refused before the network, unless VONVON_ALLOW_ROOT=1', async t => {
  const f = await fixture(t);
  await f.ready();
  await shim(f.shims, 'id', `case "$1" in -u) echo 0 ;; *) echo root ;; esac`);
  let run = await f.run('install.sh');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /useradd -m vonvon && su - vonvon/);
  assert.match(run.stderr, /VONVON_ALLOW_ROOT=1 sh -c "\$\(curl -fsSL https:\/\/dl\.vonvon\.cc\/bot\/server\/install\.sh\)"/);
  assert.deepEqual(await f.curls(), []);
  run = await f.run('install.sh', { VONVON_ALLOW_ROOT: '1' });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /以 root 继续/);
});

// review F5: sudo keeps the user's HOME (macOS, sudo -s, sudo -E), and root writing there takes the user's files
test('root with a HOME that is not its own is refused by both scripts, before anything is written', async t => {
  const f = await fixture(t);
  await f.ready();
  await shim(f.shims, 'id', `case "$1" in -u) echo 0 ;; *) echo root ;; esac`);
  // a HOME this process does not own: one that is not there (a HOME owned by another user needs a second account)
  const other = join(f.base, 'someone-else');
  let run = await f.run('install.sh', { VONVON_ALLOW_ROOT: '1', HOME: other });
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /HOME（.*someone-else）不是 root 的，没有安装。.*`sudo -H` 或 `su -`/);
  assert.deepEqual(await f.curls(), []);
  run = await f.run('uninstall.sh', { HOME: other });
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /不是 root 的，什么都没删/);
  assert.equal(await f.exists(other), false);
  // root's own HOME is fine
  run = await f.run('install.sh', { VONVON_ALLOW_ROOT: '1' });
  assert.equal(run.code, 0, run.stderr);
  run = await f.run('uninstall.sh');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /卸载的是 root 这个账号下的服务端/);
});

test('an install that is there already is left alone: no network, no file', async t => {
  const cases = [
    ['a running daemon', async f => { await mkdir(join(f.home, '.vonvon-bot'), { recursive: true }); await writeFile(join(f.home, '.vonvon-bot', 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: 'x' })); }, /已经装过 Vonvon Bot 服务端/],
    ['current and a launcher that runs', async f => { await mkdir(join(f.root, 'bin'), { recursive: true }); await symlink('releases/0.9.0', join(f.root, 'current')); await writeFile(join(f.root, 'bin', 'vonvon'), '#!/bin/sh\n# Vonvon Bot server CLI v1\nexit 0\n', { mode: 0o755 }); }, /已经装过 Vonvon Bot 服务端/],
    ['a systemd unit', async f => { await mkdir(join(f.home, '.config/systemd/user'), { recursive: true }); await writeFile(join(f.home, '.config/systemd/user/vonvon-bot-0123456789ab.service'), ''); }, /已经装过/],
    ['the server\'s command', async f => { await f.command('# Vonvon Bot server CLI v1'); }, /已经装过 Vonvon Bot 服务端，不用再装。直接用：`vonvon --version`。/],
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
  assert.match(run.stdout, /为了在你退出登录后继续运行，请执行一次：`sudo loginctl enable-linger alice`/);
  assert.match(run.stdout, /后台服务已启动/);

  for (const [reason, text] of [
    ['no_systemd', /这台机器没有 systemd（可能是容器）。已改为直接启动/],
    ['user_instance_down', /连不上这个账号的 systemd（用 sudo 切过来时常见）。已直接启动一次/],
    ['no_runtime_dir', /连不上这个账号的 systemd/],
  ]) {
    const g = await fixture(t);
    await g.ready();
    await g.scenario({ 'service install': refusal(reason), 'daemon start': { stdout: '{"ok":true,"running":true,"pid":4242}' } });
    run = await g.run('install.sh');
    assert.equal(run.code, 0, `${reason}: ${run.stderr}`);
    assert.match(run.stdout, text, reason);
    assert.match(run.stdout, /装好了。已直接启动一次。/);
    assert.doesNotMatch(run.stdout, /登录后自动运行/);
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
  assert.match(run.stdout, /已经装过 Vonvon Bot 服务端/);
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
  assert.deepEqual((await f.curls()).length, 1);
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
  for (const env of [{}, { VONVON_ALLOW_ROOT: '1' }]) {
    const run = await f.run('install.sh', env);
    assert.equal(run.code, 2, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'Mac 请下载安装包：https://bot.vonvon.cc ，安装包里已经带了服务端和 vonvon 命令。这个脚本只用于 Linux，什么都没动。\n');
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
  assert.match(run.stderr, /这个卸载脚本只用于 Linux，什么都没动。Mac 上的服务端在桌面端安装包里（https:\/\/bot\.vonvon\.cc）/);
  assert.equal(await f.exists(join(f.root, 'releases', '1.0.0', 'standalone.json')), true);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await f.exists(join(f.shims, 'mktemp.log')), false);
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

test('the script without a public key refuses to install', async t => {
  const f = await fixture(t);
  await f.ready();
  await writeFile(join(f.base, 'scripts', 'install.sh'), await readFile(join(here, 'install.sh')));
  const run = await f.run('install.sh');
  assert.equal(run.code, 4);
  assert.match(run.stderr, /没有带发布公钥/);
  assert.deepEqual(await f.curls(), []);
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
});
