import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile, readFile, realpath, readlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { cloneLogoProbeArtifact } from './clone-logo-probe-artifact.mjs';
import { linuxDecoderLaunch, decoderEnvironment, validateDecoderRoot } from '../src/logo-sandbox.mjs';

if (process.platform !== 'linux') throw new Error('This probe requires actual Linux bubblewrap');
const original = validateDecoderRoot(process.env.LOGO_DECODER_ROOT);
const directory = await realpath(await mkdtemp(join(tmpdir(),'logo-isolation-')));
const root = join(directory,'artifact');
await cloneLogoProbeArtifact(original,root);
const sentinel = 'fake-decoder-credential-do-not-expose';
const credential = join(directory,'parent-credential');
await writeFile(credential,sentinel);
const credentialHandle = await open(credential,'r');
const credentialStat = await credentialHandle.stat();
const server = createServer(socket => socket.end(sentinel));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port;
const namespaces = Object.fromEntries(await Promise.all(['user','pid','net','ipc','uts','mnt'].map(async name => [name,await readlink(`/proc/self/ns/${name}`)])));
const worker = `
import {readFile,writeFile,readlink} from 'node:fs/promises';
import {fstatSync,readdirSync} from 'node:fs';
import {connect} from 'node:net';
const result = {};
for (const fd of [0,1,2]) result['standardFd'+fd] = !fstatSync(fd).isCharacterDevice();
result.parentDescriptor = readdirSync('/proc/self/fd').every(fd => {
  try { const info = fstatSync(Number(fd)); return info.dev !== ${credentialStat.dev} || info.ino !== ${credentialStat.ino}; }
  catch { return true; }
});
for (const [name,parent] of Object.entries(${JSON.stringify(namespaces)})) result['namespace-'+name] = await readlink('/proc/self/ns/'+name) !== parent;
const limits = await readFile('/proc/self/limits','utf8');
result.cpuLimit = /Max cpu time\\s+4\\s+4/.test(limits);
result.addressLimit = /Max address space\\s+1610612736\\s+1610612736/.test(limits);
result.dataLimit = /Max data size\\s+402653184\\s+402653184/.test(limits);
result.coreLimit = /Max core file size\\s+0\\s+0/.test(limits);
for (const [key,path] of Object.entries(${JSON.stringify({credential, parentEnvironment:`/proc/${process.pid}/environ`, nullDevice:'/dev/null'})})) {
  try { await readFile(path); result[key] = false; } catch { result[key] = true; }
}
result.environment = !process.env.FAKE_LOGO_CREDENTIAL;
result.workingDirectory = process.cwd() === '/decoder' && process.env.PWD === '/decoder';
for (const path of ['/tmp/escape','/decoder/escape','/usr/escape',${JSON.stringify(join(directory,'escape'))}]) {
  try { await writeFile(path,'escape'); result[path] = false; } catch { result[path] = true; }
}
result.network = await new Promise(resolve => {
  const socket = connect({host:'127.0.0.1',port:${port}});
  socket.on('connect',() => { socket.destroy(); resolve(false); });
  socket.on('error',() => resolve(true));
  socket.setTimeout(500,() => {socket.destroy();resolve(true);});
});
await new Promise(resolve => process.stderr.write(Buffer.alloc(524288,120),resolve));
process.stdout.write(JSON.stringify(result));
`;
await writeFile(join(root,'logo-child.mjs'),worker);
process.env.LOGO_DECODER_ROOT = root;
process.env.FAKE_LOGO_CREDENTIAL = sentinel;
const { normalizeLogo, verifyNormalizedLogo } = await import('../src/logo.mjs');
try {
  for (const [mode,decode] of [['normalize',normalizeLogo],['check',verifyNormalizedLogo]]) {
    const stdout = String(await decode(Buffer.from('probe')));
    assert.ok(!stdout.includes(sentinel));
    const results = JSON.parse(stdout);
    for (const [name,denied] of Object.entries(results)) assert.equal(denied,true,`${mode}: ${name}`);
    console.log(JSON.stringify({isolation:'PASS',mode,results}));
  }
  assert.equal(await readFile(credential,'utf8'),sentinel);
} finally { await credentialHandle.close(); server.close(); delete process.env.FAKE_LOGO_CREDENTIAL; }

