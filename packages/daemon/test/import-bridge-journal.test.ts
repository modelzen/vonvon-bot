import { execFileSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeImportJournalSchema, ownsBridgeImportStage, parseBridgeImportJournal,
  readBridgeImportJournal, writeBridgeImportJournal, type BridgeImportJournal } from '../src/import/bridge/journal';

const io = vi.hoisted(() => ({ failRename: false, failSync: false, swapTemporary: '', swapJournal: false, events: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (String(args[0]).includes('.journal-')) {
        io.events.push('rename');
        if (io.failRename) throw new Error('injected rename failure');
      }
      return real.rename(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        const temporary = String(args[0]), replacement = io.swapTemporary;
        if (io.swapJournal && temporary.endsWith('/journal.json')) {
          io.swapJournal = false;
          const bytes = await real.readFile(temporary);
          await real.rename(temporary, `${temporary}.retained`);
          await real.writeFile(temporary, bytes);
        }
        if (replacement && temporary.includes('.journal-')) {
          io.swapTemporary = '';
          if (replacement === 'same-inode') await real.writeFile(temporary, 'foreign bytes');
          else {
            await real.rename(temporary, `${temporary}.retained`);
            if (replacement === 'symlink') await real.symlink(join(temporary, '..', 'journal.json'), temporary);
            else await real.writeFile(temporary, 'foreign bytes');
          }
        }
      };
      handle.sync = async () => {
        io.events.push(String(args[0]).includes('.journal-') ? 'file-sync' : 'directory-sync');
        if (io.failSync && io.events.includes('rename') && String(args[0]).endsWith('/bridge')) throw new Error('injected sync failure');
        return sync();
      };
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  io.failRename = false; io.failSync = false; io.swapTemporary = ''; io.swapJournal = false; io.events = [];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'bridge-journal-')); roots.push(root);
  const paths = { appDir: join(root, 'app'), bridgeDir: join(root, 'source'), plistFile: join(root, 'bridge.plist') };
  const txId = '11111111-1111-4111-8111-111111111111', directory = join(paths.appDir, 'import/bridge');
  const journal: BridgeImportJournal = {
    version: 1, txId, hostPid: 123, startedAt: 1, uid: 501, bridgeDir: paths.bridgeDir, plistFile: paths.plistFile,
    reservedAppIds: ['fake_bot'], acquiredLocks: [], before: { plist: { present: false }, serviceLoaded: false,
      holders: [{ appId: 'fake_bot', pid: null, startedAt: null }] },
    stageDir: join(directory, txId), stageIdentity: null, intents: [], step: 'stopping', cleanupPending: false, outcome: null,
  };
  return { root, paths, journal, directory, file: join(directory, 'journal.json') };
}
it('publishes complete bounded journals with file then rename then directory durability', async () => {
  const { paths, journal, file, directory } = await fixture();
  expect(await readBridgeImportJournal(paths)).toBeUndefined();
  await writeBridgeImportJournal(paths, journal);
  expect(await readBridgeImportJournal(paths)).toEqual(journal);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect(io.events.slice(-3)).toEqual(['file-sync', 'rename', 'directory-sync']);
  await writeBridgeImportJournal(paths, { ...journal, step: 'locking', acquiredLocks: ['fake_bot'] });
  expect((await readBridgeImportJournal(paths))?.step).toBe('locking');
  expect(await readdir(directory)).toEqual(['journal.json']);
});
it('retains prior bytes when actual temporary publication fails and cleans only its temporary', async () => {
  const { paths, journal, file, directory } = await fixture();
  await writeBridgeImportJournal(paths, journal);
  const previous = await readFile(file); await writeFile(join(directory, '.journal-unrelated.tmp'), 'retain');
  io.failRename = true;
  await expect(writeBridgeImportJournal(paths, { ...journal, step: 'locking' })).rejects.toThrow('injected rename');
  expect(await readFile(file)).toEqual(previous);
  expect((await readdir(directory)).sort()).toEqual(['.journal-unrelated.tmp', 'journal.json']);
});
it('reports post-publication directory sync failure while reopening the actual complete new journal', async () => {
  const { paths, journal, file } = await fixture(); await writeBridgeImportJournal(paths, journal);
  io.events = []; io.failSync = true;
  await expect(writeBridgeImportJournal(paths, { ...journal, step: 'locking' })).rejects.toThrow('injected sync');
  expect(JSON.parse(await readFile(file, 'utf8')).step).toBe('locking');
});
it('rejects invalid JSON, oversized bytes and unsafe UTF-8 rather than granting an empty reservation', async () => {
  const { paths, directory, file } = await fixture(); await mkdir(directory, { recursive: true });
  for (const bytes of ['{', Buffer.alloc(1024 * 1024 + 1, 32), Buffer.from([0xff])]) {
    await writeFile(file, bytes); await expect(readBridgeImportJournal(paths)).rejects.toThrow();
  }
});
it.each(['file-link', 'hard-link', 'directory', 'fifo', 'ancestor-link'])('rejects real %s journals without changing their targets', async kind => {
  const { root, paths, journal, directory, file } = await fixture();
  await mkdir(directory, { recursive: true });
  const target = join(root, 'target'); await writeFile(target, JSON.stringify(journal));
  if (kind === 'file-link') await symlink(target, file);
  if (kind === 'hard-link') await link(target, file);
  if (kind === 'directory') await mkdir(file);
  if (kind === 'fifo') execFileSync('/usr/bin/mkfifo', [file]);
  if (kind === 'ancestor-link') {
    await rmdir(directory); await symlink(root, directory);
  }
  const previous = await readFile(target);
  await expect(readBridgeImportJournal(paths)).rejects.toThrow();
  await expect(writeBridgeImportJournal(paths, journal)).rejects.toThrow();
  expect(await readFile(target)).toEqual(previous);
});
it('enforces strict schemas, fixed scope and intent ownership before any filesystem write', async () => {
  const { paths, journal } = await fixture();
  const bad: unknown[] = [
    { ...journal, version: 2 }, { ...journal, plaintext: 'never' }, { ...journal, before: { ...journal.before, private: true } }, { ...journal, bridgeDir: `${paths.bridgeDir}/other` },
    { ...journal, plistFile: `${paths.plistFile}.other` }, { ...journal, stageDir: paths.appDir },
    { ...journal, txId: '../other' }, { ...journal, reservedAppIds: ['fake_bot', 'fake_bot'] },
    { ...journal, acquiredLocks: ['foreign'] }, { ...journal, before: { ...journal.before, holders: [] } },
    { ...journal, step: 'rolling-back' }, { ...journal, step: 'rolled-back', outcome: null },
    { ...journal, step: 'done', outcome: 'done', cleanupPending: true },
  ];
  for (const action of [
    { kind: 'execute', path: '/private/unknown' },
    { kind: 'write-file', appId: 'fake_bot', file: '../config.json', sha256: 'a'.repeat(64) },
    { kind: 'write-file', appId: 'foreign', file: 'config.json', sha256: 'a'.repeat(64) },
    { kind: 'create-secret', appId: 'fake_bot', id: 'app-foreign', iv: 'a'.repeat(24) },
    { kind: 'create-secret', appId: 'fake_bot', id: 'app-fake_bot', iv: `${'a'.repeat(23)}\n` },
    { kind: 'move-plist', from: 'original', to: 'backup', sha256: 'a'.repeat(64) },
    { kind: 'move-plist', from: 'original', to: 'stage', sha256: 'a'.repeat(64) },
    { kind: 'register-bot', appId: 'fake_bot', registrationId: 'arbitrary' },
  ]) bad.push({ ...journal, intents: [{ sequence: 0, completed: false, action }] });
  for (const value of bad) expect(() => parseBridgeImportJournal(value, paths)).toThrow();
  await expect(lstat(paths.appDir)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(BridgeImportJournalSchema.safeParse({ ...journal, reservedAppIds: ['fake_bot\n'] }).success).toBe(false);
});
it('keeps terminal cleanup obligations and inode ownership separate from informational completion flags', async () => {
  const { paths, journal } = await fixture(); await mkdir(journal.stageDir, { recursive: true });
  const metadata = await lstat(journal.stageDir), stageIdentity = { dev: metadata.dev, ino: metadata.ino };
  const value = parseBridgeImportJournal({ ...journal, stageIdentity, step: 'rolled-back', outcome: 'rolled-back',
    cleanupPending: true, intents: [{ sequence: 0, completed: false,
      action: { kind: 'create-secret', appId: 'fake_bot', id: 'app-fake_bot', iv: 'a'.repeat(24) } }] }, paths);
  expect(ownsBridgeImportStage(value, metadata)).toBe(true);
  expect(ownsBridgeImportStage({ ...value, stageIdentity: { ...stageIdentity, ino: metadata.ino + 1 } }, metadata)).toBe(false);
  expect(ownsBridgeImportStage(journal, metadata)).toBe(false);
  await writeBridgeImportJournal(paths, value);
  expect((await readBridgeImportJournal(paths))?.cleanupPending).toBe(true);
  await writeBridgeImportJournal(paths, { ...value, cleanupPending: false });
  expect((await readBridgeImportJournal(paths))?.outcome).toBe('rolled-back');
});

it('refuses another transaction until terminal cleanup and retains the exact archived result', async () => {
  const { paths, journal, file, directory } = await fixture();
  const next = { ...journal, txId: '22222222-2222-4222-8222-222222222222',
    stageDir: join(directory, '22222222-2222-4222-8222-222222222222') };
  await writeBridgeImportJournal(paths, journal);
  await expect(writeBridgeImportJournal(paths, next)).rejects.toThrow('another transaction');
  const terminal: BridgeImportJournal = { ...journal, step: 'rolled-back', outcome: 'rolled-back', cleanupPending: true };
  await writeBridgeImportJournal(paths, terminal);
  await expect(writeBridgeImportJournal(paths, next)).rejects.toThrow('another transaction');
  await writeBridgeImportJournal(paths, { ...terminal, cleanupPending: false });
  const original = await readFile(file);
  await writeBridgeImportJournal(paths, next);
  expect(await readFile(join(directory, `journal-${journal.txId}.json`))).toEqual(original);
  expect((await readBridgeImportJournal(paths))?.txId).toBe(next.txId);
  await writeFile(file, '{');
  await expect(writeBridgeImportJournal(paths, next)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('{');
});

it('preserves same-transaction ownership and prior intents while allowing lock and stage progress', async () => {
  const { paths, journal, file } = await fixture();
  const initial: BridgeImportJournal = { ...journal, intents: [{ sequence: 0, completed: false,
    action: { kind: 'create-secret', appId: 'fake_bot', id: 'app-fake_bot', iv: 'a'.repeat(24) } }] };
  await writeBridgeImportJournal(paths, initial);
  const bytes = await readFile(file);
  const changes: Partial<BridgeImportJournal>[] = [{ hostPid: 456 }, { reservedAppIds: ['other'] }, { intents: [] },
    { intents: [{ sequence: 0, completed: false,
      action: { kind: 'create-secret', appId: 'fake_bot', id: 'app-fake_bot', iv: 'b'.repeat(24) } }] }];
  for (const change of changes) {
    await expect(writeBridgeImportJournal(paths, { ...initial, ...change })).rejects.toThrow();
    expect(await readFile(file)).toEqual(bytes);
  }
  const progressed = { ...initial, step: 'locking', acquiredLocks: ['fake_bot'],
    intents: initial.intents.map(item => ({ ...item, completed: true })) } satisfies BridgeImportJournal;
  await writeBridgeImportJournal(paths, progressed);
  await expect(writeBridgeImportJournal(paths, initial)).rejects.toThrow('ownership changed');
  expect(await readBridgeImportJournal(paths)).toEqual(progressed);
});

it('never overwrites an already retained terminal archive', async () => {
  const { paths, journal, file, directory } = await fixture();
  await writeBridgeImportJournal(paths, { ...journal, step: 'rolled-back', outcome: 'rolled-back' });
  const archive = join(directory, `journal-${journal.txId}.json`), original = await readFile(file);
  await writeFile(archive, 'retained');
  const nextId = '22222222-2222-4222-8222-222222222222';
  await expect(writeBridgeImportJournal(paths, { ...journal, txId: nextId, stageDir: join(directory, nextId) })).rejects.toThrow('archive already exists');
  expect(await readFile(file)).toEqual(original);
  expect(await readFile(archive, 'utf8')).toBe('retained');
});

it.each(['same-inode', 'new-inode', 'symlink'])('refuses a %s temporary replacement before rename', async replacement => {
  const { paths, journal, file, directory } = await fixture();
  await writeBridgeImportJournal(paths, journal);
  const previous = await readFile(file); io.swapTemporary = replacement;
  await expect(writeBridgeImportJournal(paths, { ...journal, step: 'locking' })).rejects.toThrow();
  expect(await readFile(file)).toEqual(previous);
  const temporaries = (await readdir(directory)).filter(name => name.startsWith('.journal-') && name.endsWith('.tmp'));
  if (replacement === 'same-inode') expect(temporaries).toEqual([]);
  else {
    expect(temporaries).toHaveLength(1);
    const name = temporaries[0];
    if (!name) throw new Error('missing retained foreign temporary');
    if (replacement === 'symlink') expect((await lstat(join(directory, name))).isSymbolicLink()).toBe(true);
    else expect(await readFile(join(directory, name), 'utf8')).toBe('foreign bytes');
  }
});

it('binds both plist move directions to the captured original digest', async () => {
  const { paths, journal } = await fixture();
  const original = { ...journal, before: { ...journal.before, plist: { present: true, sha256: 'a'.repeat(64) } } };
  for (const [from, to] of [['original', 'stage'], ['stage', 'original'], ['stage', 'backup']]) {
    const value = { ...original, intents: [{ sequence: 0, completed: false,
      action: { kind: 'move-plist', from, to, sha256: 'a'.repeat(64) } }] };
    expect(() => parseBridgeImportJournal(value, paths)).not.toThrow();
    expect(() => parseBridgeImportJournal({ ...value, before: { ...journal.before,
      plist: { present: true, sha256: 'b'.repeat(64) } } }, paths)).toThrow();
  }
});

it('refuses an atomic journal replacement during a real read without exposing the input', async () => {
  const { paths, journal, file } = await fixture(); await writeBridgeImportJournal(paths, journal);
  const original = await readFile(file); io.swapJournal = true;
  await expect(readBridgeImportJournal(paths)).rejects.toThrow('changed while reading');
  expect(await readFile(file)).toEqual(original);
  expect(await readFile(`${file}.retained`)).toEqual(original);
  await writeFile(file, 'SYNTHETIC-SENSITIVE-CORRUPTION');
  await expect(readBridgeImportJournal(paths)).rejects.toThrow(/^Invalid bridge import journal$/);
});
