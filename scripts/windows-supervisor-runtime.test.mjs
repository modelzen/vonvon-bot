import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { buildWindowsSupervisor } from './build-windows-supervisor.mjs';

test('the packaged native Windows supervisor owns and cleans its process tree, and refuses changed bytes', { skip: process.platform !== 'win32', timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-native-supervisor-'));
  let channel;
  try {
    const hash = await buildWindowsSupervisor(root);
    const source = fileURLToPath(new URL('../packages/daemon/src/provider/process/windows-supervisor.ts', import.meta.url));
    const argvSource = fileURLToPath(new URL('../packages/daemon/src/provider/process/windows-command-line.ts', import.meta.url));
    const entry = join(root, 'runtime.mjs');
    await build({ stdin: { contents: `export {spawnWindowsSupervisor} from ${JSON.stringify(source)}; export {windowsCommandLine} from ${JSON.stringify(argvSource)};`, resolveDir: process.cwd() }, outfile: entry, bundle: true, platform: 'node', format: 'esm', define: { __VONVON_SUPERVISOR_SHA256__: JSON.stringify(hash) } });
    const runtime = await import(pathToFileURL(entry));
    const options = {jobName: `Local\\vonvon-native-test-${randomUUID()}`, logPath: join(root, 'holder.log')};
    const started = performance.now();
    channel = await runtime.spawnWindowsSupervisor(options);
    t.diagnostic(`native supervisor ready in ${Math.round(performance.now() - started)} ms`);
    const receipts = [];
    channel.onReceipt(value => receipts.push(value));
    const wait = async kind => {
      const deadline = Date.now() + 10_000;
      while (!receipts.some(value => value.kind === kind)) {
        if (Date.now() >= deadline) throw new Error(`Missing native supervisor receipt: ${kind}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return receipts.find(value => value.kind === kind);
    };
    let output = '';
    channel.stdout.on('data', bytes => { output += bytes; });
    channel.stderr.resume();
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(c.pid); setInterval(()=>{},1000);`;
    channel.send({command: 'launch', nonce: 'launch', file: process.execPath, args: [runtime.windowsCommandLine(process.execPath, ['-e', script], {shim: false})], env: Object.fromEntries(Object.entries(process.env).filter(([,value]) => value !== undefined)), cwd: root});
    const ready = await wait('ready');
    const deadline = Date.now() + 10_000;
    while (!/^\d+/.test(output)) { if (Date.now() >= deadline) throw new Error('Grandchild did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const grandchild = Number(output.trim());
    channel.send({command: 'kill', nonce: 'kill'});
    await wait('sent');
    for (;;) {
      channel.send({command: 'probe', nonce: `p${receipts.length}`});
      if (receipts.some(value => value.kind === 'empty')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
      if (Date.now() > deadline) throw new Error('Native Job never became empty');
    }
    await wait('provider-exit');
    channel.send({command: 'exit', nonce: 'exit'});
    assert.equal((await channel.exited).code, 0);
    for (const pid of [ready.pid, grandchild]) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    assert.doesNotMatch(await readFile(options.logPath, 'utf8'), /hello [a-f0-9]{64}/);
    channel = undefined;
    await appendFile(join(root, 'native/windows-supervisor.exe'), 'changed');
    await assert.rejects(runtime.spawnWindowsSupervisor({...options, jobName: `Local\\vonvon-native-test-${randomUUID()}`}), /assembly changed/);
  } finally {
    if (channel) { channel.close(); await channel.exited; }
    await rm(root, {recursive: true, force: true});
  }
});
