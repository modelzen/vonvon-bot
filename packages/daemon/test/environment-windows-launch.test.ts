import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentService } from '../src/environment/service';
import { mergeProcessEnv, spawnProcess } from '../src/platform/spawn';

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

it.skipIf(process.platform !== 'win32')('records sequential Windows bootstrap controls without changing native acceptance', async () => {
  const controls = [
    { id: 'baseline-ignore', mode: 'plain', stdin: 'ignore', inherit: false },
    { id: 'qualified-ignore', mode: 'qualified', stdin: 'ignore', inherit: false },
    { id: 'baseline-closed-pipe', mode: 'plain', stdin: 'pipe', inherit: false },
    { id: 'inherited-ignore', mode: 'plain', stdin: 'ignore', inherit: true },
    { id: 'explicit-utility-import', mode: 'import', stdin: 'ignore', inherit: false },
    { id: 'baseline-repeat', mode: 'plain', stdin: 'ignore', inherit: false },
  ] as const;
  for (const control of controls) {
    const home = await mkdtemp(join(tmpdir(), 'environment-windows-bootstrap-'));
    const fixture = join(home, 'fixture.cjs');
    await writeFile(fixture, "process.stdout.write('fixture-started');\n");
    const stages: Record<'script-enter' | 'before-add' | 'after-add' | 'run-enter', number | null> = {
      'script-enter': null, 'before-add': null, 'after-add': null, 'run-enter': null,
    };
    const observation: {
      closed: boolean; verifiedEmpty: boolean; fixtureStarted: boolean; timedOut: boolean;
      commandFailed: boolean; spawnError: boolean; code: number | null; signal: NodeJS.Signals | null;
    } = {
      closed: false, verifiedEmpty: false, fixtureStarted: false, timedOut: false,
      commandFailed: false, spawnError: false, code: null, signal: null,
    };
    let startedAt = performance.now();
    let stderrTail = '';
    let stdoutTail = '';
    const emit = (event: 'stage' | 'close' | 'settled' | 'drained') => {
      writeSync(2, `${JSON.stringify({ diagnostic: 'windows-bootstrap', control: control.id, event, elapsedMs: Math.round(performance.now() - startedAt), stages, ...observation })}\n`);
    };
    const service: EnvironmentService = new EnvironmentService({
      home, getDataRoot: () => home, nodePath: process.execPath,
      resolveCodex: () => null, path: home, fetchLatest: async () => null,
      spawnProcess: (command, args, options) => {
        if (!args || args.filter(arg => arg === '-EncodedCommand').length !== 1) throw new Error('Expected one encoded bootstrap');
        const index = args.indexOf('-EncodedCommand') + 1;
        const encoded = args[index];
        if (!encoded || index !== args.length - 1) throw new Error('Expected final encoded bootstrap');
        let script = Buffer.from(encoded, 'base64').toString('utf16le');
        if (Buffer.from(script, 'utf16le').toString('base64') !== encoded) throw new Error('Invalid encoded bootstrap');
        const marker = (stage: keyof typeof stages) => `[Console]::Error.WriteLine('vonvon-bootstrap:${stage}'); `;
        const add = control.mode === 'qualified' ? 'Microsoft.PowerShell.Utility\\Add-Type' : 'Add-Type';
        const prelude = control.mode === 'import'
          ? "Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); " : '';
        const replacements = [
          ["$ErrorActionPreference='Stop'; ", `$ErrorActionPreference='Stop'; ${marker('script-enter')}`],
          ['Add-Type -TypeDefinition ', `${marker('before-add')}${prelude}${add} -TypeDefinition `],
          ['; exit ([CodexJob]::Run(', `; ${marker('after-add')}exit ([CodexJob]::Run(`],
          ['string stage="stop-check";', 'string stage="stop-check"; try { Console.Error.WriteLine("vonvon-bootstrap:run-enter"); } catch {}'],
        ] as const;
        for (const [needle] of replacements) {
          if (script.split(needle).length !== 2) throw new Error('Bootstrap instrumentation count mismatch');
        }
        for (const [needle, replacement] of replacements) script = script.replace(needle, replacement);
        if (!Array.isArray(options?.stdio) || options.stdio.join(',') !== 'ignore,pipe,pipe' || !options.env) {
          throw new Error('Unexpected fixture launch options');
        }
        const env = control.inherit ? mergeProcessEnv(process.env, options.env) : options.env;
        for (const key of ['HOME', 'USERPROFILE', 'PATH']) {
          const matches = Object.keys(env).filter(candidate => candidate.toLowerCase() === key.toLowerCase());
          const matched = matches[0];
          if (matches.length !== 1 || matched === undefined || env[matched] !== options.env[key]) throw new Error('Fixture environment isolation lost');
        }
        const instrumentedArgs = [...args];
        instrumentedArgs[index] = Buffer.from(script, 'utf16le').toString('base64');
        startedAt = performance.now();
        const child = spawnProcess(command, instrumentedArgs, { ...options, env, stdio: [control.stdin, 'pipe', 'pipe'] });
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutTail = (stdoutTail + chunk.toString()).slice(-64);
          observation.fixtureStarted ||= stdoutTail.includes('fixture-started');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-16_384);
          for (const stage of ['script-enter', 'before-add', 'after-add', 'run-enter'] as const) {
            if (stages[stage] === null && new RegExp(`(?:^|[\r\n])vonvon-bootstrap:${stage}[\r\n]`).test(stderrTail)) {
              stages[stage] = Math.round(performance.now() - startedAt);
              emit('stage');
            }
          }
        });
        child.once('error', () => { observation.spawnError = true; });
        child.once('close', (code, signal) => {
          observation.closed = true;
          observation.code = code;
          observation.signal = signal;
          observation.verifiedEmpty = service['children'].get(child)?.job?.verifiedEmpty === true;
          emit('close');
        });
        if (control.stdin === 'pipe') child.stdin?.end();
        return child;
      },
    });
    try {
      await service['command'](process.execPath, [fixture], 10_000).catch(error => {
        observation.commandFailed = true;
        observation.timedOut = error instanceof Error && error.message === '操作超时。';
      });
      emit('settled');
      expect(observation.closed && observation.verifiedEmpty, 'Unconfirmed ownership; matrix stopped and fixture retained').toBe(true);
    } finally {
      await service.close();
      if (observation.closed && observation.verifiedEmpty) {
        emit('drained');
        await rm(home, { recursive: true, force: true });
      }
    }
  }
}, 180_000);

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
