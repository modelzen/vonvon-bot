import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type ServiceDefinitionOptions } from '../src/service/common';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from '../src/service/identity';
import { buildLauncherCmd, SERVICE_ENV_FLAG } from '../src/service/win-startup';
import {
  CODEX_PATH_SCENARIOS,
  NEW_CODEX_VERSION,
  OLD_CODEX_VERSION,
  prepareCodexSelection,
  type CodexPathScenario,
  type CodexSelectionFixture,
} from './helpers/codex-selection-fixture';

// Deliberately opt-in: ordinary `npm test` must not register even a temporary
// service. These tests never call the bridge's install/start/restart functions.
const enabled = process.env.FEISHU_BRIDGE_NATIVE_SERVICE_TEST === '1';
const timeoutMs = 15_000;

interface WorkerEvent {
  pid: number;
  argv: string[];
  path: string;
  serviceFlag: string | null;
  codexBin?: string | null;
  selected?: string | null;
  version?: string | null;
}

interface Fixture {
  root: string;
  name: string;
  options: Required<Pick<ServiceDefinitionOptions, 'cliBinPath' | 'stdoutPath' | 'stderrPath' | 'envPath'>>;
  events: () => Promise<WorkerEvent[]>;
  selection?: CodexSelectionFixture;
  teardown?: {
    actions: Array<() => void | Promise<void>>;
    manualCommands: string[];
  };
}

function command(executable: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: timeoutMs, env });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

async function cleanup(actions: Array<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Native service cleanup failed');
}

async function withFixture(keepAlive: boolean, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-bridge-smoke-'));
  // Keep worker/log paths plain so special-path scenarios isolate CODEX_BIN.
  const folder = join(root, 'worker');
  await mkdir(folder);
  const eventPath = join(root, 'events.jsonl');
  const options = {
    cliBinPath: join(folder, 'fake-cli.mjs'),
    stdoutPath: join(folder, 'stdout.log'),
    stderrPath: join(folder, 'stderr.log'),
    // An intentionally unique PATH that neither the test runner nor the OS
    // service manager has: only the generated definition can restore it.
    envPath: join(folder, 'tools'),
  };
  await writeFile(options.cliBinPath, `
import { appendFileSync } from 'node:fs';
console.log('smoke stdout');
console.error('smoke stderr');
appendFileSync(${JSON.stringify(eventPath)}, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  path: process.env.PATH,
  serviceFlag: process.env.${SERVICE_ENV_FLAG} ?? null,
}) + '\\n');
${keepAlive ? 'setInterval(() => {}, 1000);' : ''}
`, 'utf8');
  const fixture: Fixture = {
    root,
    name: `feishu-bridge-smoke-${randomUUID()}`,
    options,
    events: async () => {
      const text = await readFile(eventPath, 'utf8').catch(() => '');
      // Only consume complete lines while another process is writing.
      return text.split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent);
    },
  };
  const failures: unknown[] = [];
  try {
    await body(fixture);
  } catch (error) {
    failures.push(error);
  }
  let teardownConfirmed = true;
  if (fixture.teardown) {
    try {
      await cleanup(fixture.teardown.actions);
    } catch (error) {
      teardownConfirmed = false;
      failures.push(error);
    }
  }
  if (failures.length) {
    for (const file of [options.stdoutPath, options.stderrPath]) {
      console.error(`${file}:\n${await readFile(file, 'utf8').catch(() => '(not created)')}`);
    }
  }
  if (teardownConfirmed) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      failures.push(error);
    }
  } else {
    const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
    const instructions = [
      `Teardown was not confirmed. Retained fixture: ${root}`,
      `Manual cleanup for isolated service ${fixture.name}:`,
      ...fixture.teardown!.manualCommands,
      'After confirming the service is removed and the worker PIDs in events.jsonl have exited, remove the fixture:',
      `rm -rf -- ${quote(root)}`,
    ].join('\n');
    throw new AggregateError(failures, instructions);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `Native service test and cleanup failed; fixture: ${root}`);
}

