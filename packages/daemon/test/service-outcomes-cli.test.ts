import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { decodeGeneratedDefinition, renderDefinition } from '../src/service/definitions';
import { LAUNCHD_LABEL, resolveServiceRoot, SYSTEMD_UNIT_NAME, type CanonicalRoot } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';

type Owner = { pid: number; startedAt: string; listen: string };
type State = {
  loaded: boolean;
  enabled: boolean;
  pid: number;
  owner: Owner | null;
  failure: 'none' | 'query_failed' | 'stop_unconfirmed' | 'unload_failed' | 'owner_unproven'
    | 'install_load_failed' | 'rollback_query_failed' | 'rollback_stop_unconfirmed' | 'rollback_unload_failed'
    | 'step5_stop_unconfirmed';
  calls: string[];
  stops: number[];
  ownerReads: number;
  work: string[];
  newBytesBase64: string | null;
};

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli/index.ts');
const adapterDir = resolve(dirname(fileURLToPath(import.meta.url)), 'service-outcomes-cli');
const folders: string[] = [];
const entries: Record<'linux' | 'darwin' | 'win32', string> = { linux: '', darwin: '', win32: '' };
beforeAll(async () => {
  const cache = resolve(dirname(source), '../../../../node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(join(cache, 'vonvon-outcomes-build-'));
  folders.push(folder);
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const adapter = join(adapterDir, `${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'}-adapter.ts`);
    entries[platform] = join(folder, `${platform}-cli.mjs`);
    let intercepted = false;
    await build({
      entryPoints: [source], outfile: entries[platform], bundle: true, platform: 'node', format: 'esm', packages: 'external',
      plugins: [{ name: 'fake-os-service-boundary', setup(plugin) {
        plugin.onLoad({ filter: /[\\/]src[\\/]service[\\/]adapter\.ts$/ }, () => {
          intercepted = true;
          return { contents: `export { getServiceAdapter } from ${JSON.stringify(adapter)};`, loader: 'js', resolveDir: dirname(adapter) };
        });
      } }],
    });
    expect(intercepted).toBe(true);
  }
});
afterAll(async () => { for (const folder of folders) await rm(folder, { recursive: true, force: true }); });

const owner: Owner = { pid: 41001, startedAt: '2026-10-12T00:00:00Z', listen: '127.0.0.1:32123' };
const show = `show -p LoadState -p FragmentPath -p MainPID ${SYSTEMD_UNIT_NAME}`;
const pid = `show -p MainPID --value ${SYSTEMD_UNIT_NAME}`;
const enabled = `is-enabled ${SYSTEMD_UNIT_NAME}`;

