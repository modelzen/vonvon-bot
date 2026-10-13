import { ProcessHost } from '../../../src/provider/process/process-host';

// A stand-in daemon for the daemon-death case: hosts one fake-child tree, prints the pids, and waits to be killed.
const env = process.env as Record<string, string>;
const host = new ProcessHost({ dataDir: env.DATA_DIR as string, daemonBootId: 'first-boot', platform: 'posix', holderPath: env.HOLDER as string });
const hosted = await host.spawn('codex', 'daemon-death', { file: process.execPath, args: [env.FAKE as string, '--ignore-term', '--grandchildren', '1'], env });
let text = '';
hosted.stdout.on('data', (chunk: Buffer) => {
  text += chunk.toString();
  if (!text.includes('armed\n')) return;
  hosted.stdout.removeAllListeners('data');
  const pid = Number(/pid (\d+)/.exec(text)?.[1]);
  const grandchildren = [...text.matchAll(/gc (\d+)/g)].map(match => Number(match[1]));
  process.stdout.write(`${JSON.stringify({ pid, grandchildren, holderPid: host.snapshot()[0]?.holderPid })}\n`);
});
setInterval(() => {}, 1000);
