import type { DesktopSnapshot } from '@vonvon/protocol';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminService } from '../src/admin/service';
import { paths } from '../src/config/paths';
import { installBackendDep, uninstallBackendDep } from '../src/agent/installer';
import { isBackendDepInstalled, isBackendInstalledInUserDir } from '../src/agent/backend-loader';
import type { BackendCatalogEntry } from '../src/agent/catalog';
import { Jobs } from '../src/server/jobs';
import { environmentRpc } from '../src/server/rpc/environment';

const controls = vi.hoisted(() => ({
  spawn: (_args: string[]): EventEmitter => { throw new Error('fixture not initialized'); },
  prepare: undefined as undefined | (() => Promise<void>),
  rollback: undefined as undefined | (() => Promise<void>),
  repair: undefined as undefined | (() => Promise<void>),
  preparations: 0,
}));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: (_command: string, args: string[]) => controls.spawn(args) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
vi.mock('../src/agent/native-helpers', () => ({ fixNativeHelperPerms: async () => { await controls.repair?.(); } }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]).endsWith('/prefix')) { controls.preparations++; await controls.prepare?.(); }
      return fs.mkdir(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).includes('/node_modules/')) await controls.rollback?.();
      return fs.rm(...args);
    },
  };
});
vi.mock('../src/agent/catalog', async importOriginal => {
  const catalog = await importOriginal<typeof import('../src/agent/catalog')>();
  return { ...catalog, catalogById: (id: string) => id.startsWith('fixture-') ? {
    id, agentFamily: 'fixture', displayName: id, access: 'sdk',
    dep: { kind: 'npm-ondemand', pkg: id === 'fixture-dev' ? 'zod' : id, version: '1.0.0', detectHint: '' },
  } : catalog.catalogById(id) };
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function entry(pkg: string, binName?: string): BackendCatalogEntry {
  return { id: pkg, agentFamily: 'fixture', displayName: pkg, access: 'sdk', dep: { kind: 'npm-ondemand', pkg, binName, detectHint: '' } };
}
class HeldChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();
  constructor(readonly pkg: string) { super(); }
}
let home = '';
let previous: Pick<typeof paths, 'backendsDir' | 'npmCacheDir'>;
let automaticClose = false;
const children: HeldChild[] = [];
const pending: Promise<unknown>[] = [];
const managers: Jobs[] = [];
const releases: (() => void)[] = [];
const snapshot: DesktopSnapshot = { revision: 0, observedAt: 0, stale: false, host: { kind: 'starting' }, agents: [], groups: [], memberships: [], tools: [], jobs: [], diagnostics: [], application: { platform: 'unsupported', version: 'test', loginItem: false, dataPath: '' } };
const service = () => createAdminService({ installBackend: installBackendDep, uninstallBackend: uninstallBackendDep });
const own = <T>(promise: Promise<T>): Promise<T> => { pending.push(promise); return promise; };
async function packageFiles(pkg: string, root = paths.backendsDir) {
  const directory = join(root, 'node_modules', pkg);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.cjs' }));
  await writeFile(join(directory, 'index.cjs'), 'module.exports = {};');
}
async function finish(child: HeldChild, code = 0) {
  if (code === 0) await packageFiles(child.pkg.replace(/@[^@]+$/, ''));
  child.emit('close', code);
}
const eventually = async (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 10 });
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'vonvon-installer-queue-'));
  previous = { backendsDir: paths.backendsDir, npmCacheDir: paths.npmCacheDir };
  Object.assign(paths, { backendsDir: join(home, 'prefix'), npmCacheDir: join(home, 'cache') });
  automaticClose = false;
  controls.preparations = 0;
  controls.spawn = args => {
    const child = new HeldChild(args[1] ?? 'unknown'); children.push(child);
    if (automaticClose) setImmediate(() => child.emit('close', 1));
    return child;
  };
});
afterEach(async () => {
  automaticClose = true;
  controls.prepare = undefined; controls.rollback = undefined; controls.repair = undefined;
  releases.splice(0).forEach(release => release());
  children.forEach(child => child.emit('close', 1));
  await Promise.allSettled(pending.splice(0));
  await Promise.all(managers.splice(0).map(jobs => jobs.close()));
  children.length = 0;
  Object.assign(paths, previous);
  await rm(home, { recursive: true, force: true });
  expect(existsSync(home)).toBe(false);
});

