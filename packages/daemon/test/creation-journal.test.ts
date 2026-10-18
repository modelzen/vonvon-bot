import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import { withCreationJournal } from '../src/project/creation-journal';

type Key = Parameters<typeof withCreationJournal>[0];
type Journal = Parameters<Parameters<typeof withCreationJournal>[1]>[0];
const key: Key = { appId: 'cli_fixture', tenant: 'feishu', id: 'creation-operation-0001' };
let scratch: string, bundle: string;
const live = new Set<ReturnType<typeof actor>>();
const pathFor = (root: string, k = key): string => join(root, 'creation-operations', createHash('sha256').update(JSON.stringify([k.appId, k.tenant, k.id])).digest('hex'), 'operation.json');
function prepare(root: string) {
  return { kind: 'prepare', bot: { appId: key.appId, tenant: key.tenant, createdAt: 1, registrationId: 'registration-initial' }, operatorOpenId: 'ou_fixture',
    input: { name: 'Research', workspace: { kind: 'default', root: join(root, 'projects') }, kind: 'multi', noMention: true, backend: 'codex-appserver', mode: 'full', network: false } } satisfies Parameters<Journal['change']>[0];
}
const home = () => mkdtemp(join(scratch, 'data-'));
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'creation-journal-')));
  bundle = join(scratch, 'journal.cjs');
  const actual = fileURLToPath(new URL('../src/config/data-access.ts', import.meta.url));
  await build({ entryPoints: [fileURLToPath(new URL('../src/project/creation-journal.ts', import.meta.url))], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'observe-operation-ownership', setup(api) {
      api.onResolve({ filter: /\/data-access$/ }, () => ({ path: 'observer', namespace: 'fixture' }));
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        import * as actual from ${JSON.stringify(actual)};
        export * from ${JSON.stringify(actual)};
        export async function acquireMutex(path,role,wait){
          const operation=role==='creation'&&/[a-f0-9]{64}$/.test(path);
          if(operation)process.send({event:'attempt'});
          const held=await actual.acquireMutex(path,role,wait);
          if(operation)process.send({event:'acquired'});
          return held;
        }`, loader: 'ts', resolveDir: dirname(actual) }));
    } }] });
});
afterAll(async () => {
  for (const state of live) state.child.kill('SIGKILL');
  await Promise.all([...live].map(state => state.done));
  await rm(scratch, { recursive: true, force: true });
});

function actor(root: string, code: string, k = key) {
  const child = spawn(process.execPath, ['-e', `const m=require(${JSON.stringify(bundle)}),assert=require('node:assert/strict');
    const key=${JSON.stringify(k)},seed=${JSON.stringify(prepare(root))};
    const probe=event=>process.send({event});const pause=()=>new Promise(resolve=>process.once('message',resolve));
    (async()=>{${code}})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>process.disconnect?.());`], {
    env: { ...process.env, VONVON_HOME: root, HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const events: string[] = [], listeners = new Set<() => void>();
  let stderr = '', closed = false;
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  child.on('message', raw => { events.push(z.object({ event: z.string() }).parse(raw).event); for (const listener of listeners) listener(); });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { closed = true; for (const listener of listeners) listener(); resolve({ code, stderr }); });
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
  function wait(event: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Missing ${event}: ${stderr}`)), 10_000);
      const finish = (error?: Error) => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(); };
      const check = () => { if (events.includes(event)) finish(); else if (closed) finish(new Error(`Exited before ${event}: ${stderr}`)); };
      listeners.add(check); check();
    });
  }
  const state = { child, done, events, wait };
  live.add(state);
  const cleanup = () => { clearTimeout(deadline); live.delete(state); };
  void done.then(cleanup, cleanup);
  return state;
}

