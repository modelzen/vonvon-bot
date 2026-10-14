import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { StartRead } from '../../src/provider/process/identity';
import { startToken } from '../../src/provider/process/ledger';
import { alive, until } from './channel-recorder';

const controls = vi.hoisted((): {
  cleanUp: () => Promise<void>;
  read: () => Promise<StartRead>;
} => ({
  cleanUp: async () => { throw new Error('fixture hook not registered'); },
  read: async () => 'unreadable',
}));

vi.mock('vitest', async importOriginal => ({
  ...await importOriginal<typeof import('vitest')>(),
  afterEach: (hook: () => Promise<void>) => { controls.cleanUp = hook; },
}));
vi.mock('../../src/provider/process/identity', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/provider/process/identity')>(),
  readStartToken: () => controls.read(),
}));

import { hostFixture, PLATFORM } from './host-fixture';

const fx = hostFixture('vonvon-fixture-identity-');
const original = startToken('fixture:original');
const replacement = startToken('fixture:replacement');
const cases = ['same', 'changed', 'absent', 'unreadable', 'stalled', 'missing'] as const;

it.skipIf(PLATFORM !== 'posix').each(cases)('POSIX holder cleanup handles %s identity before forcing the process', async kind => {
  controls.read = async () => kind === 'missing' ? 'unreadable' : original;
  const host = fx.newHost();
  const close = host.closeAll.bind(host);
  await host.reserve('codex');
  const pid = host.snapshot()[0]?.holderPid;
  if (pid === undefined) throw new Error('fixture did not reserve a holder');
  const dir = fx.dirOf(host);
  const target = PLATFORM === 'posix' ? -pid : pid;
  const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation((to, signal) => {
    if (to === target && signal === 'SIGKILL') signals.push([to, signal]);
    return kill(to, signal);
  });
  let reads = 0;
  controls.read = async () => {
    if (++reads === 1) return original;
    if (kind === 'changed') return replacement;
    if (kind === 'absent') return 'absent';
    if (kind === 'unreadable') return 'unreadable';
    if (kind === 'stalled') return new Promise<StartRead>(resolve => setTimeout(resolve, 1_500, original));
    return original;
  };
  host.closeAll = async () => {};
  let failure: unknown;
  try {
    try { await controls.cleanUp(); }
    catch (error) { failure = error; }
    if (kind === 'stalled') await new Promise(resolve => setTimeout(resolve, 600));
  } finally {
    spy.mockRestore();
    controls.read = async () => original;
    await close();
    await until(() => !alive(pid), 'test-owned holder exit');
  }
  expect(existsSync(dir)).toBe(false);
  expect(signals).toEqual(kind === 'same' ? [[target, 'SIGKILL']] : []);
  if (kind === 'changed' || kind === 'absent') expect(failure).toBeUndefined();
  else expect(failure).toBeInstanceOf(Error);
});