describe('shared backend prefix mutation ownership', () => {
  it('reserves install admission synchronously before the next environment command', async () => {
    const svc = service();
    const calls: string[] = [];
    const install = svc.installBackend;
    const uninstall = svc.uninstallBackend;
    svc.installBackend = (...args) => { calls.push('install'); return install(...args); };
    svc.uninstallBackend = (...args) => { calls.push('uninstall'); return uninstall(...args); };
    const jobs = new Jobs({ service: svc, changed() {}, toolsSettled() {} }); managers.push(jobs);
    const admission = jobs.selectBackend('fixture-a', false); own(admission.operation.done);
    own(environmentRpc(svc, jobs, { id: 'order', open: true, event() {} }, { type: 'backendUninstall', id: 'fixture-a' }));
    expect(calls).toEqual(['install', 'uninstall']);
  });

  it('admits real Jobs installs before an environment uninstall and attaches identical work once', async () => {
    const svc = service();
    const jobs = new Jobs({ service: svc, changed() {}, toolsSettled() {} }); managers.push(jobs);
    const peer = { id: 'test', open: true, event() {} };
    const install = jobs.selectBackend('fixture-a', false); own(install.operation.done);
    const attach = jobs.selectBackend('fixture-a', false);
    expect(jobs.attachBackend(attach, peer)).toMatchObject({ attached: true, operationId: install.operation.operationId, replay: [], omittedBytes: 0 });
    let uninstalled = false;
    const removal = own(environmentRpc(svc, jobs, peer, { type: 'backendUninstall', id: 'fixture-a' }).then(value => { uninstalled = true; return value; }));
    await eventually(() => expect(children).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(uninstalled).toBe(false);
    await finish(children[0]!);
    await install.operation.done;
    const outcome = await removal;
    expect(outcome.kind).toBe('mutation');
    if (outcome.kind === 'mutation') expect(await outcome.reply(snapshot)).toMatchObject({ kind: 'applied' });
    expect(existsSync(join(paths.backendsDir, 'node_modules/fixture-a/package.json'))).toBe(false);
  });

  it('serializes distinct install IDs, update mode, and uninstall in call order', async () => {
    const svc = service();
    const first = own(svc.installBackend('fixture-a'));
    const second = own(svc.installBackend('fixture-b', undefined, undefined, { update: true }));
    const remove = own(svc.uninstallBackend('fixture-b'));
    await eventually(() => expect(children.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(children.map(child => child.pkg)).toEqual(['fixture-a@1.0.0']);
    await finish(children[0]!); expect((await first).ok).toBe(true);
    await eventually(() => expect(children).toHaveLength(2));
    expect(children[1]?.pkg).toBe('fixture-b@latest');
    await finish(children[1]!); expect((await second).ok).toBe(true);
    expect(await remove).toMatchObject({ ok: true });
    expect(existsSync(join(paths.backendsDir, 'node_modules/fixture-b/package.json'))).toBe(false);
  });

  it('queues a different update mode for the same backend while identical requests attach', async () => {
    const jobs = new Jobs({ service: service(), changed() {}, toolsSettled() {} }); managers.push(jobs);
    const first = jobs.selectBackend('fixture-a', false); own(first.operation.done);
    const update = jobs.selectBackend('fixture-a', true); own(update.operation.done);
    const attached = jobs.selectBackend('fixture-a', true);
    expect(attached.attached).toBe(true);
    expect(attached.operation.operationId).toBe(update.operation.operationId);
    expect(update.operation.operationId).not.toBe(first.operation.operationId);
    await eventually(() => expect(children.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(children.map(child => child.pkg)).toEqual(['fixture-a@1.0.0']);
    await finish(children[0]!); await first.operation.done;
    await eventually(() => expect(children).toHaveLength(2));
    expect(children[1]?.pkg).toBe('fixture-a@latest');
    await finish(children[1]!); await update.operation.done;
  });

  it.each(['prepare', 'child close', 'rollback', 'verify rollback', 'repair'] as const)('retains the prefix throughout %s', async stage => {
    const gate = deferred(); releases.push(gate.resolve);
    let entered = false;
    const hold = async () => { entered = true; await gate.promise; };
    if (stage === 'prepare') controls.prepare = hold;
    if (stage === 'rollback' || stage === 'verify rollback') controls.rollback = hold;
    if (stage === 'repair') controls.repair = hold;
    const first = own(installBackendDep('fixture-a'));
    if (stage !== 'prepare') await eventually(() => expect(children).toHaveLength(1));
    if (stage === 'rollback' || stage === 'verify rollback') children[0]!.emit('close', stage === 'rollback' ? 1 : 0);
    if (stage === 'repair') await finish(children[0]!);
    if (stage !== 'child close') await eventually(() => expect(entered).toBe(true));
    const preparations = controls.preparations;
    const second = own(installBackendDep('fixture-b'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(controls.preparations).toBe(preparations);
    expect(children.length).toBe(stage === 'prepare' ? 0 : 1);
    controls.prepare = undefined; controls.rollback = undefined; controls.repair = undefined; gate.resolve();
    if (stage === 'prepare') await eventually(() => expect(children).toHaveLength(1));
    if (stage === 'prepare' || stage === 'child close') await finish(children[0]!);
    await first;
    await eventually(() => expect(children).toHaveLength(2));
    await finish(children[1]!);
    expect((await second).ok).toBe(true);
  });

  it('does no preparation for an aborted queued install and recovers after failure', async () => {
    const first = own(installBackendDep('fixture-a'));
    await eventually(() => expect(children).toHaveLength(1));
    const abort = new AbortController();
    const preparations = controls.preparations;
    const queued = own(installBackendDep('fixture-b', undefined, abort.signal)); abort.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(controls.preparations).toBe(preparations);
    children[0]!.emit('close', 1); await first;
    expect(await queued).toMatchObject({ aborted: true, ok: false });
    expect(controls.preparations).toBe(preparations);
    const third = own(installBackendDep('fixture-c'));
    await eventually(() => expect(children).toHaveLength(2));
    await finish(children[1]!); expect((await third).ok).toBe(true);
  });

  it('normalizes a synchronous service throw to terminal replay and releases the identical slot', async () => {
    const svc = service(); svc.installBackend = () => { throw new Error('synchronous fixture failure'); };
    const jobs = new Jobs({ service: svc, changed() {}, toolsSettled() {} }); managers.push(jobs);
    const first = jobs.selectBackend('fixture-a', false); own(first.operation.done);
    await first.operation.done;
    expect(jobs.attachBackend(first, { id: 'late', open: true, event() {} })).toMatchObject({ replay: [{ type: 'error', code: 'unknown', message: 'synchronous fixture failure' }] });
    const next = jobs.selectBackend('fixture-a', false); own(next.operation.done);
    expect(next.attached).toBe(false); expect(next.operation.operationId).not.toBe(first.operation.operationId);
  });
});

describe('production backend presence helpers on real files', () => {
  it('rejects a deleted target despite resolver cache after a successful production lookup', async () => {
    const pkg = 'fixture-resolver-cache';
    await packageFiles(pkg);
    expect(isBackendDepInstalled(pkg)).toBe(true);
    expect(isBackendInstalledInUserDir(entry(pkg))).toBe(true);
    await rm(join(paths.backendsDir, 'node_modules', pkg), { recursive: true });
    expect.soft(isBackendDepInstalled(pkg)).toBe(false);
    expect(isBackendInstalledInUserDir(entry(pkg))).toBe(false);
  });

  it('uses package.json for user library presence even without a loadable main', async () => {
    const pkg = 'fixture-package-presence';
    await mkdir(join(paths.backendsDir, 'node_modules', pkg), { recursive: true });
    await writeFile(join(paths.backendsDir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, main: 'missing.cjs' }));
    expect(isBackendInstalledInUserDir(entry(pkg))).toBe(true);
  });

  it('keeps bin presence distinct from package metadata', async () => {
    await packageFiles('fixture-bin');
    expect(isBackendInstalledInUserDir(entry('fixture-bin', 'fixture-command'))).toBe(false);
    await mkdir(join(paths.backendsDir, 'node_modules/.bin'), { recursive: true });
    const bin = join(paths.backendsDir, 'node_modules/.bin/fixture-command');
    await writeFile(bin, 'inert fixture');
    expect(isBackendInstalledInUserDir(entry('fixture-bin', 'fixture-command'))).toBe(true);
    await rm(bin);
    expect(isBackendInstalledInUserDir(entry('fixture-bin', 'fixture-command'))).toBe(false);
  });

  it('does not borrow parent node_modules for user-directory eligibility', async () => {
    await packageFiles('fixture-parent', home);
    await mkdir(paths.backendsDir, { recursive: true });
    expect(isBackendInstalledInUserDir(entry('fixture-parent'))).toBe(false);
  });

  it('rejects a successful npm exit when only a development dependency is present', async () => {
    const result = own(installBackendDep('zod'));
    await eventually(() => expect(children).toHaveLength(1));
    children[0]!.emit('close', 0);
    expect(await result).toMatchObject({ ok: false });
  });

  it('does not treat a development copy as failed user-directory removal', async () => {
    await packageFiles('zod');
    expect(isBackendDepInstalled('zod')).toBe(true);
    const svc = createAdminService({ uninstallBackend: uninstallBackendDep });
    const result = await svc.uninstallBackend('fixture-dev');
    expect(existsSync(join(paths.backendsDir, 'node_modules/zod/package.json'))).toBe(false);
    expect(isBackendDepInstalled('zod')).toBe(true);
    expect(result).toMatchObject({ ok: true });
  });
});