it('retains the captured operation, known group and published tombstone across reopening', async () => {
  const root = await home();
  const published = await withCreationJournal(key, async journal => {
    const admitted = await journal.change(prepare(root));
    expect(admitted.snapshot.remoteUuid).toHaveLength(48);
    expect(admitted.snapshot.signature).toMatch(/^create\/v1:/);
    const exposed = journal.read();
    if (!exposed) throw new Error('fixture was not prepared');
    exposed.snapshot.input.name = 'outside mutation';
    expect(journal.read()?.snapshot.input.name).toBe('Research');
    await journal.change({ kind: 'dispatch', at: Date.now() });
    await journal.change({ kind: 'know', chatId: 'oc_fixture', evidence: 'response' });
    return journal.change({ kind: 'publish' });
  }, root);
  expect(published.phase).toMatchObject({ kind: 'published', chatId: 'oc_fixture', evidence: 'response' });
  await withCreationJournal(key, async journal => { expect(journal.read()).toEqual(published); }, root);
  const stored: unknown = JSON.parse(await readFile(pathFor(root), 'utf8'));
  expect(stored).toEqual(published);
});

it('uses semantic inputs and keeps existing bytes when repeat input or group evidence conflicts', async () => {
  const root = await home();
  await withCreationJournal(key, async journal => {
    const seed = prepare(root);
    await journal.change(seed);
    const original = await readFile(pathFor(root));
    const originalInode = (await stat(pathFor(root))).ino;
    await journal.change({ ...seed, input: { network: false, mode: 'full', backend: 'codex-appserver', noMention: true, kind: 'multi', workspace: seed.input.workspace, name: 'Research' } });
    expect(await readFile(pathFor(root))).toEqual(original);
    expect((await stat(pathFor(root))).ino).toBe(originalInode);
    await expect(journal.change({ ...seed, input: { ...seed.input, noMention: false } })).rejects.toThrow('input conflict');
    expect(await readFile(pathFor(root))).toEqual(original);
    await journal.change({ kind: 'dispatch', at: Date.now() });
    await journal.change({ kind: 'know', chatId: 'oc_first', evidence: 'operator-selection' });
    const known = await readFile(pathFor(root));
    await expect(journal.change({ kind: 'know', chatId: 'oc_other', evidence: 'response' })).rejects.toThrow('evidence conflict');
    expect(await readFile(pathFor(root))).toEqual(known);
  }, root);
});

it('never permits dispatching an unknown operation again, including after the platform window', async () => {
  const root = await home();
  await withCreationJournal(key, async journal => {
    await journal.change(prepare(root));
    await expect(journal.change({ kind: 'publish' })).rejects.toThrow('unknown');
    await journal.change({ kind: 'dispatch', at: 1 });
  }, root);
  await withCreationJournal(key, async journal => {
    expect(journal.read()?.phase).toEqual({ kind: 'unknown', dispatchedAt: 1 });
    await expect(journal.change({ kind: 'dispatch', at: Date.now() })).rejects.toThrow('already dispatched');
  }, root);
});

it('captures queued input and drains queued writes before releasing its scope', async () => {
  const root = await home();
  let escaped: Journal | undefined;
  await withCreationJournal(key, async journal => {
    escaped = journal;
    const seed = prepare(root);
    void journal.change(seed);
    seed.input.name = 'mutated after call';
    void journal.change({ kind: 'dispatch', at: 1 });
  }, root);
  await withCreationJournal(key, async journal => {
    expect(journal.read()?.snapshot.input.name).toBe('Research');
    expect(journal.read()?.phase.kind).toBe('unknown');
  }, root);
  if (!escaped) throw new Error('fixture scope missing');
  await expect(escaped.change({ kind: 'publish' })).rejects.toThrow('scope has ended');
});

it('retains evidence outside removed bot data and refuses changing the captured registration', async () => {
  const root = await home(), botDir = join(root, 'bots', key.appId);
  await mkdir(botDir, { recursive: true });
  await withCreationJournal(key, async journal => { await journal.change(prepare(root)); await journal.change({ kind: 'dispatch', at: 1 }); }, root);
  await rm(botDir, { recursive: true });
  await mkdir(botDir);
  await withCreationJournal(key, async journal => {
    expect(journal.read()?.phase.kind).toBe('unknown');
    const seed = prepare(root);
    await expect(journal.change({ ...seed, bot: { ...seed.bot, registrationId: 'replacement-registration' } })).rejects.toThrow('input conflict');
  }, root);
});