async function runCase(options: { action?: 'install' | 'uninstall'; port?: number; installed: boolean; loaded: boolean; owner: Owner | null; pid: number; failure: State['failure'] }) {
  const folder = await mkdtemp(join(tmpdir(), 'vonvon-outcomes-case-'));
  folders.push(folder);
  await mkdir(join(folder, 'data'));
  const root = await resolveServiceRoot(join(folder, 'data'));
  const config = join(folder, 'config');
  const unitPath = join(config, 'systemd', 'user', SYSTEMD_UNIT_NAME);
  const statePath = join(folder, 'state.json');
  if (options.installed) {
    await mkdir(dirname(unitPath), { recursive: true });
    const definition = renderDefinition({ target: { platform: 'linux', unitPath }, root, port: 32123,
      distribution: { kind: 'npm', executable: '/fixture/bin/node', entry: '/fixture/bin/vonvon.mjs' }, capturedPath: '/fixture/bin' });
    if (definition.platform !== 'linux') throw new Error('Expected Linux definition');
    await writeFile(unitPath, definition.unit);
  }
  const before = options.installed ? await readFile(unitPath) : null;
  await writeFile(statePath, JSON.stringify({ loaded: options.loaded, enabled: options.installed, pid: options.pid,
    owner: options.owner, failure: options.failure, calls: [], stops: [], ownerReads: 0,
    work: options.owner ? ['owned-work'] : [], newBytesBase64: null } satisfies State));
  const child = spawnSync(process.execPath, [entries.linux, 'service', options.action ?? 'uninstall', ...(options.port ? ['--port', String(options.port)] : [])], {
    cwd: folder,
    env: { ...process.env, NODE_OPTIONS: '', PATH: join(folder, 'no-manager-bin'), HOME: folder,
      XDG_CONFIG_HOME: config, VONVON_HOME: root, VONVON_OUTCOMES_STATE: statePath },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const state: State = JSON.parse(await readFile(statePath, 'utf8'));
  const after = await readFile(unitPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return { child, state, before, after, root, unitPath };
}

it('distinguishes the absent no-row result from Outcomes row 6', async () => {
  const result = await runCase({ installed: false, loaded: false, owner: null, pid: 0, failure: 'none' });
  expect(result.child.status, result.child.stderr).toBe(0);
  expect(result.child.stdout).toContain('not-installed:');
  expect(result.after).toBeNull();
  expect(result.state.calls).toEqual([show, show, enabled]);
  expect(result.state.stops).toEqual([]);
});

it('row 1 uninstalls ours through the actual CLI without restarting', async () => {
  const result = await runCase({ installed: true, loaded: true, owner: null, pid: 0, failure: 'none' });
  expect(result.child.status, result.child.stderr).toBe(0);
  expect(result.child.stdout).toContain('uninstalled:');
  expect(result.before).not.toBeNull();
  expect(result.after).toBeNull();
  expect(result.state.enabled).toBe(false);
  expect(result.state.loaded).toBe(false);
  expect(result.state.owner).toBeNull();
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, show, enabled]);
});

it('row 2 restores kept bytes after a failed drain and exits 1', async () => {
  const result = await runCase({ installed: true, loaded: true, owner: null, pid: 0, failure: 'query_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_rolled_back:');
  expect(result.child.stderr).toContain('fixture MainPID query failed');
  expect(result.after).toEqual(result.before);
  expect(result.state.enabled).toBe(true);
  expect(result.state.loaded).toBe(true);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, `disable ${SYSTEMD_UNIT_NAME}`, pid, `enable ${SYSTEMD_UNIT_NAME}`, enabled, show, enabled]);
});

it('row 3 step 3 stop_unconfirmed leaves registration absent and exits 1', async () => {
  const result = await runCase({ installed: true, loaded: true, owner, pid: owner.pid, failure: 'stop_unconfirmed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_incomplete:');
  expect(result.child.stderr).toContain('stop_unconfirmed');
  expect(result.child.stderr).toContain('PID 41001');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['owned-work']);
  expect(result.state.stops).toEqual([41001]);
  expect(result.state.calls).toEqual([show, `disable ${SYSTEMD_UNIT_NAME}`, pid, show, enabled]);
});

it('row 3 step 5 stop_unconfirmed cannot restore an already unloaded unit', async () => {
  const result = await runCase({ installed: true, loaded: true, owner: null, pid: 0, failure: 'step5_stop_unconfirmed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_incomplete:');
  expect(result.child.stderr).toContain('stop_unconfirmed');
  expect(result.child.stderr).toContain('unit already unloaded');
  expect(result.after).toBeNull();
  expect(result.state.loaded).toBe(false);
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['new-job-work']);
  expect(result.state.stops).toEqual([41001]);
  expect(result.state.calls).toEqual([show, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, show, enabled]);
});

it('row 6 resumed uninstall retains an unrelated owner and its work', async () => {
  const result = await runCase({ installed: false, loaded: true, owner, pid: 0, failure: 'none' });
  expect(result.child.status, result.child.stderr).toBe(0);
  expect(result.child.stdout).toContain('uninstalled:');
  expect(result.child.stdout).toContain('Retained PID 41001');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['owned-work']);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, show, enabled]);
});

