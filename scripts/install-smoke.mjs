#!/usr/bin/env node
// The install smoke of the CI Linux job (docs/plans/server-5-release.md 4.6; devices 7.6): builds a real server package
// for this machine with a key made here, serves it and a signed manifest from a CDN on 127.0.0.1, runs install.sh for real
// in a temporary HOME, then checks `vonvon --version`, `vonvon open --print` (the page answers), `vonvon hook`,
// `vonvon update --check` and uninstall.sh.
//
//   node scripts/install-smoke.mjs [--node-cache <dir outside the repository>]   (or VONVON_SMOKE_NODE_CACHE)
//
// Nothing outside the temporary directory is touched: HOME is set only for the commands run here, the network is a curl
// stand-in that maps https://dl.vonvon.cc/bot/server/ to the loopback CDN, and systemctl and loginctl stand-ins answer as
// a machine without systemd does, so install.sh takes its detached fallback and no service or linger is changed.
// Linux only; the package needs packages/ui/dist (npm run build).
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productVersion } from './product-version.mjs';
import { PUBLISHED_TARGETS, SERVER_BASE_URL, archiveName } from './server-constants.mjs';
import { installScriptBaseURL, signServerManifest, withInstallScriptKey } from './server-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_PREFIX = 'vonvon-install-smoke-';
const NO_SYSTEMD = 'System has not been booted with systemd as init system (PID 1). Can\'t operate.';

/** The package this machine can run: the smoke runs only where install.sh would install. */
export function smokeTarget(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux') throw new Error(`install smoke 只在 Linux 上跑（这台是 ${platform}）：install.sh 在别的系统上什么都不装`);
  const target = `linux-${arch}`;
  if (!PUBLISHED_TARGETS.includes(target)) throw new Error(`没有 ${target} 的服务端包`);
  return target;
}

export function parseArguments(args, env = process.env) {
  const options = { cache: env.VONVON_SMOKE_NODE_CACHE || undefined };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--node-cache' || !args[i + 1]) throw new Error('usage: install-smoke.mjs [--node-cache <dir>]');
    options.cache = args[i + 1];
  }
  if (options.cache !== undefined) options.cache = resolve(options.cache);
  return options;
}

const quoted = path => {
  if (path.includes("'")) throw new Error(`path with a quote: ${path}`);
  return `'${path}'`;
};

/**
 * curl as install.sh calls it: the request must be limited to https (`--proto =https`) and go to the release address;
 * it is fetched by the real curl from the loopback CDN's /script/ tree. Every call is logged.
 */
export function curlShim({ realCurl, port, log }) {
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${quoted(log)}
proto=''
format=''
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in
    --proto) proto=$2; shift ;;
    --write-out) format=$2; shift ;;
    -o) out=$2; shift ;;
    https://*|http://*) url=$1 ;;
  esac
  shift
done
if [ "$proto" != '=https' ]; then echo "install-smoke: curl was not limited to https" >&2; exit 2; fi
case "$url" in
  ${SERVER_BASE_URL}/*) path=\${url#${SERVER_BASE_URL}/} ;;
  *) echo "install-smoke: not the release address: $url" >&2; exit 6 ;;
esac
if [ -z "$out" ]; then echo "install-smoke: no -o" >&2; exit 2; fi
if [ -n "$format" ]; then set -- --write-out "$format"; else set --; fi
exec ${quoted(realCurl)} -fsS --max-time 120 "$@" -o "$out" "http://127.0.0.1:${port}/script/$path"
`;
}

/** systemctl and loginctl on a machine without systemd: install.sh then starts the daemon detached. */
export function noSystemdShim(name, log) {
  return `#!/bin/sh
printf '%s %s\\n' ${quoted(name)} "$*" >> ${quoted(log)}
echo "${NO_SYSTEMD}" >&2
exit 1
`;
}

/**
 * The loopback CDN. /bot/server/ is what the package's server-update.json points at (the daemon's update check);
 * /script/ is what the curl stand-in maps https://dl.vonvon.cc/bot/server/ to (install.sh). Each has its own signed
 * manifest, as the urls in a manifest must start with the address it is read from; the packages are the same files.
 */
async function startCdn(cdn) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    requests.push(path);
    const match = /^\/(bot\/server|script)\/(?:(stable\/manifest\.json)|(\d+\.\d+\.\d+\/[A-Za-z0-9._-]+\.tar\.gz))$/.exec(path);
    const file = !match || request.method !== 'GET' ? undefined : match[2] ? join(cdn, match[1] === 'script' ? 'script' : 'daemon', 'manifest.json') : join(cdn, 'packages', match[3]);
    try {
      if (!file) throw new Error('not served');
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-length': String(bytes.length), 'content-type': file.endsWith('.json') ? 'application/json' : 'application/gzip', 'cache-control': 'no-cache' }).end(bytes);
    } catch { response.writeHead(404).end('missing'); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return { server, port: server.address().port, requests, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }) };
}

