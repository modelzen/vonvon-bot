import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { getServiceAdapter } from '../src/service/adapter';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget } from '../src/service/identity';
import { controlDesktopService } from '../src/host/service';
import { runServiceStatus } from '../src/cli/commands/service';
import { readVonvonRunValue } from '../src/service/win-startup';

const fixture = vi.hoisted(() => ({ directory: '', query: vi.fn(), owner: vi.fn(), verify: vi.fn() }));
vi.mock('../src/config/paths', () => ({ paths: { appDir: 'C:\\Vonvon' } }));
vi.mock('../src/service/win-startup', async importOriginal => {
  const original = await importOriginal<typeof import('../src/service/win-startup')>();
  return { ...original, readVonvonRunValue: () => original.readVonvonRunValue({ run: fixture.query }) };
});
vi.mock('../src/server/pid-lock', () => ({ readRunningPidLock: fixture.owner }));
vi.mock('../src/server/owner-verification', () => ({ verifyPidLockOwner: fixture.verify }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  function local(path: string) { return join(fixture.directory, ...path.split(/[:\\]+/)); }
  return {
    ...original,
    realpath: async (path: string) => { await original.realpath(local(path)); return path; },
    stat: (path: string) => original.stat(local(path)),
    lstat: (path: string) => original.lstat(local(path)),
    open: (path: string, flags: number) => original.open(local(path), flags),
  };
});

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'vonvon-windows-status-'));
  mkdirSync(join(fixture.directory, 'C', 'Vonvon', 'service'), { recursive: true });
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  fixture.owner.mockResolvedValue(null);
  fixture.verify.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  rmSync(fixture.directory, { recursive: true, force: true });
});

function response(value: unknown) {
  fixture.query.mockReturnValue({ status: 0, stdout: JSON.stringify(value), stderr: '' });
}

async function launcher(rootPath = 'C:\\Vonvon') {
  mkdirSync(join(fixture.directory, ...rootPath.split(/[:\\]+/), 'service'), { recursive: true });
  const root = await resolveServiceRoot(rootPath);
  const target = serviceTarget({ platform: 'win32', root });
  if (target.platform !== 'win32') throw new Error('Expected Windows target');
  const bytes = renderDefinition({ target, root, port: 43121, distribution: { kind: 'npm', executable: 'C:\\node\\node.exe', entry: 'C:\\app\\vonvon.mjs' }, capturedPath: 'C:\\Windows\\System32' });
  if (bytes.platform !== 'win32') throw new Error('Expected Windows definition');
  const directory = join(fixture.directory, ...rootPath.split(/[:\\]+/), 'service');
  writeFileSync(join(directory, win32.basename(target.cmdPath)), bytes.cmd);
  writeFileSync(join(directory, win32.basename(target.vbsPath)), bytes.vbs);
  response({ kind: 'value', type: 'REG_SZ', value: bytes.runValue });
  return { directory, target };
}

it.each([false, true])('reads actual launcher bytes and requires owner verification for running=%s', async running => {
  await launcher();
  const owner = { pid: 42, startedAt: 'now', listen: '127.0.0.1:43121' };
  fixture.owner.mockResolvedValue(running ? owner : null);
  const status = await getServiceAdapter().status();
  expect(status).toMatchObject({ installed: true, running });
  expect(status.pid).toBe(running ? '42' : undefined);
  expect(fixture.query).toHaveBeenCalledOnce();
  expect(fixture.verify).toHaveBeenCalledTimes(running ? 1 : 0);
  if (running) expect(fixture.verify).toHaveBeenCalledWith('C:\\Vonvon', owner);
});

it('reports confirmed absence despite leftover launchers and a live owner', async () => {
  await launcher();
  response({ kind: 'native-error', operation: 'query', code: 2 });
  fixture.owner.mockResolvedValue({ pid: 42, listen: '127.0.0.1:43121' });
  expect(await getServiceAdapter().status()).toMatchObject({ installed: false, running: false, raw: expect.stringContaining('Leftover launcher files') });
  expect(fixture.verify).not.toHaveBeenCalled();
});

it('rejects a generated launcher for another root through the real registration classifier', async () => {
  await launcher('D:\\Other');
  await expect(getServiceAdapter().status()).rejects.toThrow('belongs to D:\\Other');
  expect(fixture.owner).not.toHaveBeenCalled();
});

it('rejects malformed launcher bytes instead of trusting a valid Run locator', async () => {
  const { directory, target } = await launcher();
  writeFileSync(join(directory, win32.basename(target.cmdPath)), 'invalid');
  await expect(getServiceAdapter().status()).rejects.toThrow('Unrecognized');
  expect(fixture.owner).not.toHaveBeenCalled();
});

it('propagates raw native failure through the reader, codec, host, and CLI without successful output', async () => {
  response({ kind: 'native-error', operation: 'open', code: 1015 });
  expect(readVonvonRunValue()).toEqual({ kind: 'unavailable', reason: 'Windows Run open failed (Win32 1015)' });
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await expect(controlDesktopService('status')).rejects.toThrow('Win32 1015');
  await expect(runServiceStatus(true)).rejects.toThrow('Win32 1015');
  expect(output).not.toHaveBeenCalled();
  expect(fixture.owner).not.toHaveBeenCalled();
});
