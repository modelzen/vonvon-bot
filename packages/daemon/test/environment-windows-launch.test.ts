import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentService } from '../src/environment/service';

it.each([
  { comspec: 'D:\\System Tools\\cmd.exe', systemRoot: 'C:\\Windows', expected: 'D:\\System Tools\\cmd.exe' },
  { comspec: undefined, systemRoot: 'D:\\Windows', expected: 'D:\\Windows\\System32\\cmd.exe' },
  { comspec: undefined, systemRoot: undefined, expected: 'C:\\Windows\\System32\\cmd.exe' },
])('supplies command interpreter $expected without inheriting unrelated variables', async ({ comspec, systemRoot, expected }) => {
  const home = await mkdtemp(join(tmpdir(), 'environment-windows-contract-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Missing platform descriptor');
  const originalComSpec = process.env.ComSpec;
  const originalSentinel = process.env.VONVON_FIXTURE_SECRET;
  const originalSystemRoot = process.env.SystemRoot;
  try {
    if (comspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = comspec;
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    process.env.VONVON_FIXTURE_SECRET = 'must-not-be-forwarded';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let environment: NodeJS.ProcessEnv = {};
    const service = new EnvironmentService({
      home, getDataRoot: () => home, nodePath: process.execPath, resolveCodex: () => null, path: home,
      spawnProcess: (_command, _args, options) => {
        environment = options?.env ?? {};
        throw new Error('captured Windows launch');
      },
    });
    expect(() => service['launch'](join(home, 'fixture.cmd'), [])).toThrow('captured Windows launch');
    expect(environment).toMatchObject({ HOME: home, USERPROFILE: home, ComSpec: expected });
    expect(environment.SystemRoot).toBe(systemRoot ?? 'C:\\Windows');
    expect(environment.PATH).toContain(`${systemRoot ?? 'C:\\Windows'}\\System32`);
    expect(environment.VONVON_FIXTURE_SECRET).toBeUndefined();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    if (originalSentinel === undefined) delete process.env.VONVON_FIXTURE_SECRET;
    else process.env.VONVON_FIXTURE_SECRET = originalSentinel;
    await rm(home, { recursive: true, force: true });
  }
});