// /ship coverage pass 1. Value: protects=invalid persisted records and namespace entries block adoption without discarding evidence;
// fails_when=record validation or namespace rejection is bypassed;
// why_new=the original corruption table omitted schema, UUID and namespace-entry guards;
// seam=none; no_claim=hostile concurrent filesystem replacement or injected read failures.
it.each(['malformed', 'oversized', 'symlink', 'hardlink', 'changed-signature', 'invalid-version', 'invalid-phase',
  'changed-uuid', 'directory', 'foreign-entry', 'file-entry', 'operation-symlink'])('refuses %s records without discarding evidence', async kind => {
  const root = await home(), file = pathFor(root);
  const saved = await withCreationJournal(key, journal => journal.change(prepare(root)), root);
  if (kind === 'malformed') await writeFile(file, '{broken');
  else if (kind === 'oversized') await writeFile(file, ' '.repeat(65537));
  else if (kind === 'changed-signature') { saved.snapshot.input.name = 'other'; await writeFile(file, JSON.stringify(saved)); }
  else if (kind === 'invalid-version') await writeFile(file, JSON.stringify({ ...saved, snapshot: { ...saved.snapshot, version: 2 } }));
  else if (kind === 'invalid-phase') await writeFile(file, JSON.stringify({ ...saved, phase: { kind: 'known' } }));
  else if (kind === 'changed-uuid') await writeFile(file, JSON.stringify({ ...saved, snapshot: { ...saved.snapshot, remoteUuid: '0'.repeat(48) } }));
  else if (kind === 'directory') { await rename(file, `${file}.retained`); await mkdir(file); }
  else if (kind === 'foreign-entry') await mkdir(join(dirname(dirname(file)), 'foreign'));
  else if (kind === 'file-entry') await writeFile(join(dirname(dirname(file)), '0'.repeat(64)), 'foreign evidence');
  else if (kind === 'operation-symlink') {
    const retained = join(root, 'retained-operation');
    await rename(dirname(file), retained); await symlink(retained, dirname(file));
  }
  else {
    await rename(file, `${file}.retained`);
    if (kind === 'symlink') await symlink(`${file}.retained`, file);
    else await link(`${file}.retained`, file);
  }
  const evidenceFile = kind === 'directory' ? `${file}.retained` : file;
  const before = await readFile(evidenceFile);
  let entered = false;
  await expect(withCreationJournal(key, async () => { entered = true; }, root)).rejects.toThrow();
  expect(entered).toBe(false);
  expect(await readFile(evidenceFile)).toEqual(before);
});

// /ship coverage pass 1. Value: protects=invalid changes and unprepared or wrong-account transitions cannot publish evidence;
// fails_when=validation happens after publication or account and initial-state guards disappear;
// why_new=unsafe keys were tested but these change-boundary guards were not;
// seam=none; no_claim=current registration authorization or remote validation.
it.each(['null', 'extra-field', 'blank-name', 'separator-name', 'relative-workspace', 'invalid-mode', 'negative-time',
  'wrong-app', 'wrong-tenant', 'unprepared-dispatch', 'unprepared-know', 'unprepared-publish'])('rejects %s changes before publication and permits a later valid prepare', async kind => {
  const root = await home();
  await withCreationJournal(key, async journal => {
    const seed = prepare(root);
    const changes: Record<string, unknown> = {
      null: null, 'extra-field': { ...seed, unexpected: true },
      'blank-name': { ...seed, input: { ...seed.input, name: '  ' } },
      'separator-name': { ...seed, input: { ...seed.input, name: '../other' } },
      'relative-workspace': { ...seed, input: { ...seed.input, workspace: { kind: 'existing', path: 'relative' } } },
      'invalid-mode': { ...seed, input: { ...seed.input, mode: 'invalid' } },
      'negative-time': { kind: 'dispatch', at: -1 },
      'wrong-app': { ...seed, bot: { ...seed.bot, appId: 'cli_other' } },
      'wrong-tenant': { ...seed, bot: { ...seed.bot, tenant: 'lark' } },
      'unprepared-dispatch': { kind: 'dispatch', at: 1 },
      'unprepared-know': { kind: 'know', chatId: 'oc_other', evidence: 'response' },
      'unprepared-publish': { kind: 'publish' },
    };
    await expect((async () => { await Reflect.apply(journal.change, journal, [changes[kind]]); })()).rejects.toThrow();
    expect(journal.read()).toBeUndefined();
    await expect(readFile(pathFor(root))).rejects.toMatchObject({ code: 'ENOENT' });
    const admitted = await journal.change(seed);
    expect(admitted.phase.kind).toBe('prepared');
    expect(JSON.parse(await readFile(pathFor(root), 'utf8'))).toEqual(admitted);
  }, root);
});

