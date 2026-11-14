import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
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
const server = createServer(socket => socket.end(sentinel));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port;
const worker = `
import {readFile,writeFile} from 'node:fs/promises';
import {connect} from 'node:net';
const result = {};
const limits = await readFile('/proc/self/limits','utf8');
result.cpuLimit = /Max cpu time\\s+4\\s+4/.test(limits);
result.addressLimit = /Max address space\\s+1610612736\\s+1610612736/.test(limits);
result.dataLimit = /Max data size\\s+402653184\\s+402653184/.test(limits);
result.coreLimit = /Max core file size\\s+0\\s+0/.test(limits);
for (const [key,path] of Object.entries(${JSON.stringify({credential, parentEnvironment:`/proc/${process.pid}/environ`})})) {
  try { await readFile(path); result[key] = false; } catch { result[key] = true; }
}
result.environment = !process.env.FAKE_LOGO_CREDENTIAL;
for (const path of ['/tmp/escape','/decoder/escape','/usr/escape',${JSON.stringify(join(directory,'escape'))}]) {
  try { await writeFile(path,'escape'); result[path] = false; } catch { result[path] = true; }
}
result.network = await new Promise(resolve => {
  const socket = connect({host:'127.0.0.1',port:${port}});
  socket.on('connect',() => { socket.destroy(); resolve(false); });
  socket.on('error',() => resolve(true));
  socket.setTimeout(500,() => {socket.destroy();resolve(true);});
});
process.stdout.write(JSON.stringify(result));
`;
await writeFile(join(root,'logo-child.mjs'),worker);
const launch = linuxDecoderLaunch('normalize',{root});
const child = spawn('/bin/sh',['-c','ulimit -v 1572864 && ulimit -d 393216 && ulimit -c 0 && ulimit -t 4 && exec "$@"','logo',launch.command,...launch.args],{
  env:{...decoderEnvironment,FAKE_LOGO_CREDENTIAL:sentinel},stdio:['pipe','pipe','pipe'],cwd:'/',
});
const out = [], errors = [];
child.stdout.on('data',data => out.push(data));
child.stderr.on('data',data => errors.push(data));
child.stdin.end();
const timeout = setTimeout(() => child.kill('SIGKILL'),5000);
try {
  const code = await new Promise((resolve,reject) => {child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,Buffer.concat(errors).toString());
  const stdout = Buffer.concat(out).toString();
  assert.ok(!stdout.includes(sentinel));
  const results = JSON.parse(stdout);
  for (const [name,denied] of Object.entries(results)) assert.equal(denied,true,name);
  assert.equal(await readFile(credential,'utf8'),sentinel);
  console.log(JSON.stringify({isolation:'PASS',results}));
} finally { clearTimeout(timeout); server.close(); }

await writeFile(join(root,'logo-child.mjs'),`
import {spawn} from 'node:child_process';
spawn('/node',['--jitless','-e','setInterval(() => {},1000)'],{stdio:'ignore'});
setInterval(() => {},1000);
`);
process.env.LOGO_DECODER_ROOT = root;
const { normalizeLogo, verifyNormalizedLogo } = await import('../src/logo.mjs');
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
assert.ok(running.length >= 4,'two decoder trees and their grandchildren must start');
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
await cp(join(original,'logo-child.mjs'),join(root,'logo-child.mjs'));
const { createRequire } = await import('node:module');
const sharp = createRequire(join(original,'logo-child.mjs'))('sharp');
const input = await sharp({create:{width:16,height:16,channels:4,background:'red'}}).png().toBuffer();
const normalized = await normalizeLogo(input);
await verifyNormalizedLogo(normalized);
console.log(JSON.stringify({timeoutReap:'PASS',concurrencyAndRecovery:'PASS',observedProcesses:running.length}));