it('row 4 restores only kept bytes when Linux unload fails', async () => {
  const result = await runCase({ installed: true, loaded: true, owner: null, pid: 0, failure: 'unload_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_rolled_back:');
  expect(result.child.stderr).toContain('reset-failed');
  expect(result.after).toEqual(result.before);
  expect(result.state.enabled).toBe(true);
  expect(result.state.owner).toBeNull();
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`, enabled, show, enabled]);
});

it('row 7 resumed foreign job PID leaves its owner untouched', async () => {
  const result = await runCase({ installed: false, loaded: true, owner, pid: 42001, failure: 'none' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_incomplete:');
  expect(result.child.stderr).toContain('foreign_job_pid');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['owned-work']);
  expect(result.state.pid).toBe(42001);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, pid, show, enabled]);
});

it('row 8 resumed unload failure writes no definition and retains owner', async () => {
  const result = await runCase({ installed: false, loaded: true, owner, pid: 0, failure: 'unload_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_incomplete:');
  expect(result.child.stderr).toContain('reset-failed');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['owned-work']);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, enabled]);
});

it('row 7 resumed owner_unproven on Linux never stops or unloads', async () => {
  const result = await runCase({ installed: false, loaded: true, owner, pid: owner.pid, failure: 'owner_unproven' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_incomplete:');
  expect(result.child.stderr).toContain('owner_unproven');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['owned-work']);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual([show, pid, pid, show, enabled]);
});

it('row 7 resumed stop_unconfirmed leaves the same owner and no registration', async () => {
  const result = await runCase({ installed: false, loaded: true, owner, pid: owner.pid, failure: 'stop_unconfirmed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('uninstall_incomplete:');
  expect(result.child.stderr).toContain('stop_unconfirmed');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['owned-work']);
  expect(result.state.stops).toEqual([41001]);
  expect(result.state.calls).toEqual([show, pid, show, enabled]);
});

it('row 13 failed Linux install removes only its new definition', async () => {
  const result = await runCase({ action: 'install', installed: false, loaded: false, owner: null, pid: 0, failure: 'install_load_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('install_rolled_back:');
  expect(result.after).toBeNull();
  expect(result.state.owner).toBeNull();
  expect(result.state.enabled).toBe(false);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual(['is-system-running', show, enabled, 'daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, show, enabled]);
});

it('row 13 restores exact previous bytes without starting the old unit', async () => {
  const result = await runCase({ action: 'install', port: 32124, installed: true, loaded: true, owner: null, pid: 0, failure: 'install_load_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('install_rolled_back:');
  expect(result.after).toEqual(result.before);
  expect(result.after?.toString()).toContain('32123');
  expect(result.state.owner).toBeNull();
  expect(result.state.enabled).toBe(true);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual(['is-system-running', show, enabled, 'daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, `enable ${SYSTEMD_UNIT_NAME}`, enabled, show, enabled]);
});

it('row 14 rollback drain failure retains the newly written Linux definition', async () => {
  const result = await runCase({ action: 'install', port: 32124, installed: true, loaded: true,
    owner: null, pid: 0, failure: 'rollback_query_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('install_incomplete:');
  expect(result.child.stderr).toContain('fixture MainPID query failed');
  expect(result.child.stderr).toContain('previous definition was not restored');
  expect(result.state.newBytesBase64).not.toBeNull();
  expect(result.after).toEqual(Buffer.from(result.state.newBytesBase64 ?? '', 'base64'));
  expect(result.after).not.toEqual(result.before);
  expect(result.before?.toString()).toContain('32123');
  const registration = await readRegistration({ target: { platform: 'linux', unitPath: result.unitPath }, requestedRoot: result.root });
  expect(registration.kind).toBe('ours');
  if (registration.kind !== 'ours') throw new Error('Expected owned new definition');
  expect(registration.definition.port).toBe(32124);
  expect(result.state.loaded).toBe(true);
  expect(result.state.enabled).toBe(true);
  expect(result.state.owner).toBeNull();
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual(['is-system-running', show, enabled, 'daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, pid, `enable ${SYSTEMD_UNIT_NAME}`, enabled, show, enabled]);
});

it('row 15 rollback stop_unconfirmed restores neither Linux definition', async () => {
  const result = await runCase({ action: 'install', installed: false, loaded: false, owner: null, pid: 0, failure: 'rollback_stop_unconfirmed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('install_incomplete:');
  expect(result.child.stderr).toContain('stop_unconfirmed');
  expect(result.child.stderr).toContain('PID 41001');
  expect(result.child.stderr).toContain('neither definition was restored');
  expect(result.after).toBeNull();
  expect(result.state.owner).toEqual(owner);
  expect(result.state.work).toEqual(['new-job-work']);
  expect(result.state.stops).toEqual([41001]);
  expect(result.state.calls).toEqual(['is-system-running', show, enabled, 'daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, pid, show, enabled]);
});

it('row 16 failed Linux rollback unload leaves previous bytes absent', async () => {
  const result = await runCase({ action: 'install', installed: false, loaded: false, owner: null, pid: 0, failure: 'rollback_unload_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('install_incomplete:');
  expect(result.child.stderr).toContain('reset-failed');
  expect(result.after).toBeNull();
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual(['is-system-running', show, enabled, 'daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, show, enabled]);
});

it('row 16 restores exact previous bytes after Linux rollback unload failure', async () => {
  const result = await runCase({ action: 'install', port: 32124, installed: true, loaded: true, owner: null, pid: 0, failure: 'rollback_unload_failed' });
  expect(result.child.status).toBe(1);
  expect(result.child.stderr).toContain('install_incomplete:');
  expect(result.child.stderr).toContain('reset-failed');
  expect(result.after).toEqual(result.before);
  expect(result.after?.toString()).toContain('32123');
  expect(result.state.enabled).toBe(true);
  expect(result.state.stops).toEqual([]);
  expect(result.state.calls).toEqual(['is-system-running', show, enabled, 'daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, pid, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`, enabled, show, enabled]);
});

