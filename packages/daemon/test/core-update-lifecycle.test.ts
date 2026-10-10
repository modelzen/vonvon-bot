import { rm } from 'node:fs/promises';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { paths: { appDir: mkdtempSync(join(tmpdir(), 'vonvon-core-update-')) } };
});

import { paths } from '../src/config/paths';
import { performCoreUpdate, readUpdateStatus } from '../src/service/update';

afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

it('waits for installation, reports restart only after success, and records failure', async () => {
  let complete: (value: { ok: boolean; message: string }) => void = () => {};
  const running = performCoreUpdate({ install: () => new Promise((resolve) => { complete = resolve; }) });
  await expect.poll(() => readUpdateStatus()?.phase).toBe('installing');
  await expect(performCoreUpdate({ install: async () => ({ ok: true, message: 'must not run' }) })).rejects.toThrow('already in progress');
  expect(readUpdateStatus()?.phase).toBe('installing');
  complete({ ok: true, message: 'installed' });
  const completed = await running;
  expect.soft(completed).toEqual(readUpdateStatus());
  expect.soft(completed).toMatchObject({ phase: 'restarting', ok: true });
  expect(readUpdateStatus()).toMatchObject({ phase: 'restarting', ok: true });

  await expect(performCoreUpdate({ install: async () => ({ ok: false, message: 'fixture install failure' }) })).rejects.toThrow('fixture install failure');
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, message: 'fixture install failure' });
  await expect(performCoreUpdate({ install: async () => { throw new Error('fixture process failure'); } })).rejects.toThrow('fixture process failure');
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, message: 'fixture process failure' });
});
