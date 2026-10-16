// Bundled by crash-guard.test.ts: a process with the real crash handlers that crashes 20 ms after it starts.
// argv: <root> <scenario> [intent]; scenario host | before-open, with -rejection for an unhandled rejection.
import { installCrashHandlers, openHostRun, type HostIntent } from '../../src/host/crash-guard';

const [root = '', scenario = 'host', intent = 'running'] = process.argv.slice(2);
const wanted = (): HostIntent => intent === 'stop' || intent === 'restart' ? intent : 'running';
const log = { info() {}, warn() {}, fail() {} };
installCrashHandlers({ intent: wanted });
if (!scenario.startsWith('before-open')) openHostRun({ root, startedAt: new Date().toISOString(), version: '0.7.0', intent: wanted, log });
setTimeout(() => {
  if (scenario.endsWith('-rejection')) void Promise.reject('plain string');
  else throw new TypeError('fixture boom');
}, 20);
setInterval(() => {}, 1000);