type MacState = {
  loaded: boolean;
  pid: number | null;
  owner: Owner | null;
  scenario: string;
  calls: string[];
  stops: number[];
  work: string[];
  clock: number;
  jobPrints: number;
  bootouts: number;
  bootstraps: number;
  newBytesBase64: string | null;
  ownerReads: number;
};
const macJob = `gui/501/${LAUNCHD_LABEL}`;
const macPrint = `print ${macJob}`;
const macBootout = `bootout ${macJob}`;

async function runMacCase(options: {
  action?: 'install' | 'uninstall'; port?: number; installed: boolean; loaded: boolean;
  owner?: Owner | null; pid?: number | null; scenario: string;
}) {
  const folder = await mkdtemp(join(tmpdir(), 'vonvon-outcomes-mac-'));
  folders.push(folder);
  const rootPath = join(folder, 'data');
  await mkdir(rootPath);
  const root = await resolveServiceRoot(rootPath);
  const home = join(folder, 'home');
  await mkdir(home);
  const plistPath = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const statePath = join(folder, 'state.json');
  if (options.installed) {
    await mkdir(dirname(plistPath), { recursive: true });
    const definition = renderDefinition({ target: { platform: 'darwin', plistPath }, root, port: 32123,
      distribution: { kind: 'npm', executable: '/fixture/bin/node', entry: '/fixture/bin/vonvon.mjs' }, capturedPath: '/fixture/bin' });
    if (definition.platform !== 'darwin') throw new Error('Expected macOS definition');
    await writeFile(plistPath, definition.plist);
  }
  const before = options.installed ? await readFile(plistPath) : null;
  await writeFile(statePath, JSON.stringify({ loaded: options.loaded, pid: options.pid ?? null,
    owner: options.owner ?? null, scenario: options.scenario, calls: [], stops: [],
    work: options.owner ? ['owned-work'] : [], clock: 0, jobPrints: 0, bootouts: 0,
    bootstraps: 0, newBytesBase64: null, ownerReads: 0 } satisfies MacState));
  const child = spawnSync(process.execPath, [entries.darwin, 'service', options.action ?? 'uninstall',
    ...(options.port ? ['--port', String(options.port)] : [])], {
    cwd: folder, env: { ...process.env, NODE_OPTIONS: '', PATH: join(folder, 'no-manager-bin'),
      HOME: home, VONVON_HOME: root, VONVON_OUTCOMES_STATE: statePath }, encoding: 'utf8', timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const state: MacState = JSON.parse(await readFile(statePath, 'utf8'));
  const after = await readFile(plistPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return { child, state, before, after, root, plistPath };
}

it('macOS row 1 uninstalls ours with one bootout', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'none' });
  expect(r.child.status, r.child.stderr).toBe(0);
  expect(r.child.stdout).toContain('uninstalled:');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(false);
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 2 restores exact kept plist when drain query fails', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'drain_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_rolled_back:');
  expect(r.child.stderr).toContain('fixture launchctl query failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([macPrint, macPrint]);
});

it('macOS row 3 step 3 stop_unconfirmed leaves no plist', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'step3_stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.child.stderr).toContain('41001');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual([macPrint, macPrint]);
});