function expectWorker(event: WorkerEvent, fixture: Fixture, serviceFlag: string | null): void {
  expect(event.pid).toBeGreaterThan(0);
  expect(event.argv).toEqual(['run']);
  expect(event.path).toBe(fixture.options.envPath);
  expect(event.serviceFlag).toBe(serviceFlag);
  if (fixture.selection) {
    console.info('CODEX_BIN background readback:', JSON.stringify(event));
    expect(event.selected).toBe(fixture.selection.newBin);
    expect(event.version).toBe(NEW_CODEX_VERSION);
    expect(event.codexBin).toBe(fixture.selection.newBin);
  }
}

async function withCodexSelection(
  keepAlive: boolean,
  scenario: CodexPathScenario,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  await withFixture(keepAlive, async (fixture) => {
    const selection = await prepareCodexSelection(fixture.root, fixture.options.cliBinPath, keepAlive, scenario);
    fixture.selection = selection;
    fixture.options.envPath = selection.path;
    const foreground = (env: NodeJS.ProcessEnv): WorkerEvent => JSON.parse(command(
      process.execPath, [fixture.options.cliBinPath, 'foreground'], env,
    ));
    const old = foreground(selection.environment);
    console.info(`CODEX_BIN ${scenario}, PATH-only foreground:`, JSON.stringify(old));
    expect(old.selected).toBe(selection.oldBin);
    expect(old.version).toBe(OLD_CODEX_VERSION);
    const selected = foreground({ ...selection.environment, CODEX_BIN: selection.newBin });
    console.info(`CODEX_BIN ${scenario}, explicit foreground:`, JSON.stringify(selected));
    expect(selected.selected).toBe(selection.newBin);
    expect(selected.version).toBe(NEW_CODEX_VERSION);
    await body(fixture);
  });
}

function definitionWithSelection(fixture: Fixture, build: () => string): string {
  // Installation sees the user's override, but it is restored before any
  // service starts. No asynchronous work can leak this temporary setting.
  const previous = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = fixture.selection!.newBin;
    return build();
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
}

