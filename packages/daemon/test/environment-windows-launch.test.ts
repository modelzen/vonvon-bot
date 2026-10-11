import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentService } from '../src/environment/service';
import { spawnProcess } from '../src/platform/spawn';

for (const kind of ['exe', 'cmd'] as const) {
  it.skipIf(process.platform !== 'win32')(`launches a ${kind} tool through its Windows job with an isolated home and PATH`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'environment-windows-launch-'));
    const cli = join(home, 'fixture.cmd');
    await writeFile(join(home, 'fixture.cjs'), "process.stdout.write('fixture-started');\n");
    await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
    const diagnostic: { stderr: string; error?: string; code?: number | null; signal?: string | null } = { stderr: '' };
    const service = new EnvironmentService({
      home, getDataRoot: () => home, nodePath: process.execPath,
      resolveCodex: () => null, path: home, fetchLatest: async () => null,
      spawnProcess: (command, args, options) => {
        const child = spawnProcess(command, args, options);
        child.stderr?.on('data', (chunk: Buffer) => { diagnostic.stderr = (diagnostic.stderr + chunk.toString()).slice(-16_384); });
        child.on('error', error => { diagnostic.error = error.message.slice(-2_048); });
        child.on('close', (code, signal) => { diagnostic.code = code; diagnostic.signal = signal; });
        return child;
      },
    });
    try {
      const result = await service['command'](
        kind === 'exe' ? process.execPath : cli,
        kind === 'exe' ? [join(home, 'fixture.cjs')] : [],
        10_000,
      ).catch(error => {
        diagnostic.error = (error instanceof Error ? error.message : String(error)).slice(-2_048);
        return { failure: diagnostic.error };
      });
      writeSync(2, `${JSON.stringify({ kind, stderr: diagnostic.stderr, error: diagnostic.error ?? null, code: diagnostic.code ?? null, signal: diagnostic.signal ?? null })}\n`);
      expect(result, JSON.stringify(diagnostic)).toMatchObject({ exitCode: 0, stdout: 'fixture-started' });
    } finally {
      await service.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
}

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