it('macOS row 5 sends exactly one bootout and never restores on unknown unload', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'unload_unknown' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('jobPresent=true');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 5 records jobPresent=false after a failed bootout that removed the job', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'unload_unknown_false' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('jobPresent=false');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(false);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 5 records jobPresent=unknown after the post-bootout print errors', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'unload_unknown_query' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('jobPresent=unknown');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(false);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 6 resumed uninstall retains unrelated owner and work', async () => {
  const r = await runMacCase({ installed: false, loaded: true, owner, scenario: 'none' });
  expect(r.child.status, r.child.stderr).toBe(0);
  expect(r.child.stdout).toContain('Retained PID 41001');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS resumed absent with no leftovers returns the non-row not-installed result', async () => {
  const r = await runMacCase({ installed: false, loaded: false, scenario: 'none' });
  expect(r.child.status, r.child.stderr).toBe(0);
  expect(r.child.stdout).toContain('not-installed:');
  expect(r.after).toBeNull();
  expect(r.state.bootouts).toBe(0);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([macPrint]);
});

it('macOS row 7 resumed foreign job PID does not unload or signal', async () => {
  const r = await runMacCase({ installed: false, loaded: true, owner, pid: 42001, scenario: 'none' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('foreign_job_pid');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual([macPrint, macPrint]);
});

it('macOS row 7 resumed print failure cannot unload or stop the owner', async () => {
  const r = await runMacCase({ installed: false, loaded: true, owner, scenario: 'resumed_drain_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('fixture launchctl query failed');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual([macPrint, macPrint]);
});

it('macOS row 9 resumed unknown unload retains owner after one bootout', async () => {
  const r = await runMacCase({ installed: false, loaded: true, owner, scenario: 'unload_unknown' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('jobPresent=true');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 10 replacement drain failure restores exact previous plist', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: true,
    scenario: 'replacement_drain_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_rolled_back:');
  expect(r.child.stderr).toContain('fixture launchctl query failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.bootstraps).toBe(0);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, macPrint]);
});

it('macOS row 11 replacement stop_unconfirmed restores neither plist', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: true,
    scenario: 'replacement_stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.child.stderr).toContain('PID 41001');
  expect(r.child.stderr).toContain('fixture stop reply lost');
  expect(r.after).toBeNull();
  expect(r.before).not.toBeNull();
  expect(r.state.work).toEqual(['new-job-work']);
  expect(r.state.owner).toEqual(owner);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.bootstraps).toBe(0);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, macPrint]);
});

it('macOS row 12 replacement unknown unload never writes the new plist', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: true,
    scenario: 'replacement_unknown' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('jobPresent=true');
  expect(r.after).toBeNull();
  expect(r.state.bootouts).toBe(1);
  expect(r.state.bootstraps).toBe(0);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 18 failed bootstrap finds job but never bootouts', async () => {
  const r = await runMacCase({ action: 'install', installed: false, loaded: false,
    scenario: 'bootstrap_failed_found' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`, macPrint]);
});

it('macOS row 18 restores exact previous plist when failed bootstrap finds a job', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: false,
    scenario: 'bootstrap_failed_found' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.after).toEqual(r.before);
  expect(r.after?.toString()).toContain('32123');
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`, macPrint]);
});

it('macOS row 3 step 5 stop_unconfirmed follows unload without restoring plist', async () => {
  const r = await runMacCase({ installed: true, loaded: true, scenario: 'step5_stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.child.stderr).toContain('41001');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(false);
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['new-job-work']);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.calls).toEqual([macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 7 resumed owner_unproven retains owner without bootout', async () => {
  const r = await runMacCase({ installed: false, loaded: true, owner, pid: owner.pid,
    scenario: 'resumed_owner_unproven' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('owner_unproven');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual([macPrint, macPrint, macPrint]);
});

it('macOS row 7 resumed stop_unconfirmed retains owner without bootout', async () => {
  const r = await runMacCase({ installed: false, loaded: true, owner, pid: owner.pid,
    scenario: 'resumed_stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.after).toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual([macPrint, macPrint]);
});

it('macOS row 13 rollback removes new plist and leaves previous absent', async () => {
  const r = await runMacCase({ action: 'install', installed: false, loaded: false,
    scenario: 'rollback_success' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_rolled_back:');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(false);
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.bootstraps).toBe(1);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`,
    macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 13 restores exact previous plist without loading it', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: false,
    scenario: 'rollback_success' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_rolled_back:');
  expect(r.after).toEqual(r.before);
  expect(r.after?.toString()).toContain('32123');
  expect(r.state.loaded).toBe(false);
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.bootstraps).toBe(1);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`,
    macPrint, macPrint, macBootout, macPrint]);
});

it('macOS row 14 rollback drain failure restores exact new plist, not previous', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: false,
    scenario: 'rollback_drain_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('fixture launchctl query failed');
  expect(r.child.stderr).toContain('previous definition was not restored');
  expect(r.state.newBytesBase64).not.toBeNull();
  expect(r.after).toEqual(Buffer.from(r.state.newBytesBase64 ?? '', 'base64'));
  expect(r.after).not.toEqual(r.before);
  const registration = await readRegistration({ target: { platform: 'darwin', plistPath: r.plistPath }, requestedRoot: r.root });
  expect(registration.kind).toBe('ours');
  if (registration.kind !== 'ours') throw new Error('Expected owned new plist');
  expect(registration.definition.port).toBe(32124);
  expect(r.state.loaded).toBe(true);
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`,
    macPrint, macPrint]);
});

it('macOS row 15 rollback stop_unconfirmed restores neither plist', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: false,
    scenario: 'rollback_stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.child.stderr).toContain('PID 41001');
  expect(r.child.stderr).toContain('fixture stop reply lost');
  expect(r.child.stderr).toContain('was not unloaded');
  expect(r.child.stderr).toContain('neither the new nor the previous definition was restored');
  expect(r.after).toBeNull();
  expect(r.before).not.toBeNull();
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['new-job-work']);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(0);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`,
    macPrint, macPrint]);
});

it('macOS row 17 rollback unknown unload restores no plist', async () => {
  const r = await runMacCase({ action: 'install', port: 32124, installed: true, loaded: false,
    scenario: 'rollback_unknown' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('jobPresent=true');
  expect(r.after).toBeNull();
  expect(r.state.loaded).toBe(true);
  expect(r.state.bootouts).toBe(1);
  expect(r.state.bootstraps).toBe(1);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['print gui/501', macPrint, `bootstrap gui/501 ${r.plistPath}`,
    macPrint, macPrint, macBootout, macPrint]);
});

type WindowsState = {
  root: string;
  runValue: string | null;
  files: Record<string, string>;
  owner: Owner | null;
  work: string[];
  scenario: string;
  calls: string[];
  stops: number[];
  newCmdBase64: string | null;
  newVbsBase64: string | null;
  newRunValue: string | null;
};

async function runWindowsCase(options: {
  action?: 'install' | 'uninstall'; port?: number; installed: boolean; leftovers?: boolean;
  owner?: Owner | null; scenario: string;
}) {
  const folder = await mkdtemp(join(tmpdir(), 'vonvon-outcomes-win-'));
  folders.push(folder);
  const rootPath = `C:\\outcomes\\${basename(folder)}`;
  if (!win32.isAbsolute(rootPath)) throw new Error('Invalid Windows fixture root');
  const root = rootPath as CanonicalRoot;
  const cmdPath = win32.join(root, 'service', 'vonvon-bot.cmd');
  const vbsPath = win32.join(root, 'service', 'vonvon-bot.vbs');
  const statePath = join(folder, 'state.json');
  const dataHome = join(folder, 'data');
  await mkdir(dataHome);
  const files: Record<string, string> = {};
  let runValue: string | null = null;
  if (options.installed || options.leftovers) {
    const definition = renderDefinition({ target: { platform: 'win32', cmdPath, vbsPath }, root,
      port: 32123, distribution: { kind: 'npm', executable: 'C:\\fixture\\node.exe',
        entry: 'C:\\fixture\\vonvon.mjs' }, capturedPath: 'C:\\fixture' });
    if (definition.platform !== 'win32') throw new Error('Expected Windows launcher pair');
    files[cmdPath] = Buffer.from(definition.cmd).toString('base64');
    files[vbsPath] = Buffer.from(definition.vbs).toString('base64');
    if (options.installed) runValue = definition.runValue;
  }
  const before = { cmd: files[cmdPath] ?? null, vbs: files[vbsPath] ?? null, runValue };
  await writeFile(statePath, JSON.stringify({ root, runValue, files, owner: options.owner ?? null,
    work: options.owner ? ['owned-work'] : [], scenario: options.scenario, calls: [], stops: [],
    newCmdBase64: null, newVbsBase64: null, newRunValue: null } satisfies WindowsState));
  const child = spawnSync(process.execPath, [entries.win32, 'service', options.action ?? 'uninstall',
    ...(options.port ? ['--port', String(options.port)] : [])], {
    cwd: folder, env: { ...process.env, NODE_OPTIONS: '', PATH: join(folder, 'no-manager-bin'),
      HOME: folder, VONVON_HOME: dataHome, VONVON_OUTCOMES_STATE: statePath }, encoding: 'utf8', timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const state: WindowsState = JSON.parse(await readFile(statePath, 'utf8'));
  const after = { cmd: state.files[cmdPath] ?? null, vbs: state.files[vbsPath] ?? null,
    runValue: state.runValue };
  return { child, state, before, after, cmdPath, vbsPath, root };
}

it('Windows row 1 uninstalls ours without restarting', async () => {
  const r = await runWindowsCase({ installed: true, scenario: 'none' });
  expect(r.child.status, r.child.stderr).toBe(0);
  expect(r.child.stdout).toContain('uninstalled:');
  expect(r.after).toEqual({ cmd: null, vbs: null, runValue: null });
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:delete', 'unlink:cmd', 'unlink:vbs']);
});

it('Windows absent with no leftovers returns the non-row not-installed result', async () => {
  const r = await runWindowsCase({ installed: false, scenario: 'none' });
  expect(r.child.status, r.child.stderr).toBe(0);
  expect(r.child.stdout).toContain('not-installed:');
  expect(r.after).toEqual({ cmd: null, vbs: null, runValue: null });
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([]);
});

it('Windows row 2 restores kept Run value and exact launcher bytes on drain failure', async () => {
  const r = await runWindowsCase({ installed: true, scenario: 'drain_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_rolled_back:');
  expect(r.child.stderr).toContain('fixture lock read failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:delete', 'reg:add']);
});

it('Windows row 3 step 3 stop_unconfirmed retains launchers but withdraws Run value', async () => {
  const r = await runWindowsCase({ installed: true, owner, scenario: 'stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.child.stderr).toContain('41001');
  expect(r.after).toEqual({ ...r.before, runValue: null });
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.calls).toEqual(['reg:delete']);
});

it('Windows row 3 step 5 stop_unconfirmed restores no launcher', async () => {
  const r = await runWindowsCase({ installed: true, scenario: 'step5_stop_unconfirmed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('stop_unconfirmed');
  expect(r.after).toEqual({ cmd: null, vbs: null, runValue: null });
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['new-job-work']);
  expect(r.state.stops).toEqual([41001]);
  expect(r.state.calls).toEqual(['reg:delete', 'unlink:cmd', 'unlink:vbs']);
});

it('Windows row 4 unload failure restores Run value and exact kept files', async () => {
  const r = await runWindowsCase({ installed: true, scenario: 'unload_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_rolled_back:');
  expect(r.child.stderr).toContain('fixture launcher unlink failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:delete', 'unlink:cmd', 'reg:add']);
});

it('Windows row 6 resumed uninstall removes leftovers and retains owner', async () => {
  const r = await runWindowsCase({ installed: false, leftovers: true, owner, scenario: 'none' });
  expect(r.child.status, r.child.stderr).toBe(0);
  expect(r.child.stdout).toContain('Retained PID 41001');
  expect(r.after).toEqual({ cmd: null, vbs: null, runValue: null });
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['unlink:cmd', 'unlink:vbs']);
});

it('Windows row 7 resumed owner read failure cannot stop or unload', async () => {
  const r = await runWindowsCase({ installed: false, leftovers: true, owner, scenario: 'resumed_read_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('fixture lock read failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual([]);
});

it('Windows row 8 resumed unload failure writes nothing back', async () => {
  const r = await runWindowsCase({ installed: false, leftovers: true, owner, scenario: 'unload_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('uninstall_incomplete:');
  expect(r.child.stderr).toContain('fixture launcher unlink failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.owner).toEqual(owner);
  expect(r.state.work).toEqual(['owned-work']);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['unlink:cmd']);
});

it('Windows row 13 failed install rolls back its new launcher pair', async () => {
  const r = await runWindowsCase({ action: 'install', installed: false, scenario: 'install_launch_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_rolled_back:');
  expect(r.after).toEqual({ cmd: null, vbs: null, runValue: null });
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:query', 'rename:cmd', 'rename:vbs', 'reg:add', 'launch',
    'reg:delete', 'unlink:cmd', 'unlink:vbs']);
});

it('Windows row 13 restores exact previous pair and Run without relaunch', async () => {
  const r = await runWindowsCase({ action: 'install', port: 32124, installed: true,
    scenario: 'install_launch_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_rolled_back:');
  expect(r.after).toEqual(r.before);
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:query', 'rename:cmd', 'launch', 'reg:delete', 'unlink:cmd', 'unlink:vbs',
    'rename:cmd', 'rename:vbs', 'reg:add']);
});

it('Windows row 14 rollback read failure keeps exact new pair and Run', async () => {
  const r = await runWindowsCase({ action: 'install', port: 32124, installed: true,
    scenario: 'rollback_drain_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('fixture lock read failed');
  expect(r.child.stderr).toContain('fixture launcher failed');
  expect(r.child.stderr).toContain('previous definition was not restored');
  expect(r.state.newCmdBase64).not.toBeNull();
  expect(r.state.newVbsBase64).not.toBeNull();
  expect(r.state.newRunValue).not.toBeNull();
  expect(r.after).toEqual({ cmd: r.state.newCmdBase64, vbs: r.state.newVbsBase64,
    runValue: r.state.newRunValue });
  expect(r.after).not.toEqual(r.before);
  const decoded = decodeGeneratedDefinition({ platform: 'win32', cmdPath: r.cmdPath, vbsPath: r.vbsPath }, {
    platform: 'win32', cmd: Buffer.from(r.after.cmd ?? '', 'base64'),
    vbs: Buffer.from(r.after.vbs ?? '', 'base64'), runValue: r.after.runValue ?? '',
  });
  expect(decoded.root).toBe(r.root);
  expect(decoded.port).toBe(32124);
  expect(r.state.owner).toBeNull();
  expect(r.state.work).toEqual([]);
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:query', 'rename:cmd', 'launch', 'reg:delete', 'reg:add']);
});

it('Windows row 16 rollback unload failure restores exact previous pair', async () => {
  const r = await runWindowsCase({ action: 'install', port: 32124, installed: true,
    scenario: 'rollback_unload_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('fixture launcher unlink failed');
  expect(r.after).toEqual(r.before);
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:query', 'rename:cmd', 'launch',
    'reg:delete', 'unlink:cmd', 'rename:cmd', 'reg:add']);
});

it('Windows row 16 rollback unload failure with no previous pair leaves registration absent', async () => {
  const r = await runWindowsCase({ action: 'install', installed: false,
    scenario: 'rollback_unload_failed' });
  expect(r.child.status).toBe(1);
  expect(r.child.stderr).toContain('install_incomplete:');
  expect(r.child.stderr).toContain('fixture launcher unlink failed');
  expect(r.after).toEqual({ cmd: null, vbs: null, runValue: null });
  expect(r.state.owner).toBeNull();
  expect(r.state.stops).toEqual([]);
  expect(r.state.calls).toEqual(['reg:query', 'rename:cmd', 'rename:vbs', 'reg:add', 'launch',
    'reg:delete', 'unlink:cmd', 'unlink:cmd', 'unlink:vbs']);
});