describe.skipIf(!enabled)('native service smoke tests (explicit opt-in)', () => {
  it.runIf(process.platform === 'win32').each(CODEX_PATH_SCENARIOS)('preserves selected Codex across fresh cmd launches (%s)', async (scenario) => {
    await withCodexSelection(false, scenario, async (fixture) => {
      const launcher = join(fixture.root, 'launcher with spaces.cmd');
      await writeFile(launcher, definitionWithSelection(fixture, () => buildLauncherCmd(fixture.options)), 'utf8');
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) throw new Error('SystemRoot is required for the native Windows test');
      const cmdExe = join(systemRoot, 'System32', 'cmd.exe');
      // No inherited PATH, service flag, account tokens, or bridge configuration.
      const cleanEnv = {
        ...fixture.selection!.environment,
        PATH: join(fixture.root, 'empty-parent-path'),
      };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = spawnSync(cmdExe, ['/d', '/v:on', '/s', '/c', `""${launcher}""`], {
          env: cleanEnv,
          encoding: 'utf8',
          windowsVerbatimArguments: true,
          timeout: timeoutMs,
        });
        if (result.error || result.status !== 0) {
          throw new Error(`cmd.exe failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
        }
        const events = await fixture.events();
        expect(events).toHaveLength(attempt);
        expectWorker(events[attempt - 1]!, fixture, '1');
      }
      // A second invocation must append both streams, rather than truncate logs.
      expect((await readFile(fixture.options.stdoutPath, 'utf8')).match(/smoke stdout/g)).toHaveLength(2);
      expect((await readFile(fixture.options.stderrPath, 'utf8')).match(/smoke stderr/g)).toHaveLength(2);
    });
  }, 60_000);

  it.runIf(process.platform === 'darwin')('parses the fixed launchd definition with native plutil', async () => {
    await withFixture(false, async (fixture) => {
      const root = await resolveServiceRoot(fixture.root);
      const plistPath = join(root, 'definition.plist');
      const rendered = renderDefinition({ target: { platform: 'darwin', plistPath }, root, port: 32123,
        distribution: { kind: 'npm', executable: process.execPath, entry: fixture.options.cliBinPath! }, capturedPath: fixture.options.envPath! });
      if (rendered.platform !== 'darwin') throw new Error('Expected plist');
      await writeFile(plistPath, rendered.plist);
      command('/usr/bin/plutil', ['-lint', plistPath]);
      const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
      expect(plist.Label).toBe(LAUNCHD_LABEL);
      expect(plist.ProgramArguments).toEqual([process.execPath, fixture.options.cliBinPath, 'daemon', 'run', '--port', '32123']);
      expect(plist.EnvironmentVariables.PATH).toBe(fixture.options.envPath);
      expect(plist.StandardOutPath).toBe(join(root, 'service.log'));
      expect(plist.StandardErrorPath).toBe(join(root, 'service.err.log'));
    });
  });
});

it.runIf(process.platform === 'linux')('parses the fixed Linux definition offline with systemd-analyze', async ({ skip }) => {
  const available = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT') skip('systemd-analyze is unavailable');
  expect(available.status, available.stderr).toBe(0);
  await withFixture(false, async fixture => {
    const root = await resolveServiceRoot(fixture.root);
    const unitPath = join(root, SYSTEMD_UNIT_NAME);
    const rendered = renderDefinition({ target: { platform: 'linux', unitPath }, root, port: 32123,
      distribution: { kind: 'npm', executable: process.execPath, entry: fixture.options.cliBinPath }, capturedPath: fixture.options.envPath });
    if (rendered.platform !== 'linux') throw new Error('Expected unit');
    await writeFile(unitPath, rendered.unit);
    command('systemd-analyze', ['verify', unitPath]);
    const unit = Buffer.from(rendered.unit).toString();
    expect(unit).toContain('daemon run --port 32123');
    expect(unit).toContain(`Environment="PATH=${fixture.options.envPath}"`);
    expect(unit).toContain(`StandardOutput=append:${root}/service.log`);
    expect(unit).toContain(`StandardError=append:${root}/service.err.log`);
    expect(unit).not.toContain('CODEX_BIN');
  });
});

// Failure-path checks use only files and injected callbacks, never an OS
// service. They can run safely as part of the ordinary unit suite.
describe('native service harness cleanup', () => {
  it('retains the fixture and both errors when test and teardown fail', async () => {
    const primary = new Error('worker startup failed');
    const teardown = new Error('service stop failed');
    const laterCleanup = vi.fn();
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root = '';
    try {
      let failure: unknown;
      try {
        await withFixture(false, async (fixture) => {
          root = fixture.root;
          fixture.teardown = {
            actions: [() => { throw teardown; }, laterCleanup],
            manualCommands: ['stop-the-isolated-test-service'],
          };
          throw primary;
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure as AggregateError;
      expect(aggregate.errors[0]).toBe(primary);
      expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
      expect((aggregate.errors[1] as AggregateError).errors).toEqual([teardown]);
      expect(aggregate.message).toContain(root);
      expect(aggregate.message).toContain('stop-the-isolated-test-service');
      expect(laterCleanup).toHaveBeenCalledOnce();
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      diagnostics.mockRestore();
      // No service was started by the injected callbacks above.
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the original error and removes files after successful teardown', async () => {
    const primary = new Error('worker assertion failed');
    const teardown = vi.fn();
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root = '';
    try {
      await expect(withFixture(false, async (fixture) => {
        root = fixture.root;
        fixture.teardown = { actions: [teardown], manualCommands: [] };
        throw primary;
      })).rejects.toBe(primary);
      expect(teardown).toHaveBeenCalledOnce();
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      diagnostics.mockRestore();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });
});