// /ship coverage pass 1. Value: protects=existing workspace path and workspace kind are part of stable operation identity;
// fails_when=path or kind is omitted from the semantic signature;
// why_new=all earlier semantic-signature inputs used default workspaces;
// seam=none; no_claim=workspace admission or remote effects.
it('replays an existing workspace without rewriting and refuses changing its path or kind', async () => {
  const root = await home();
  await withCreationJournal(key, async journal => {
    const seed = prepare(root), path = join(root, 'workspace');
    const existing = { ...seed, input: { ...seed.input, workspace: { kind: 'existing', path } } } satisfies Parameters<Journal['change']>[0];
    const admitted = await journal.change(existing);
    const before = await readFile(pathFor(root)), inode = (await stat(pathFor(root))).ino;
    expect(await journal.change(existing)).toEqual(admitted);
    await expect(journal.change({ ...existing, input: { ...existing.input, workspace: { kind: 'existing', path: `${path}-other` } } })).rejects.toThrow('input conflict');
    await expect(journal.change({ ...existing, input: { ...existing.input, workspace: { kind: 'default', root: path } } })).rejects.toThrow('input conflict');
    expect(await readFile(pathFor(root))).toEqual(before);
    expect((await stat(pathFor(root))).ino).toBe(inode);
  }, root);
});

// /ship coverage pass 1. Value: protects=group evidence is immutable and published tombstones remain terminal through replay;
// fails_when=identical replay rewrites, partial conflict passes, or terminal state downgrades;
// why_new=existing tests changed chat and evidence together and published only once;
// seam=none; no_claim=remote group existence, operator authorization or exactly-once remote creation.
it('enforces premature transitions and preserves known and published evidence through identical and conflicting replay', async () => {
  const root = await home();
  await withCreationJournal(key, async journal => {
    const seed = prepare(root), known = { kind: 'know', chatId: 'oc_known', evidence: 'response' } satisfies Parameters<Journal['change']>[0];
    await journal.change(seed);
    const prepared = await readFile(pathFor(root));
    await expect(journal.change(known)).rejects.toThrow('not been dispatched');
    expect(await readFile(pathFor(root))).toEqual(prepared);
    await journal.change({ kind: 'dispatch', at: 1 });
    const unknown = await readFile(pathFor(root));
    await expect(journal.change({ kind: 'publish' })).rejects.toThrow('unknown');
    expect(await readFile(pathFor(root))).toEqual(unknown);
    await journal.change(known);
    for (const phase of ['known', 'published']) {
      if (phase === 'published') await journal.change({ kind: 'publish' });
      const before = await readFile(pathFor(root)), inode = (await stat(pathFor(root))).ino;
      expect((await journal.change(known)).phase.kind).toBe(phase);
      expect((await journal.change(seed)).phase.kind).toBe(phase);
      if (phase === 'published') expect((await journal.change({ kind: 'publish' })).phase.kind).toBe('published');
      await expect(journal.change({ ...known, chatId: 'oc_other' })).rejects.toThrow('evidence conflict');
      await expect(journal.change({ ...known, evidence: 'operator-selection' })).rejects.toThrow('evidence conflict');
      await expect(journal.change({ kind: 'dispatch', at: 2 })).rejects.toThrow('already dispatched');
      expect(await readFile(pathFor(root))).toEqual(before);
      expect((await stat(pathFor(root))).ino).toBe(inode);
      expect(journal.read()?.phase.kind).toBe(phase);
    }
  }, root);
});

