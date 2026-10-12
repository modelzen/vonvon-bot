import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const arguments_ = new Set(process.argv.slice(2));
const ignoreTerm = arguments_.has('--ignore-term');
if (ignoreTerm) process.on('SIGTERM', () => undefined);
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'exit') process.exit(0); });

let outputOpen = true;
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') outputOpen = false;
  else process.exit(3);
});
const frameMs = arguments_.has('--slow-frames') ? 1000 : 100;
setInterval(() => {
  if (outputOpen) process.stdout.write(JSON.stringify({ kind: 'frame', pid: process.pid }) + '\n');
}, frameMs);

function ready(descendants) {
  const message = { kind: 'ready', pid: process.pid, descendants };
  process.stdout.write(JSON.stringify(message) + '\n');
  if (process.send) process.send(message);
}

if (arguments_.has('--grandchild')) {
  const args = [fileURLToPath(import.meta.url), '--slow-frames'];
  if (ignoreTerm) args.push('--ignore-term');
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  child.once('error', () => process.exit(1));
  child.once('message', message => {
    if (message && message.kind === 'ready' && message.pid === child.pid) ready([child.pid]);
    else process.exit(2);
  });
} else ready([]);
