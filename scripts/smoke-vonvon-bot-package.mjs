import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { validateInstalledManifest } from './package-tools.mjs';

const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}
const installed = resolve(argument('--installed'));
const port = Number(argument('--port'));
const manifest = JSON.parse(await readFile(argument('--manifest'), 'utf8'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
await validateInstalledManifest(installed, manifest, manifest.sourceHead);
const homeIndex = args.indexOf('--home');
let home;
if (homeIndex < 0) {
  home = await mkdtemp(join(tmpdir(), 'vonvon-smoke-'));
} else {
  home = args[homeIndex + 1];
  if (!home || home.startsWith('--') || !isAbsolute(home)) throw new Error('invalid --home: expected an absolute path');
  const entry = await lstat(home);
  if (!entry.isDirectory() || entry.uid !== process.getuid() || await realpath(home) !== home || (await readdir(home)).length !== 0) {
    throw new Error('invalid --home: expected an empty, caller-owned canonical directory');
  }
}
process.stdout.write(JSON.stringify({ smokeHome: home }) + '\n');
const environment = { ...process.env, VONVON_HOME: home, HOME: home };
const cli = join(installed, 'bin/vonvon.mjs');
function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'daemon', ...command], { env: environment, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`daemon ${command[0]} failed: ${signal ?? code}`)));
  });
}
function sameOwner(status, owner) {
  return status.running === true && status.pid === owner.pid && status.startedAt === owner.startedAt && status.listen === owner.listen;
}
async function assertStopped(owner) {
  const status = JSON.parse(await run(['status', '--json']));
  if (status.running !== false) throw new Error('daemon did not stop');
  let ownerAbsent = false;
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
    ownerAbsent = true;
  }
  if (!ownerAbsent) throw new Error('daemon owner still exists; cleanup not confirmed');
  try { await readFile(join(home, 'daemon.pid')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('daemon.pid remained');
}
let owner;
const errors = [];
try {
  await run(['start', '--port', String(port)]);
  const status = JSON.parse(await run(['status', '--json']));
  if (status.running !== true || status.listen !== `127.0.0.1:${port}` || status.version !== manifest.version
    || !Number.isInteger(status.pid) || status.pid <= 0 || typeof status.startedAt !== 'string') throw new Error('running status mismatch');
  owner = status;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  if (response.status !== 200 || !Buffer.from(await response.arrayBuffer()).equals(await readFile(join(installed, 'ui/dist/index.html')))) throw new Error('served UI mismatch');
} catch (error) {
  errors.push(error);
} finally {
  try {
    if (!owner) throw new Error('daemon owner was not established; stop and removal refused');
    const current = JSON.parse(await run(['status', '--json']));
    if (!sameOwner(current, owner)) throw new Error('daemon owner changed or exited before stop; smoke failed');
    await run(['stop']);
    await assertStopped(owner);
    if (errors.length === 0) await rm(home, { recursive: true, force: true });
  } catch (error) {
    errors.push(new Error(`Smoke home preserved at ${home}: ${error.message}`, { cause: error }));
  }
}
if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
process.stdout.write(JSON.stringify({ ok: true, port, version: manifest.version }) + '\n');
