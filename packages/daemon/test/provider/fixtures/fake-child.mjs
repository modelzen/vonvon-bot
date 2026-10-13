#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => { const at = argv.indexOf(name); return at === -1 ? fallback : Number(argv[at + 1]); };

const out = (line) => new Promise(resolve => process.stdout.write(`${line}\n`, resolve));

if (flag('--ignore-term')) process.on('SIGTERM', () => {});
const termExitMs = value('--term-exit-ms', 0);
if (termExitMs > 0) process.on('SIGTERM', () => setTimeout(() => process.exit(0), termExitMs));
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
if (flag('--exit-on-eof')) process.stdin.on('end', () => process.exit(0)).resume();
const frames = value('--frames', 0);
const frameMs = value('--frame-ms', 200);
for (let i = 0; i < frames; i++) setTimeout(() => void out(`frame ${i}`), frameMs * (i + 1));
const closeStdoutMs = value('--close-stdout-ms', 0);
if (closeStdoutMs > 0) setTimeout(() => process.stdout.end(), closeStdoutMs);
await out('armed');
