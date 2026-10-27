import {createCipheriv, pbkdf2Sync, randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {hostname, tmpdir, userInfo} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {createBridgeImporter, ImportCrashError, type ImporterDeps, type BridgeImporter} from '../src/import/bridge/transaction';
import {BridgeLocks} from '../src/import/bridge/locks';
import {readBridgeImportJournal, writeBridgeImportJournal, withBridgeMoveAllocation} from '../src/import/bridge/journal';
import {removeBridgeHooks} from '../src/import/bridge/hooks';

const fixtures: {root: string; locks: BridgeLocks; importer?: BridgeImporter}[] = [];
afterEach(async () => {for (const fixture of fixtures.splice(0)) {await fixture.importer?.shutdown().catch(() => undefined); fixture.locks.close(); await rm(fixture.root, {recursive: true, force: true});}});
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const terminal = new Set(['done', 'rolled-back', 'rollback-failed', 'refused']);
async function fixture(fault?: ImporterDeps['fault']) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'vonvon-bridge-transaction-'));
  const homeDir = join(root, 'home'), appDir = join(root, 'new'), bridgeDir = join(homeDir, '.feishu-codex-bridge');
  const plistFile = join(homeDir, 'Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist');
  const work = join(root, 'old-workspace');
  await Promise.all([mkdir(appDir), mkdir(bridgeDir, {recursive: true}), mkdir(work), mkdir(join(homeDir, 'Library/LaunchAgents'), {recursive: true}), mkdir(join(homeDir, '.claude'), {recursive: true}), mkdir(join(homeDir, '.codex'), {recursive: true})]);
  await writeFile(plistFile, 'synthetic plist');
  const hooks = {other: {preserve: true}, hooks: {Stop: [{matcher: '*', hooks: [{type: 'command', command: 'feishu-codex-bridge hook --agent claude'}, {type: 'command', command: 'echo keep'}]}]}};
  await json(join(homeDir, '.claude/settings.json'), hooks);
  await json(join(homeDir, '.codex/hooks.json'), {hooks: {}});
  const salt = randomBytes(32), key = pbkdf2Sync(`${hostname()}|${userInfo().username}`, salt, 100000, 32, 'sha256'), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update('encrypted-test-secret'), cipher.final()]); key.fill(0);
  await writeFile(join(bridgeDir, '.keystore.salt'), salt);
  await json(join(bridgeDir, 'secrets.enc'), {version: 1, entries: {'old-b': {iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64')}}});
  const bots = [{appId: 'bot_a', name: 'lin', tenant: 'feishu', createdAt: 1, active: true}, {appId: 'bot_b', name: 'qiao', tenant: 'feishu', createdAt: 1, active: false}];
  await json(join(bridgeDir, 'bots.json'), {version: 1, current: 'bot_a', bots});
  for (const bot of bots) {
    const base = join(bridgeDir, 'bots', bot.appId); await mkdir(join(base, 'outbound-files'), {recursive: true});
    await json(join(base, 'config.json'), {accounts: {app: {id: bot.appId, tenant: 'feishu', secret: bot.appId === 'bot_a' ? 'plain-test-secret' : {source: 'exec', provider: 'bridge', id: 'old-b'}}}, preferences: {access: {admins: ['old-admin']}, runIdleTimeoutSeconds: 120}});
    await json(join(base, 'projects.json'), {version: 1, projects: [{name: 'project', chatId: `chat_${bot.appId}`, cwd: work, blank: false, createdAt: 1, mode: 'write', guestMode: 'qa', noMention: false, network: true, allowedUsers: ['member'], backend: 'codex-appserver', defaultModel: 'gpt-5', autoCompact: false}]});
    await json(join(base, 'sessions.json'), {version: 3, sessions: [{threadId: `topic_${bot.appId}#admin`, chatId: `chat_${bot.appId}`, cwd: work, sessionId: `old-${bot.appId}`, summary: 'old summary', createdAt: 1, updatedAt: 2}], titleJobs: []});
    await writeFile(join(base, 'comment-instructions.md'), 'old comments'); await json(join(base, 'outbound-files/reference.json'), {old: 'file-reference'});
  }
  const original = await readFile(join(bridgeDir, 'bots/bot_a/config.json'), 'utf8');
  const registry = new Map<string, {registrationId: string; handle: string; active: boolean}>(), secrets = new Map<string, {iv: string; bytes: Buffer}>(), running = new Set<string>(), calls: string[] = [];
  let serviceLoaded = true, failBootstrap = false, ticks = 1000;
  const locks = new BridgeLocks(bridgeDir); fixtures.push({root, locks});
  const deps: ImporterDeps = {appDir, bridgeDir, homeDir, plistFile, uid: 501, platform: 'darwin', version: 'test', locks, now: () => ++ticks,
    sleep: async ms => {ticks += ms;}, timeoutMs: 2000,
    run: async (_command, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'bootout') {serviceLoaded = false; return {status: 0, stdout: '', stderr: ''};}
      if (args[0] === 'bootstrap') {if (failBootstrap) return {status: 1, stdout: '', stderr: 'synthetic failure'}; serviceLoaded = true; return {status: 0, stdout: '', stderr: ''};}
      return serviceLoaded ? {status: 0, stdout: 'state = running', stderr: ''} : {status: 113, stdout: '', stderr: 'Could not find service'};
    },
    registry: {
      ids: async () => [...registry.keys()], reserve: async (_ids, write) => write(),
      register: async (bot, _txId, registrationId, handle) => {await handle(bot.entry.desiredName); registry.set(bot.appId, {registrationId, handle: bot.entry.desiredName, active: false});},
      unregister: async entries => {for (const entry of entries) {const found = registry.get(entry.appId); if (found && found.registrationId !== entry.registrationId) throw new Error('Foreign registry'); registry.delete(entry.appId);}},
      activate: async (id, active) => {registry.get(id)!.active = active;},
    },
    secrets: {
      ids: async () => [...secrets.keys()],
      create: async (id, bytes, iv) => {if (secrets.has(id)) throw new Error('Exists'); secrets.set(id, {iv: iv.toString('hex'), bytes: Buffer.from(bytes)});},
      remove: async (id, iv) => {const value = secrets.get(id); if (!value) return 'absent'; if (value.iv !== iv.toString('hex')) return 'foreign'; secrets.delete(id); return 'removed';},
    },
    runtime: {start: async id => {running.add(id);}, stop: async id => {running.delete(id);}, connection: async id => running.has(id) ? 'connected' : 'disconnected'},
    resolveCodex: async () => '/synthetic/codex', fault,
  };
  const importer = createBridgeImporter(deps); fixtures[fixtures.length - 1]!.importer = importer;
  async function finish() {
    for (let i = 0; i < 10000; i++) {const reply = await importer.status(); if (reply.view && terminal.has(reply.view.step)) return reply; await new Promise(resolve => setTimeout(resolve, 1));}
    throw new Error('Import did not settle');
  }
  return {root, deps, importer, finish, registry, secrets, running, calls, original, hooks, work, service: () => serviceLoaded, failBootstrap: (value: boolean) => {failBootstrap = value;}};
}
it('imports every Bot with real legacy conversion, old workspaces/session identities, owned secrets and hook backup', async () => {
  const f = await fixture();
  expect((await f.importer.detect()).detection?.kind).toBe('found');
  expect(f.calls).toEqual([]);
  const inspected = (await f.importer.preflight()).preflight; expect(inspected?.canImport, JSON.stringify(inspected)).toBe(true);
  const start = await f.importer.start(); expect(start.view?.step).toBe('checking');
  expect((await f.importer.start()).view?.txId).toBe(start.view?.txId);
  const result = await f.finish(); expect(result.view?.step).toBe('done');
  expect(f.registry.size).toBe(2); expect(f.registry.get('bot_b')?.active).toBe(false); expect([...f.running]).toEqual(['bot_a']);
  expect(f.secrets.get('app-bot_a')?.bytes.toString()).toBe('plain-test-secret'); expect(f.secrets.get('app-bot_b')?.bytes.toString()).toBe('encrypted-test-secret');
  const imported = join(f.deps.appDir, 'bots/bot_a');
  expect(JSON.parse(await readFile(join(imported, 'projects.json'), 'utf8')).projects[0]).toMatchObject({cwd: f.work, mode: 'qa', noMention: false, network: true, allowedUsers: ['member'], defaultModel: 'gpt-5'});
  expect(JSON.parse(await readFile(join(imported, 'sessions.json'), 'utf8')).sessions[0]).toMatchObject({threadId: 'topic_bot_a', sessionId: 'old-bot_a', cwd: f.work});
  expect(await readFile(join(imported, 'comment-instructions.md'), 'utf8')).toBe('old comments');
  expect(JSON.parse(await readFile(join(imported, 'outbound-files/reference.json'), 'utf8'))).toEqual({old: 'file-reference'});
  expect(await readFile(join(f.deps.bridgeDir, 'bots/bot_a/config.json'), 'utf8')).toBe(f.original);
  expect(await readFile(join(f.deps.homeDir, '.claude/settings.json'), 'utf8')).toContain('echo keep');
  expect(await readFile(join(f.deps.homeDir, '.claude/settings.json'), 'utf8')).not.toContain('feishu-codex-bridge');
  expect(JSON.stringify(result)).not.toMatch(/plain-test-secret|encrypted-test-secret/);
  expect(result.view?.notes.map(note => note.kind)).toEqual(expect.arrayContaining(['permission-merged', 'automatic-compaction', 'idle-timeout-default', 'keep-source']));
  expect(f.service()).toBe(false);
  expect((await f.importer.rollback()).view?.step).toBe('done');
});
for (const point of ['after-stop', 'after-lock', 'during-copy', 'after-copy', 'after-hooks', 'after-move', 'during-start', 'before-marker', 'after-bridge-marker']) {
  it(`rolls back actual staged files, hooks, credentials and service after ${point}`, async () => {
    const f = await fixture(seen => {if (seen === point) throw new Error('synthetic failure');});
    await f.importer.start(); const reply = await f.finish(); expect(reply.view?.step).toBe('rolled-back'); expect(reply.view?.cleanupPending).toBe(false);
    expect(f.registry.size).toBe(0); expect(f.secrets.size).toBe(0); expect(f.running.size).toBe(0); expect(f.service()).toBe(true);
    expect(await readFile(f.deps.plistFile, 'utf8')).toBe('synthetic plist');
    expect(JSON.parse(await readFile(join(f.deps.homeDir, '.claude/settings.json'), 'utf8'))).toEqual(f.hooks);
    expect(await readFile(join(f.deps.bridgeDir, 'bots/bot_a/config.json'), 'utf8')).toBe(f.original);
    await expect(stat(join(f.deps.appDir, 'bots/bot_a'))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(stat(join(f.deps.bridgeDir, 'vonvon-migration.json'))).rejects.toMatchObject({code: 'ENOENT'});
  });
}
for (const kind of ['create-secret', 'hook', 'move-bot', 'register-bot', 'start-bot']) {
  it(`recovers the completed ${kind} side effect when its receipt was never journaled`, async () => {
    let fired = false;
    const f = await fixture(point => {if (!fired && point === `crash-after:${kind}`) {fired = true; throw new ImportCrashError('synthetic process death');}});
    await f.importer.start();
    for (let i = 0; i < 10000 && !fired; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(fired).toBe(true); await f.importer.shutdown().catch(error => {expect(error).toBeInstanceOf(ImportCrashError);});
    for (const id of ['bot_a', 'bot_b']) f.deps.locks.release(id);
    const recovered = createBridgeImporter({...f.deps, fault: undefined}); await recovered.recover();
    expect((await recovered.status()).view?.step).toBe('rolled-back'); expect(f.service()).toBe(true); expect(f.secrets.size).toBe(0); expect(f.registry.size).toBe(0);
  });
}
it('keeps commitment if killed after durable done marker but before its journal receipt', async () => {
  let markers = 0, fired = false;
  const f = await fixture(point => {if (point === 'crash-after:marker' && ++markers === 2) {fired = true; throw new ImportCrashError();}});
  await f.importer.start(); for (let i = 0; i < 10000 && !fired; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await f.importer.shutdown().catch(error => {expect(error).toBeInstanceOf(ImportCrashError);});
  const recovered = createBridgeImporter({...f.deps, fault: undefined}); await recovered.recover();
  expect((await recovered.status()).view?.step).toBe('done'); expect(f.registry.size).toBe(2); expect(f.service()).toBe(false);
});
it('reports bootstrap failure honestly and can retry recovery without overwriting or repeating import', async () => {
  const f = await fixture(point => {if (point === 'after-copy') throw new Error('test');}); f.failBootstrap(true);
  await f.importer.start(); expect((await f.finish()).view?.step).toBe('rollback-failed');
  expect((await f.importer.status()).view).toMatchObject({canRollback: true, cleanupPending: true});
  f.failBootstrap(false); await f.importer.rollback();
  for (let i = 0; i < 10000 && (await f.importer.status()).view?.step !== 'rolled-back'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect((await f.importer.status()).view).toMatchObject({step: 'rolled-back', cleanupPending: false}); expect(f.service()).toBe(true);
});
it.each([0, -1])('waits for SIGTERMed to unload before importing, even when bootout returns %s', async status => {
  const f = await fixture(), run = f.deps.run;
  let stopping = 0;
  f.deps.run = async (command, args) => {
    if (args[0] === 'print' && stopping > 0) {
      stopping--;
      return {status: 0, stdout: 'service = {\n\tstate = SIGTERMed\n\tpid = 424242\n}', stderr: ''};
    }
    const result = await run(command, args);
    if (args[0] === 'bootout') {stopping = 3; return {...result, status};}
    return result;
  };
  const start = f.deps.runtime.start;
  f.deps.runtime.start = async (...args) => {expect(stopping).toBe(0); await start(...args);};
  await f.importer.start();
  expect((await f.finish()).view).toMatchObject({step: 'done', cleanupPending: false});
  expect(f.calls.some(call => call.startsWith('bootstrap'))).toBe(false);
  expect(f.registry.size).toBe(2); expect(f.service()).toBe(false);
});
it('recovers an earlier failed rollback while the original service is still SIGTERMed', async () => {
  const f = await fixture(point => {if (point === 'after-copy') throw new Error('test');});
  f.failBootstrap(true); await f.importer.start();
  expect((await f.finish()).view?.step).toBe('rollback-failed');
  f.failBootstrap(false);
  let stopping = 3, bootstraps = 0;
  const run = f.deps.run;
  const recovered = createBridgeImporter({...f.deps, fault: undefined, run: async (command, args) => {
    if (args[0] === 'print' && stopping > 0) {
      stopping--;
      return {status: 0, stdout: 'state = SIGTERMed', stderr: ''};
    }
    if (args[0] === 'bootstrap') {expect(stopping).toBe(0); bootstraps++;}
    return run(command, args);
  }});
  await recovered.recover();
  expect((await recovered.status()).view).toMatchObject({step: 'rolled-back', cleanupPending: false});
  expect(bootstraps).toBe(1); expect(f.service()).toBe(true);
  expect(f.registry.size).toBe(0); expect(f.running.size).toBe(0);
  expect(await readFile(f.deps.plistFile, 'utf8')).toBe('synthetic plist');
  expect(await readFile(join(f.deps.bridgeDir, 'bots/bot_a/config.json'), 'utf8')).toBe(f.original);
});
it('preserves recovery pending when a SIGTERMed service never unloads', async () => {
  const f = await fixture(), run = f.deps.run;
  let stopping = false;
  f.deps.run = async (command, args) => {
    if (args[0] === 'print' && stopping) return {status: 0, stdout: 'state = SIGTERMed', stderr: ''};
    const result = await run(command, args);
    if (args[0] === 'bootout') stopping = true;
    return result;
  };
  await f.importer.start();
  expect((await f.finish()).view).toMatchObject({step: 'rollback-failed', cleanupPending: true, error: {code: 'service-timeout'}});
  expect(f.calls.some(call => call.startsWith('bootstrap'))).toBe(false);
  expect(f.registry.size).toBe(0); expect(f.running.size).toBe(0);
  expect(await readFile(f.deps.plistFile, 'utf8')).toBe('synthetic plist');
  expect(await readFile(join(f.deps.bridgeDir, 'bots/bot_a/config.json'), 'utf8')).toBe(f.original);
});
it('refuses target collisions and invalid hooks without stopping or creating an import journal', async () => {
  const f = await fixture(); f.registry.set('bot_a', {registrationId: 'foreign', handle: 'foreign', active: true});
  await f.importer.start(); expect((await f.finish()).view?.step).toBe('refused');
  expect(f.calls.some(call => call.startsWith('bootout'))).toBe(false);
  await expect(stat(join(f.deps.appDir, 'import/bridge/journal.json'))).rejects.toMatchObject({code: 'ENOENT'});
});
it('only removes known hook commands and preserves mixed groups and unrelated settings', () => {
  const input = {setting: 3, hooks: {Stop: [{hooks: [{type: 'command', command: '"/app/Electron" "/app/bin/vonvon.mjs" hook --agent codex'}, {type: 'command', command: 'agent2lark-hook'}, {type: 'command', command: 'echo feishu-codex-bridge hook --agent codex'}]}]}};
  const result = JSON.parse(removeBridgeHooks(Buffer.from(JSON.stringify(input))).bytes.toString());
  expect(result.setting).toBe(3); expect(result.hooks.Stop[0].hooks).toHaveLength(2);
  expect(() => removeBridgeHooks(Buffer.from('{"hooks":{"Stop":null}}'))).toThrow();
});

it('does not replace or rewrite a healthy legacy lock on repeated checks', async () => {
  const f = await fixture(), file = join(f.deps.bridgeDir, 'bots/bot_b/processes.json');
  await f.deps.locks.acquire('bot_b'); const before = await stat(file), content = await readFile(file);
  for (let i = 0; i < 5; i++) await f.deps.locks.acquire('bot_b');
  const after = await stat(file); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs); expect(await readFile(file)).toEqual(content);
});
it('reports no source and no journal as a normal first launch, including macOS tmp alias', async () => {
  const f = await fixture();
  const home = join(f.root, 'fresh-home'); await mkdir(home);
  const empty = createBridgeImporter({...f.deps, homeDir: home, bridgeDir: join(home, '.feishu-codex-bridge'), plistFile: join(home, 'missing.plist')});
  await empty.recover(); const reply = await empty.detect();
  expect(reply.detection?.kind).toBe('not-found'); expect(reply.view).toBeNull(); expect(f.calls).toEqual([]);
});
it('replays a partially copied reverse EXDEV allocation before declaring rollback clean', async () => {
  let interrupted = false;
  const f = await fixture(point => {if (point === 'after-copy') {interrupted = true; throw new ImportCrashError();}});
  await f.importer.start(); for (let i = 0; i < 10000 && !interrupted; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(interrupted).toBe(true); await f.importer.shutdown().catch(() => undefined);
  let journal = await readBridgeImportJournal(f.deps); if (!journal?.before.plist.present) throw new Error('Missing source snapshot');
  const seq = journal.intents.length, hash = journal.before.plist.sha256;
  journal = {...journal, step: 'rolling-back', cleanupPending: true, intents: [...journal.intents, {sequence: seq, completed: false, action: {kind: 'move-plist', from: 'stage', to: 'original', sha256: hash, allocations: []}}]};
  await writeBridgeImportJournal(f.deps, journal);
  const parent = await stat(dirname(f.deps.plistFile)), nonce = '11111111-1111-4111-8111-111111111111';
  const allocation = {txId: journal.txId, sequence: seq, from: 'stage' as const, to: 'original' as const, sha256: hash, nonce, parent: {dev: parent.dev, ino: parent.ino}, inode: null};
  journal = withBridgeMoveAllocation(journal, allocation); await writeBridgeImportJournal(f.deps, journal);
  const temp = join(dirname(f.deps.plistFile), `.${basename(f.deps.plistFile)}.vonvon-${journal.txId}-${seq}-${nonce}.tmp`);
  await writeFile(temp, 'synthetic', {mode: 0o600}); const info = await stat(temp);
  journal = withBridgeMoveAllocation(journal, {...allocation, inode: {dev: info.dev, ino: info.ino}}); await writeBridgeImportJournal(f.deps, journal);
  const recovering = createBridgeImporter({...f.deps, fault: undefined}); await recovering.recover();
  expect((await recovering.status()).view).toMatchObject({step: 'rolled-back', cleanupPending: false});
  expect(await readdir(dirname(f.deps.plistFile))).toEqual([basename(f.deps.plistFile)]); expect(f.service()).toBe(true);
  const last = await readBridgeImportJournal(f.deps);
  expect(last?.intents.filter(item => item.action.kind === 'move-plist' && item.action.from === 'stage' && item.action.to === 'original')).toHaveLength(1);
});

it('keeps the latest refused attempt visible instead of rehydrating an older rollback receipt', async () => {
  const f = await fixture(point => {if (point === 'after-stop') throw new Error('fixture');});
  await f.importer.start(); expect((await f.finish()).view?.step).toBe('rolled-back');
  f.registry.set('bot_a', {registrationId: 'later', handle: 'later', active: false});
  await f.importer.start();
  for (let i = 0; i < 10000 && (await f.importer.status()).view?.step === 'checking'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect((await f.importer.status()).view?.step).toBe('refused');
});

it('accepts a legacy nullable guest permission already supported by the converter', async () => {
  const f = await fixture(), file = join(f.deps.bridgeDir, 'bots/bot_a/projects.json');
  const projects = JSON.parse(await readFile(file, 'utf8')); projects.projects[0].guestMode = null; await json(file, projects);
  expect((await f.importer.preflight()).preflight?.canImport).toBe(true); expect(f.calls.some(call => call.startsWith('bootout'))).toBe(false);
});
