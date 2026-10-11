import { expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as string[]);
vi.mock('../src/config/data-access', () => ({ acquireMutex: async () => ({ close() {} }), closeMutex: async () => {} }));
vi.mock('../src/server/pid-lock', () => ({ acquirePidLock: async () => ({ pid: 1 }), publishPidLock: async () => {}, releasePidLock: async () => {} }));
vi.mock('../src/service/win-startup', () => ({ recordServicePid() {}, clearServicePid() {} }));
vi.mock('../src/agent/custom-acp-command', () => ({ initCustomAcpCommand: async () => { events.push('capture'); return { kind: 'unset' }; } }));
vi.mock('../src/cli/commands/run', () => ({ runRun: async () => { events.push('run'); } }));

import { runHostRuntime } from '../src/host/bootstrap';

it('captures the custom ACP setting before starting the bridge', async () => {
  events.length = 0;
  await runHostRuntime({ managed: false, control: {
    requested: false, waitForRequest: async () => {}, requestStop() {}, requestRestart() {},
    completeShutdown: async release => release(), dispose() {},
  } });
  expect(events).toEqual(['capture', 'run']);
});