/** Runs a command; never throws for its exit code. */
function command(file, args, { env, input = '', timeout, signal, cwd }) {
  return new Promise((done, fail) => {
    const child = execFile(file, args, { env, timeout, signal, cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { fail(Object.assign(new Error(`${basename(file)} ${args.join(' ')}: ${error.message}`), { stdout, stderr })); return; }
      done({ code: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function tails(dir, lines = 100) {
  const out = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.log')) out.push(`--- ${full} (last ${lines} lines)\n${(await readFile(full, 'utf8')).split('\n').slice(-lines).join('\n')}`);
    }
  }
  await walk(dir);
  return out.join('\n');
}

const check = (condition, message, detail = '') => { if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ''}`); };

export async function installSmoke({ cache, log = text => process.stdout.write(`${text}\n`), timeoutMs = 10 * 60_000 } = {}) {
  const target = smokeTarget();
  if (cache !== undefined && !isAbsolute(cache)) throw new Error('--node-cache must be absolute');
  const realCurl = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();
  check(isAbsolute(realCurl), '找不到 curl');
  const version = await productVersion();
  const root = await mkdtemp(join(tmpdir(), ROOT_PREFIX));
  const home = join(root, 'home'), shims = join(root, 'shims'), cdn = join(root, 'cdn'), scripts = join(root, 'scripts'), logs = join(root, 'logs');
  for (const dir of [home, shims, join(cdn, 'daemon'), join(cdn, 'script'), join(cdn, 'packages', version), scripts, logs, join(root, 'tmp'), join(root, 'build-home')]) await mkdir(dir, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { signal } = controller;
  const installRoot = join(home, '.local', 'share', 'vonvon-bot', 'server');
  const cli = join(installRoot, 'bin', 'vonvon');
  const env = { HOME: home, PATH: `${shims}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', TMPDIR: join(root, 'tmp') };
  const cliEnv = { ...env, VONVON_HOME: join(home, '.vonvon-bot') };
  let cdnServer, failed = true;
  try {
    const keys = generateKeyPairSync('ed25519');
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await writeFile(join(root, 'public.pem'), publicPem);
    cdnServer = await startCdn(cdn);
    const daemonBase = `http://127.0.0.1:${cdnServer.port}/bot/server`;

    log(`install smoke: 打 ${target} 的服务端包（测试钥匙，更新地址 ${daemonBase}）`);
    const build = await command(process.execPath, [join(here, 'build-server.mjs'), '--out', join(root, 'out'), '--targets', target,
      '--update-public-key', join(root, 'public.pem'), '--update-base-url', daemonBase, '--allow-dirty', ...(cache ? ['--node-cache', cache] : [])],
    { env: { ...process.env, HOME: join(root, 'build-home') }, timeout: timeoutMs, signal });
    check(build.code === 0, `build-server.mjs 退出码 ${build.code}`, build.stderr);
    const summary = JSON.parse(await readFile(join(root, 'out', `vonvon-server-${version}-build.json`), 'utf8'));
    check(summary.version === version && summary.updateKey === 'test' && Object.keys(summary.files).join() === target, '构建记录不对', JSON.stringify(summary.files));
    const entry = summary.files[target];
    log(`install smoke: ${entry.name}，${entry.size} 字节`);
    await copyFile(join(root, 'out', archiveName(version, target)), join(cdn, 'packages', version, archiveName(version, target)));
    const payload = base => ({ schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt: Date.now(),
      files: Object.fromEntries(PUBLISHED_TARGETS.map(name => [name, { url: `${base}/${version}/${archiveName(version, name)}`,
        ...(name === target ? { sha512: entry.sha512, size: entry.size } : { sha512: '0'.repeat(128), size: 1 }) }])) });
    await writeFile(join(cdn, 'daemon', 'manifest.json'), signServerManifest(payload(daemonBase), privatePem, daemonBase));
    await writeFile(join(cdn, 'script', 'manifest.json'), signServerManifest(payload(SERVER_BASE_URL), privatePem));

    const curlLog = join(logs, 'curl.log'), systemdLog = join(logs, 'systemd.log');
    await writeFile(join(shims, 'curl'), curlShim({ realCurl, port: cdnServer.port, log: curlLog }));
    for (const name of ['systemctl', 'loginctl']) await writeFile(join(shims, name), noSystemdShim(name, systemdLog));
    for (const name of ['curl', 'systemctl', 'loginctl']) await chmod(join(shims, name), 0o755);
    const original = await readFile(join(here, 'install.sh'), 'utf8');
    check(installScriptBaseURL(original) === SERVER_BASE_URL, `install.sh 的 BASE_URL 不是 ${SERVER_BASE_URL}`);
    await writeFile(join(scripts, 'install.sh'), withInstallScriptKey(original, publicPem));
    await copyFile(join(here, 'uninstall.sh'), join(scripts, 'uninstall.sh'));

    log('install smoke: sh install.sh（临时 HOME，没有 systemd）');
    const install = await command('/bin/sh', [join(scripts, 'install.sh')], { env, timeout: 3 * 60_000, signal, cwd: root });
    const installOutput = `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`;
    check(install.code === 0, `install.sh 退出码 ${install.code}`, installOutput);
    check(install.stdout.includes('没有 systemd') && install.stdout.includes('已直接启动一次'), 'install.sh 没走没有 systemd 的退路', installOutput);
    check(await readlink(join(installRoot, 'current')) === `releases/${version}`, 'current 没指向这次的版本');
    const curls = await readFile(curlLog, 'utf8');
    check(curls.includes(`${SERVER_BASE_URL}/stable/manifest.json`) && curls.includes(`${SERVER_BASE_URL}/${version}/${archiveName(version, target)}`), 'install.sh 没按发布地址下载', curls);
    const systemd = await readFile(systemdLog, 'utf8').catch(() => '');
    check(systemd.includes('systemctl'), 'install.sh 没先试后台服务');
    log(`install smoke: install.sh 退出 0：${install.stdout.trim().split('\n').join(' / ')}`);
    log(`install smoke: curl 替身 ${curls.trim().split('\n').length} 次，systemctl/loginctl 替身 ${systemd.trim().split('\n').length} 次（${[...new Set(systemd.trim().split('\n').map(line => line.split(' ').slice(0, 3).join(' ')))].join('；')}）`);

    const run = (args, input) => command(cli, args, { env: cliEnv, input, timeout: 60_000, signal });
    const shown = await run(['--version']);
    check(shown.code === 0 && shown.stdout.trim().split(/\s+/).includes(version), `vonvon --version 不是 ${version}`, shown.stdout + shown.stderr);
    const opened = await run(['open', '--print', '--json']);
    check(opened.code === 0, 'vonvon open --print --json 失败', opened.stdout + opened.stderr);
    const { listen, url } = JSON.parse(opened.stdout.trim().split('\n').at(-1));
    check(/^127\.0\.0\.1:\d+$/.test(listen), `daemon 不只在 127.0.0.1 上听：${listen}`);
    const page = await fetch(url, { signal });
    const html = await page.text();
    check(page.status === 200 && html.includes('<html'), `网页没打开：HTTP ${page.status}`);
    check((await run(['hook'], '{"hook_event_name":"Stop"}')).code === 0, 'vonvon hook 没退 0');
    const updateCheck = await run(['update', '--check', '--json']);
    check(updateCheck.code === 0, 'vonvon update --check --json 失败', updateCheck.stdout + updateCheck.stderr);
    const latest = JSON.parse(updateCheck.stdout.trim().split('\n').at(-1));
    check(latest.latest === version && latest.hasUpdate === false, `update --check 不对：${updateCheck.stdout}`);
    check(cdnServer.requests.includes('/bot/server/stable/manifest.json'), '升级检查没读假 CDN 的清单');
    log(`install smoke: --version ${shown.stdout.trim()}；open 在 ${listen}，网页 HTTP ${page.status}；hook 退 0；update --check：latest ${latest.latest}，hasUpdate ${latest.hasUpdate}`);

    log('install smoke: sh uninstall.sh');
    const uninstall = await command('/bin/sh', [join(scripts, 'uninstall.sh')], { env, timeout: 2 * 60_000, signal, cwd: root });
    check(uninstall.code === 0, `uninstall.sh 退出码 ${uninstall.code}`, `stdout:\n${uninstall.stdout}\nstderr:\n${uninstall.stderr}`);
    check(!(await lstat(installRoot).then(() => true, () => false)), '卸载后安装目录还在');
    check(await lstat(join(home, '.vonvon-bot')).then(info => info.isDirectory(), () => false), '卸载把数据目录也删了');
    log(`install smoke: uninstall.sh 退出 0：${uninstall.stdout.trim().split('\n').join(' / ')}`);
    log(`install smoke: 通过（${version}，${target}）`);
    failed = false;
  } catch (error) {
    if (signal.aborted) error.message = `超时（${timeoutMs / 1000} 秒）：${error.message}`;
    error.message += `\n${await tails(join(home, '.vonvon-bot'))}`;
    throw error;
  } finally {
    clearTimeout(timer);
    // A daemon left by a failed step is stopped before its files go.
    if (failed && await lstat(cli).then(() => true, () => false)) await command(cli, ['daemon', 'stop'], { env: cliEnv, timeout: 30_000 }).catch(() => undefined);
    await cdnServer?.close();
    // Only the directory made above.
    if (dirname(root) === tmpdir() && basename(root).startsWith(ROOT_PREFIX)) await rm(root, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  installSmoke(parseArguments(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
