import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget } from '../src/service/identity';
import { readRegistration, type WindowsRunObservation } from '../src/service/registration';

const filesystem = vi.hoisted(() => {
  const files = new Map<string, Buffer | Error>();
  const roots = new Set<string>();
  const metadata = (bytes: Buffer) => ({ isFile: () => true, dev: 1, ino: 1, size: bytes.length });
  function contents(path: string) {
    const file = files.get(path);
    if (file instanceof Error) throw file;
    if (!file) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
    return file;
  }
  return {
    files,
    roots,
    realpath: vi.fn(async (path: string) => {
      if (!roots.has(path)) throw Object.assign(new Error('Missing root'), { code: 'ENOENT' });
      return path;
    }),
    stat: vi.fn(async (path: string) => ({ isDirectory: () => roots.has(path) })),
    lstat: vi.fn(async (path: string) => metadata(contents(path))),
    open: vi.fn(async (path: string) => {
      const bytes = contents(path);
      let position = 0;
      return {
        stat: async () => metadata(bytes),
        read: async (buffer: Buffer, offset: number, length: number) => {
          const bytesRead = bytes.copy(buffer, offset, position, position + length);
          position += bytesRead;
          return { bytesRead, buffer };
        },
        close: async () => {},
      };
    }),
  };
});
vi.mock('node:fs/promises', () => filesystem);

beforeEach(() => {
  filesystem.files.clear();
  filesystem.roots.clear();
  vi.clearAllMocks();
});

async function fixture(path = 'C:\\Users\\owner\\Vonvon') {
  filesystem.roots.add(path);
  const root = await resolveServiceRoot(path);
  const target = serviceTarget({ platform: 'win32', root });
  if (target.platform !== 'win32') throw new Error('Expected Windows target');
  const definition = { root, port: 43121, distribution: { kind: 'npm' as const, executable: 'C:\\node\\node.exe', entry: 'C:\\app\\vonvon.mjs' }, capturedPath: 'C:\\Windows\\System32' };
  const bytes = renderDefinition({ ...definition, target });
  if (bytes.platform !== 'win32') throw new Error('Expected Windows bytes');
  filesystem.files.set(target.cmdPath, Buffer.from(bytes.cmd));
  filesystem.files.set(target.vbsPath, Buffer.from(bytes.vbs));
  return { target, requestedRoot: root, definition, bytes };
}

function expectNoLauncherReads() {
  expect(filesystem.lstat).not.toHaveBeenCalled();
  expect(filesystem.open).not.toHaveBeenCalled();
}

describe('Windows registration with controlled filesystem observations on every host', () => {
  for (const leftovers of ['complete', 'only-vbs', 'only-cmd', 'malformed', 'unreadable', 'none'] as const) {
    it(`reports absent without inspecting ${leftovers} leftovers when the global Run value is absent`, async () => {
      const input = await fixture();
      if (leftovers === 'only-vbs' || leftovers === 'none') filesystem.files.delete(input.target.cmdPath);
      if (leftovers === 'only-cmd' || leftovers === 'none') filesystem.files.delete(input.target.vbsPath);
      if (leftovers === 'malformed') filesystem.files.set(input.target.vbsPath, Buffer.from('invalid'));
      if (leftovers === 'unreadable') filesystem.files.set(input.target.vbsPath, Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      expect(await readRegistration({ ...input, windowsRun: { kind: 'absent' } })).toEqual({ kind: 'absent' });
      expectNoLauncherReads();
    });
  }

  it('reports absent for another root without checking either roots launchers', async () => {
    const input = await fixture();
    const other = await fixture('D:\\Other');
    expect(await readRegistration({ ...input, requestedRoot: other.requestedRoot, windowsRun: { kind: 'absent' } })).toEqual({ kind: 'absent' });
    expectNoLauncherReads();
  });

  it('keeps requested-root validation before absent classification', async () => {
    const input = await fixture();
    expect(await readRegistration({ ...input, requestedRoot: 'C:\\missing', windowsRun: { kind: 'absent' } })).toMatchObject({ kind: 'unrecognized', reason: 'Missing root' });
    expectNoLauncherReads();
  });

  const denied: WindowsRunObservation[] = [
    { kind: 'unavailable', reason: 'Access denied' },
    { kind: 'value', type: 'REG_SZ', value: 'malformed' },
    { kind: 'value', type: 'REG_EXPAND_SZ', value: 'wscript.exe //B "C:\\Vonvon\\service\\vonvon-bot.vbs"' },
  ];
  for (const observation of denied) {
    it(`denies ${JSON.stringify(observation)} without reading local leftovers`, async () => {
      const input = await fixture();
      expect((await readRegistration({ ...input, windowsRun: observation })).kind).toBe('unrecognized');
      expectNoLauncherReads();
    });
  }

  it('recognizes a valid Run value as ours and follows it to another root', async () => {
    const input = await fixture();
    const windowsRun = { kind: 'value' as const, type: 'REG_SZ' as const, value: input.bytes.runValue };
    expect(await readRegistration({ ...input, windowsRun })).toEqual({ kind: 'ours', definition: input.definition });
    const other = await fixture('D:\\Other');
    expect(await readRegistration({ ...other, windowsRun })).toEqual({ kind: 'other-root', recordedRoot: input.requestedRoot, definition: input.definition });
    expect(filesystem.open.mock.calls.map(([path]) => path)).toEqual([input.target.vbsPath, input.target.cmdPath, input.target.vbsPath, input.target.cmdPath]);
  });

  for (const damage of ['missing-cmd', 'malformed-vbs', 'unreadable-vbs'] as const) {
    it(`denies a present Run value with ${damage}`, async () => {
      const input = await fixture();
      if (damage === 'missing-cmd') filesystem.files.delete(input.target.cmdPath);
      if (damage === 'malformed-vbs') filesystem.files.set(input.target.vbsPath, Buffer.from('invalid'));
      if (damage === 'unreadable-vbs') filesystem.files.set(input.target.vbsPath, Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      expect((await readRegistration({ ...input, windowsRun: { kind: 'value', type: 'REG_SZ', value: input.bytes.runValue } })).kind).toBe('unrecognized');
    });
  }
});
