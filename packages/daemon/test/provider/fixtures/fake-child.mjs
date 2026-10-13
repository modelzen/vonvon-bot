#!/usr/bin/env node
// A scriptable provider stand-in for process-host.test.ts and Lane 10. Flags:
//   --ignore-term            install a SIGTERM handler that does nothing
//   --grandchildren N        spawn N copies (each --ignore-term, in this group) and print `gc <pid>` once each is armed
//   --exit-on-cue            exit 0 when a line `exit` arrives on stdin, leaving any grandchild alive
//   --frames N --frame-ms M  write N `frame <i>` lines, one every M ms
//   --close-stdout-ms M      close stdout after M ms and keep running
// It prints `pid <pid>` first and `armed` once every handler is in place.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => { const at = argv.indexOf(name); return at === -1 ? fallback : Number(argv[at + 1]); };

const out = (line) => new Promise(resolve => process.stdout.write(`${line}\n`, resolve));

if (flag('--ignore-term')) process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);

await out(`pid ${process.pid}`);
const grandchildren = value('--grandchildren', 0);
for (let i = 0; i < grandchildren; i++) {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--ignore-term'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('armed')) { child.stdout.destroy(); resolve(); } });
  });
  child.unref();
  await out(`gc ${child.pid}`);
}
if (flag('--exit-on-cue')) {
  createInterface({ input: process.stdin }).on('line', line => { if (line.trim() === 'exit') process.exit(0); });
}
const frames = value('--frames', 0);
const frameMs = value('--frame-ms', 200);
for (let i = 0; i < frames; i++) setTimeout(() => void out(`frame ${i}`), frameMs * (i + 1));
const closeStdoutMs = value('--close-stdout-ms', 0);
if (closeStdoutMs > 0) setTimeout(() => process.stdout.end(), closeStdoutMs);
await out('armed');