it('poisons an owner after a failed write, requiring a fresh read before any later transition', async () => {
  const root = await home(), file = pathFor(root);
  await withCreationJournal(key, async journal => {
    await journal.change(prepare(root));
    await rename(file, `${file}.retained`); await mkdir(file);
    await expect(journal.change({ kind: 'dispatch', at: 1 })).rejects.toThrow();
    await rm(file, { recursive: true }); await rename(`${file}.retained`, file);
    expect(() => journal.read()).toThrow('reopen');
    await expect(journal.change({ kind: 'dispatch', at: 2 })).rejects.toThrow('reopen');
  }, root);
  await withCreationJournal(key, async journal => { expect(journal.read()?.phase.kind).toBe('prepared'); }, root);
});

it('requires directory publication to succeed when reopening an interrupted allocation', async () => {
  const root = await home(), file = pathFor(root), namespace = dirname(dirname(file));
  await mkdir(dirname(file), { recursive: true });
  const child = actor(root, `
    const fs=require('node:fs/promises'),oldOpen=fs.open;
    let failSync=true;
    fs.open=async(p,...args)=>{const handle=await oldOpen(p,...args);if(failSync&&p===${JSON.stringify(namespace)})handle.sync=async()=>{throw Error('injected-adoption-sync')};return handle;};
    await assert.rejects(m.withCreationJournal(key,j=>j.change(seed),${JSON.stringify(root)}),/injected-adoption-sync/);
    await assert.rejects(fs.readFile(${JSON.stringify(file)}),{code:'ENOENT'});
    failSync=false;
    await m.withCreationJournal(key,async j=>{await j.change(seed);await j.change({kind:'dispatch',at:1});},${JSON.stringify(root)});
    assert.equal(JSON.parse(await fs.readFile(${JSON.stringify(file)},'utf8')).phase.kind,'unknown');
  `);
  expect(await child.done).toEqual({ code: 0, stderr: '' });
});

it('reopens the actual unknown record after an injected directory-sync error following rename', async () => {
  const root = await home(), file = pathFor(root);
  const child = actor(root, `
    const fs=require('node:fs/promises'),oldRename=fs.rename,oldOpen=fs.open;
    let failSync=false;
    fs.rename=async(a,b)=>{await oldRename(a,b);if(b===${JSON.stringify(file)})failSync=JSON.parse(await fs.readFile(b,'utf8')).phase.kind==='unknown';};
    fs.open=async(p,...args)=>{const handle=await oldOpen(p,...args);if(failSync&&p===${JSON.stringify(dirname(file))}){failSync=false;handle.sync=async()=>{throw Error('injected-directory-sync')};}return handle;};
    await m.withCreationJournal(key,async j=>{
      await j.change(seed);
      await assert.rejects(j.change({kind:'dispatch',at:1}),/injected-directory-sync/);
      assert.equal(JSON.parse(await fs.readFile(${JSON.stringify(file)},'utf8')).phase.kind,'unknown');
      assert.throws(()=>j.read(),/reopen/);
      await assert.rejects(j.change({kind:'dispatch',at:2}),/reopen/);
    },${JSON.stringify(root)});
    await m.withCreationJournal(key,async j=>{assert.equal(j.read().phase.kind,'unknown');await assert.rejects(j.change({kind:'dispatch',at:3}),/already dispatched/);},${JSON.stringify(root)});
  `);
  expect(await child.done).toEqual({ code: 0, stderr: '' });
});