await writeFile(join(root,'logo-child.mjs'),`
import {spawn} from 'node:child_process';
const child = spawn('/node',['--jitless','-e','setInterval(() => {},1000)','logo-grandchild-probe'],{stdio:'inherit'});
child.on('error',() => process.exit(2));
child.on('spawn',() => process.stdout.write('grandchild-started'));
setInterval(() => {},1000);
`);
const descendants = async pid => {
  let children;
  try { children = (await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean); }
  catch { return []; }
  return [...children,...(await Promise.all(children.map(descendants))).flat()];
};
const started = Date.now();
const first = normalizeLogo(Buffer.from('probe'));
const second = normalizeLogo(Buffer.from('probe'));
const completion = Promise.all([first,second].map(promise => assert.rejects(promise,error => error.code === 'invalid_logo')));
await assert.rejects(normalizeLogo(Buffer.from('probe')),error => error.code === 'logo_decoder_busy');
await new Promise(resolve => setTimeout(resolve,500));
const running = await descendants(process.pid);
const grandchildren = [];
for (const pid of running) {
  try { if ((await readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0').includes('logo-grandchild-probe')) grandchildren.push(pid); } catch {}
}
assert.equal(grandchildren.length,2,'each real grandchild must start with its unique command identity');
await completion;
assert.ok(Date.now() - started >= 4500,'wall timeout, rather than early launch failure, ends the workers');
for (let retry = 0; retry < 20; retry++) {
  const alive = await Promise.all(running.map(async pid => {
    try { await readFile(`/proc/${pid}/stat`); return pid; } catch { return undefined; }
  }));
  if (alive.every(pid => !pid)) break;
  if (retry === 19) assert.fail(`decoder process remains after timeout: ${alive.filter(Boolean).join(',')}`);
  await new Promise(resolve => setTimeout(resolve,50));
}
for (const [name,source,expected] of [
  ['cpu','while (true) {}','SIGKILL'],
  ['memory',`try { new ArrayBuffer(512 * 1024 * 1024); process.exit(2); } catch { process.exit(0); }`,null],
]) {
  await writeFile(join(root,'logo-child.mjs'),source);
  const limitLaunch = linuxDecoderLaunch('normalize',{root});
  const limited = spawn('/bin/sh',['-c','ulimit -v 1572864 && ulimit -d 393216 && ulimit -c 0 && ulimit -t 4 && exec "$@"','logo',limitLaunch.command,...limitLaunch.args],{env:decoderEnvironment,stdio:['pipe','pipe','pipe']});
  limited.stdout.resume();
  limited.stderr.resume();
  limited.stdin.end();
  const limitStarted = Date.now();
  const watchdog = setTimeout(() => limited.kill('SIGTERM'),6500);
  const result = await new Promise((resolve,reject) => {limited.on('error',reject);limited.on('close',(code,signal) => resolve({code,signal}));});
  clearTimeout(watchdog);
  if (name === 'cpu') {
    assert.ok(result.signal === expected || result.code === 137,JSON.stringify(result));
    assert.ok(Date.now() - limitStarted < 6000,'hard CPU limit must beat watchdog');
  } else assert.equal(result.code,0,'data limit must reject the actual allocation');
  console.log(JSON.stringify({resourceLimit:name,result,elapsedMs:Date.now()-limitStarted}));
}
await cp(join(original,'logo-child.mjs'),join(root,'logo-child.mjs'));
const { createRequire } = await import('node:module');
const sharp = createRequire(join(original,'logo-child.mjs'))('sharp');
const input = await sharp({create:{width:16,height:16,channels:4,background:'red'}}).png().toBuffer();
const normalized = await normalizeLogo(input);
await verifyNormalizedLogo(normalized);
console.log(JSON.stringify({timeoutReap:'PASS',concurrencyAndRecovery:'PASS',observedProcesses:running.length,observedPids:running,grandchildren}));
