// Bundled by crash-guard.test.ts: a process with the real crash handlers that crashes 20 ms after it starts.
// argv: <root> <scenario> [intent]; scenario host | before-open | bot, with -rejection for an unhandled rejection;
// host-aggregate throws a nested AggregateError.
// bot-drain (with the pipe guard) and bot-drain-unguarded do not crash: after the IPC disconnect they drain, logging
// every 10 ms for 300 ms, then write <root>/drained and exit 0.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardParentPipes, installCrashHandlers, openBotCrashContext, openHostRun, type HostIntent } from '../../src/host/crash-guard';

const [root = '', scenario = 'host', intent = 'running'] = process.argv.slice(2);
let stopping = false;
const wanted = (): HostIntent => stopping ? 'stop' : intent === 'stop' || intent === 'restart' ? intent : 'running';
const log = { info() {}, warn() {}, fail() {} };
installCrashHandlers({ intent: wanted });
if (scenario.startsWith('bot')) {
  openBotCrashContext({ root, appId: 'cli_fixture', runId: process.env.VONVON_HOST_RUN_ID, chainId: process.env.VONVON_HOST_CHAIN_ID, startedAt: new Date().toISOString(), version: '0.7.0', intent: wanted });
} else if (!scenario.startsWith('before-open')) openHostRun({ root, startedAt: new Date().toISOString(), version: '0.7.0', intent: wanted, log });
if (scenario.startsWith('bot-drain')) {
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    let ticks = 0;
    const drain = setInterval(() => {
      console.log(`draining ${ticks}`);
      if (++ticks < 30) return;
      clearInterval(drain);
      writeFileSync(join(root, 'drained'), '');
      process.exit(0);
    }, 10);
  };
  if (scenario === 'bot-drain') guardParentPipes({ requestStop: stop });
  process.on('disconnect', stop);
  process.send?.('ready');
} else {
  setTimeout(() => {
    if (scenario.endsWith('-rejection')) void Promise.reject('plain string');
    else if (scenario === 'host-aggregate') throw new AggregateError([new Error('first leaf'), new AggregateError([new Error('second leaf')], 'inner group')], 'fixture group');
    else throw new TypeError('fixture boom');
  }, 20);
}
setInterval(() => {}, 1000);