// /ship coverage pass 2. Value: protects=pre-publication I/O failure retains evidence, poisons the owner and preserves the primary error;
// fails_when=failed writes publish, permit another transition or lose their error to cleanup;
// why_new=earlier injected failures happened at rename or after publication;
// seam=none; no_claim=hardware power loss; injected syscall faults act on real temporary files and handles.
it.each(['open', 'write', 'sync', 'close'])('retains prepared evidence after temporary %s failure even when cleanup also fails', async stage => {
  const root = await home(), file = pathFor(root);
  const child = actor(root, `
    const fs=require('node:fs/promises'),oldOpen=fs.open,oldUnlink=fs.unlink;
    const temporary=p=>typeof p==='string'&&p.startsWith(${JSON.stringify(`${file}.tmp-`)});
    let armed=false,cleanupFailed=false;
    fs.open=async(p,...args)=>{
      if(armed&&temporary(p)&&${JSON.stringify(stage)}==='open')throw Error('injected-open');
      const handle=await oldOpen(p,...args);
      if(armed&&temporary(p)){
        if(${JSON.stringify(stage)}==='write')handle.writeFile=async()=>{throw Error('injected-write')};
        if(${JSON.stringify(stage)}==='sync')handle.sync=async()=>{throw Error('injected-sync')};
        if(${JSON.stringify(stage)}==='close'){
          const close=handle.close.bind(handle);
          handle.close=async()=>{await close();throw Error('injected-close')};
        }
      }
      return handle;
    };
    fs.unlink=async(p)=>{
      if(armed&&temporary(p)){cleanupFailed=true;throw Error('injected-cleanup')}
      return oldUnlink(p);
    };
    let before;
    await m.withCreationJournal(key,async j=>{
      await j.change(seed);
      before=await fs.readFile(${JSON.stringify(file)});
      armed=true;
      await assert.rejects(j.change({kind:'dispatch',at:1}),{message:${JSON.stringify(`injected-${stage}`)}});
      assert.equal(cleanupFailed,true);
      assert.deepEqual(await fs.readFile(${JSON.stringify(file)}),before);
      assert.throws(()=>j.read(),/reopen/);
      await assert.rejects(j.change({kind:'dispatch',at:2}),/reopen/);
    },${JSON.stringify(root)});
    armed=false;
    await m.withCreationJournal(key,async j=>{
      assert.equal(j.read().phase.kind,'prepared');
      assert.deepEqual(await fs.readFile(${JSON.stringify(file)}),before);
      await j.change({kind:'dispatch',at:3});
      assert.equal(j.read().phase.kind,'unknown');
    },${JSON.stringify(root)});
  `);
  expect(await child.done).toEqual({ code: 0, stderr: '' });
});

// /ship coverage pass 2. Value: protects=callback failure drains queued publication under ownership and preserves the callback error;
// fails_when=scope settles or releases its owner before the queued write completes;
// why_new=the earlier queue-drain case returned normally and had no blocked publication;
// seam=none; no_claim=mutex-close double failures; the publication barrier delays a real rename.
it('drains a queued write before releasing ownership when the callback throws', async () => {
  const root = await home(), file = pathFor(root);
  const first = actor(root, `
    const fs=require('node:fs/promises'),oldRename=fs.rename;
    let block=false;
    fs.rename=async(a,b)=>{
      if(block&&b===${JSON.stringify(file)}){probe('write-pending');await pause()}
      return oldRename(a,b);
    };
    const failure=Error('callback-failure');
    await assert.rejects(m.withCreationJournal(key,async j=>{
      await j.change(seed);
      block=true;
      void j.change({kind:'dispatch',at:1});
      throw failure;
    },${JSON.stringify(root)}),error=>error===failure);
    probe('scope-settled');
    assert.equal(JSON.parse(await fs.readFile(${JSON.stringify(file)},'utf8')).phase.kind,'unknown');
  `);
  await first.wait('write-pending');
  const second = actor(root, `await m.withCreationJournal(key,async j=>{
    assert.equal(j.read().phase.kind,'unknown');probe('retained');
  },${JSON.stringify(root)});`);
  await second.wait('attempt');
  expect(first.events).not.toContain('scope-settled');
  expect(second.events).not.toContain('acquired');
  first.child.send('continue');
  expect(await first.done).toEqual({ code: 0, stderr: '' });
  expect(await second.done).toEqual({ code: 0, stderr: '' });
  expect(second.events).toContain('retained');
});

it('rejects a valid journal copied into another operation scope', async () => {
  const root = await home(), other = { ...key, tenant: 'lark' } satisfies Key;
  await withCreationJournal(key, journal => journal.change(prepare(root)), root);
  await withCreationJournal(other, async () => {}, root);
  const original = await readFile(pathFor(root));
  await writeFile(pathFor(root, other), original);
  await expect(withCreationJournal(other, async () => {}, root)).rejects.toThrow('Invalid creation operation evidence');
  expect(await readFile(pathFor(root, other))).toEqual(original);
});

it('rejects invalid keys and a symlinked journal namespace before adopting content', async () => {
  const root = await home(), outside = await home();
  await expect(withCreationJournal({ ...key, id: '../unsafe' }, async () => {}, root)).rejects.toThrow();
  await symlink(outside, join(root, 'creation-operations'));
  await expect(withCreationJournal(key, async () => {}, root)).rejects.toThrow('Invalid creation journal directory');
  await expect(stat(join(outside, '.locks'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['prepared', 'unknown', 'known'])('releases kernel ownership after SIGKILL with %s evidence intact', async phase => {
  const root = await home();
  const child = actor(root, `await m.withCreationJournal(key,async j=>{await j.change(seed);
    if(${JSON.stringify(phase)}!=='prepared')await j.change({kind:'dispatch',at:1});
    if(${JSON.stringify(phase)}==='known')await j.change({kind:'know',chatId:'oc_retained',evidence:'response'});
    probe('held');await pause();},${JSON.stringify(root)});`);
  await child.wait('held'); child.child.kill('SIGKILL'); await child.done;
  await withCreationJournal(key, async journal => { expect(journal.read()?.phase.kind).toBe(phase); }, root);
});

it('serializes the same operation across processes while unrelated operations and root writers progress', async () => {
  const root = await home();
  const first = actor(root, `await m.withCreationJournal(key,async j=>{await j.change(seed);await j.change({kind:'dispatch',at:1});probe('held');await pause();await j.change({kind:'know',chatId:'oc_single',evidence:'response'});},${JSON.stringify(root)});`);
  await first.wait('held');
  const second = actor(root, `await m.withCreationJournal(key,async j=>{assert.equal(j.read().phase.kind,'known');probe('same-result');},${JSON.stringify(root)});`);
  await second.wait('attempt');
  const other = actor(root, `await m.withCreationJournal(key,async j=>{await j.change(seed);},${JSON.stringify(root)});`, { ...key, id: 'creation-operation-other' });
  expect(await other.done).toEqual({ code: 0, stderr: '' });
  const rootWriter = await acquireMutex(root, 'bots', 0); await closeMutex(rootWriter);
  expect(second.events).not.toContain('acquired');
  first.child.send('continue');
  expect(await first.done).toEqual({ code: 0, stderr: '' });
  expect(await second.done).toEqual({ code: 0, stderr: '' });
  expect(second.events).toContain('same-result');
});

it('refuses new operations at capacity without evicting existing records', async () => {
  const root = await home();
  await withCreationJournal(key, journal => journal.change(prepare(root)), root);
  const before = await readFile(pathFor(root));
  for (let i = 0; i < 4095; i++) mkdirSync(join(root, 'creation-operations', i.toString(16).padStart(64, '0')));
  await expect(withCreationJournal({ ...key, id: 'creation-capacity-next' }, async () => {}, root)).rejects.toThrow('limit reached');
  await withCreationJournal(key, async journal => { expect(journal.read()?.phase.kind).toBe('prepared'); }, root);
  expect(await readFile(pathFor(root))).toEqual(before);
}, 20_000);
