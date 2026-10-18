import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const Probe = z.object({ event: z.string(), actor: z.string(), time: z.number(), file: z.string().optional() });
type Probe = z.infer<typeof Probe>;
let scratch: string;
let bundle: string;
const live = new Set<ReturnType<typeof actor>>();
const trace: (Probe & { sequence: number })[] = [];
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'project-writers-')));
  bundle = join(scratch, 'registry.cjs');
  const actual = fileURLToPath(new URL('../src/config/data-access.ts', import.meta.url));
  await build({ stdin: { contents: `export * from './src/project/registry';export * from './src/project/creation-journal';export {useBotDir} from './src/config/paths';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'observe-real-mutex', setup(api) {
      api.onResolve({ filter: /\/data-access$/ }, () => ({ path: 'mutex-observer', namespace: 'fixture' }));
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        import * as actual from ${JSON.stringify(actual)};
        export * from ${JSON.stringify(actual)};
        const probe=event=>process.send?.({event,actor:process.env.ACTOR,time:performance.now()});
        export async function acquireMutex(path,role,wait){probe('attempt');const held=await actual.acquireMutex(path,role,process.env.SHORT_WAIT?80:wait);probe('acquired');return held;}
        export async function closeMutex(held){await actual.closeMutex(held);probe('released');if(process.env.FAIL_RELEASE)throw Error('release-failure');}
      `, loader: 'ts', resolveDir: dirname(actual) }));
    } }] });
});
afterAll(async () => {
  for (const state of live) if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGKILL');
  await Promise.all([...live].map(state => state.done));
  await rm(scratch, { recursive: true, force: true });
});
async function home(): Promise<string> { return mkdtemp(join(scratch, 'data-')); }
const project = (name: string, cwd = '/legacy-cwd') => ({ name, chatId: `fixture-${name}`, cwd, blank: true, createdAt: 1 });
const add = (name: string) => `await m.addProject(${JSON.stringify(project(name))});`;
function actor(root: string, name: string, code: string, options: { hold?: boolean; shortWait?: boolean; failRelease?: boolean; renameFailure?: boolean; journalFailure?: 'before' | 'after' } = {}) {
  const setup = `const fs=require('node:fs/promises');const probe=(event,file)=>process.send({event,file,actor:process.env.ACTOR,time:performance.now()});
    const read=fs.readFile,write=fs.writeFile,rename=fs.rename;
    fs.readFile=async(p,...args)=>{if(String(p).endsWith('/projects.json'))probe('read-start',String(p));try{const result=await read(p,...args);if(String(p).endsWith('/projects.json'))probe('read-done',String(p));return result}catch(error){if(String(p).endsWith('/projects.json'))probe('read-failed',String(p));throw error}};
    fs.writeFile=async(p,...args)=>{const result=await write(p,...args);if(String(p).includes('projects.json.tmp-'))probe('temp-written',String(p));return result};
    fs.rename=async(a,b)=>{if(String(b).endsWith('/projects.json')){probe('rename',String(b));if(process.env.HOLD_RENAME)await new Promise(resolve=>process.once('message',resolve));if(process.env.FAIL_RENAME)throw Error('rename-failure');}
      if(process.env.JOURNAL_FAILURE&&String(b).endsWith('/operation.json')&&JSON.parse(await read(a,'utf8')).phase.kind==='published'){
        if(process.env.JOURNAL_FAILURE==='after')await rename(a,b);throw Error('terminal-marker-failure');}return rename(a,b)};
    const m=require(${JSON.stringify(bundle)});`;
  const child = spawn(process.execPath, ['-e', `${setup}(async()=>{${code};probe('success')})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>process.disconnect?.())`], {
    env: { ...process.env, VONVON_HOME: root, ACTOR: name, ...(options.hold ? { HOLD_RENAME: '1' } : {}),
      ...(options.shortWait ? { SHORT_WAIT: '1' } : {}), ...(options.failRelease ? { FAIL_RELEASE: '1' } : {}), ...(options.renameFailure ? { FAIL_RENAME: '1' } : {}),
      ...(options.journalFailure ? { JOURNAL_FAILURE: options.journalFailure } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events: Probe[] = [];
  const listeners = new Set<() => void>();
  let stdout = '', stderr = '';
  let closed = false;
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  child.on('message', message => { const event = Probe.parse(message); events.push(event); trace.push({ ...event, sequence: trace.length }); for (const listener of listeners) listener(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { closed = true; for (const listener of listeners) listener(); resolve({ code, stdout, stderr }); });
  });
  const deadline = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 12_000);
  const cleanup = () => { clearTimeout(deadline); live.delete(state); };
  void done.then(cleanup, cleanup);
  function wait(...names: string[]): Promise<Probe> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Missing ${name} ${names.join('/')} ${stderr}`)), 10_000);
      const finish = (error?: Error, result?: Probe): void => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else if (result) resolve(result); };
      const check = (): void => { const event = events.find(event => names.includes(event.event)); if (event) finish(undefined, event); else if (closed) finish(new Error(`Exited before ${names}: ${stderr}`)); };
      listeners.add(check); check();
    });
  }
  const state = { child, done, wait, events, release: () => child.send('continue') };
  live.add(state);
  return state;
}
async function successful(root: string, code: string): Promise<string> {
  const result = await actor(root, 'single', code).done;
  expect(result.stderr).toBe(''); expect(result.code).toBe(0); return result.stdout;
}
async function disk(root: string) { return JSON.parse(await readFile(join(root, 'projects.json'), 'utf8')); }
async function releaseAll(states: ReturnType<typeof actor>[]): Promise<void> {
  const pending = new Map(states.map(state => [state, state.wait('rename').then(() => state)]));
  while (pending.size) { const state = await Promise.race(pending.values()); pending.delete(state); state.release(); expect((await state.done).code).toBe(0); }
}

const creation = { requestId: 'creation-request-0001', signature: 'legacy-signature', name: 'Created', chatId: 'oc_created' };
const target = `{file:process.env.VONVON_HOME+'/projects.json',dataRoot:process.env.VONVON_HOME}`;
const publish = `await m.publishCreatedProject(${JSON.stringify(creation)},async()=>{probe('prepare');return {cwd:'/legacy-cwd',blank:true,createdAt:1}},${target})`;

describe('creation publication and terminal removal', () => {
  it.each(['before', 'after'] as const)('respects removal when the real journal terminal rename reports failure %s replacement', async stage => {
    const root = await home();
    const seed = { kind: 'prepare', bot: { appId: 'cli_fixture', tenant: 'feishu', createdAt: 1 }, operatorOpenId: 'ou_fixture',
      input: { name: 'Created', workspace: { kind: 'default', root: join(root, 'projects') }, kind: 'multi', noMention: true, backend: 'codex-appserver', mode: 'full', network: false } };
    const key = { appId: 'cli_fixture', tenant: 'feishu', id: creation.requestId };
    const failed = actor(root, 'marker-failure', `await m.withCreationJournal(${JSON.stringify(key)},async journal=>{
      await journal.change(${JSON.stringify(seed)});await journal.change({kind:'dispatch',at:1});await journal.change({kind:'know',chatId:'oc_created',evidence:'response'});
      ${publish};await journal.change({kind:'publish'});},process.env.VONVON_HOME);`, { journalFailure: stage });
    const failure = await failed.done;
    expect(failure.code).toBe(1); expect(failure.stderr).toContain('terminal-marker-failure');
    expect((await disk(root)).projects).toHaveLength(1);
    await successful(root, `await m.removeProject('Created');`);
    const resumed = actor(root, 'resume', `await m.withCreationJournal(${JSON.stringify(key)},async journal=>{
      if(journal.read().phase.kind!==${JSON.stringify(stage === 'before' ? 'known' : 'published')})throw Error('wrong persisted phase');
      console.log(JSON.stringify(${publish}));},process.env.VONVON_HOME);`);
    const result = await resumed.done;
    expect(result.code).toBe(0); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout)).toEqual({ kind: 'removed' });
    expect(resumed.events.some(event => event.event === 'prepare')).toBe(false);
    expect(await disk(root)).toMatchObject({ projects: [], creationRemovals: [creation.requestId] });
  });

  it('serializes first publication, removal and six later resumes without another preparation', async () => {
    const root = await home();
    const first = actor(root, 'create', publish + ';', { hold: true }); await first.wait('rename');
    const removal = actor(root, 'remove', `await m.removeProject('Created');`, { hold: true }); await removal.wait('attempt');
    first.release(); expect((await first.done).code).toBe(0); await removal.wait('rename');
    const rest = Array.from({ length: 6 }, (_, i) => actor(root, `resume-${i}`, `console.log(JSON.stringify(${publish}));`));
    await Promise.all(rest.map(state => state.wait('attempt'))); removal.release(); expect((await removal.done).code).toBe(0);
    for (const state of rest) {
      const result = await state.done;
      expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ kind: 'removed' });
      expect(state.events.some(event => event.event === 'prepare')).toBe(false);
    }
    expect((await disk(root)).creationRemovals).toEqual([creation.requestId]);
  });

  // Coverage generation pass 1, gap 22.
  // Value: protects=authoritative existing and absent creation lookups without writes;
  // fails_when=lookup loses current settings, returns an unrelated row or writes on read;
  // why_new=existing lookup assertions cover retired operations only; seam=none;
  // no_claim=authorization and production caller wiring remain outside this registry fixture.
  it('returns current completed settings and missing cwd unchanged, and refuses conflicting evidence before preparation', async () => {
    const root = await home();
    const missing = actor(root, 'lookup-missing', `console.log(JSON.stringify(await m.getCreationProject(${JSON.stringify(creation.requestId)},${target})));`);
    const missingResult = await missing.done;
    expect(missingResult.code).toBe(0); expect(missingResult.stderr).toBe(''); expect(JSON.parse(missingResult.stdout)).toEqual({ kind: 'absent' });
    await expect(readFile(join(root, 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing.events.some(event => event.event === 'temp-written' || event.event === 'rename')).toBe(false);
    await successful(root, publish + ';');
    await successful(root, `await m.mutateProject('Created',row=>{row.name='Renamed';row.cwd='/gone';row.backend='changed';row.createdAt=7;row.noMention=false});`);
    const bytes = await readFile(join(root, 'projects.json'), 'utf8');
    const lookup = actor(root, 'lookup-current', `console.log(JSON.stringify([
      await m.getCreationProject(${JSON.stringify(creation.requestId)},${target}),await m.getCreationProject('creation-request-0002',${target})]));`);
    const lookupResult = await lookup.done;
    expect(lookupResult.code).toBe(0); expect(lookupResult.stderr).toBe('');
    expect(JSON.parse(lookupResult.stdout)).toEqual([{ kind: 'existing', project: (await disk(root)).projects[0] }, { kind: 'absent' }]);
    expect(lookup.events.some(event => event.event === 'temp-written' || event.event === 'rename')).toBe(false);
    expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
    const replay = actor(root, 'replay', `console.log(JSON.stringify(${publish}));`);
    const result = await replay.done;
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'existing', project: { name: 'Renamed', cwd: '/gone', backend: 'changed', createdAt: 7, noMention: false } });
    expect(replay.events.some(event => event.event === 'prepare')).toBe(false);
    for (const patch of [{ signature: 'different' }, { chatId: 'oc_different' }]) {
      const conflict = actor(root, 'conflict', `await m.publishCreatedProject(${JSON.stringify({ ...creation, ...patch })},async()=>{probe('prepare');throw Error('must not prepare')},${target});`);
      expect((await conflict.done).stderr).toContain('input conflict'); expect(conflict.events.some(event => event.event === 'prepare')).toBe(false);
    }
    expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
  });

  // Coverage generation pass 1, gap 23.
  // Value: protects=fresh creation operations reject independent name and chat collisions before preparation;
  // fails_when=either collision guard is removed or preparation runs before refusal;
  // why_new=same-operation conflicts return before the fresh-operation exclusivity guard; seam=none;
  // no_claim=no remote group creation or UI acceptance is exercised.
  it('refuses fresh creation name and chat conflicts before preparation without changing bytes', async () => {
    const root = await home(); await successful(root, publish + ';');
    const bytes = await readFile(join(root, 'projects.json'), 'utf8');
    for (const input of [
      { ...creation, requestId: 'creation-request-0002', chatId: 'oc_different' },
      { ...creation, requestId: 'creation-request-0003', name: 'Different' },
    ]) {
      const conflict = actor(root, 'fresh-conflict', `await m.publishCreatedProject(${JSON.stringify(input)},async()=>{probe('prepare');throw Error('must not prepare')},${target});`);
      const result = await conflict.done;
      expect(result.code).toBe(1); expect(result.stderr).toContain('项目名称或群已绑定');
      expect(conflict.events.some(event => event.event === 'prepare')).toBe(false);
      expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
    }
  });

  // Coverage generation pass 1, gap 24.
  // Value: protects=failed creation preparation publishes no row and releases ownership for another process;
  // fails_when=the original error is replaced, a partial row is saved or ownership stays held;
  // why_new=existing preparation-rejection coverage calls bindProject rather than creation publication; seam=none;
  // no_claim=external directory rollback is not promised or tested.
  it('retains the creation preparation error without a row and lets a separate process publish', async () => {
    const root = await home();
    const failed = actor(root, 'creation-prepare-failed', `const primary=Error('creation-prepare-failed');
      try{await m.publishCreatedProject(${JSON.stringify(creation)},async()=>{probe('prepare');throw primary},${target})}
      catch(error){if(error!==primary)throw Error('original preparation error replaced');throw error}`);
    const result = await failed.done;
    expect(result.code).toBe(1); expect(result.stderr).toMatch(/^Error: creation-prepare-failed\b/);
    expect(failed.events.filter(event => event.event === 'prepare')).toHaveLength(1);
    expect(failed.events.some(event => event.event === 'released')).toBe(true);
    expect(failed.events.some(event => event.event === 'temp-written' || event.event === 'rename')).toBe(false);
    await expect(readFile(join(root, 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = JSON.parse(await successful(root, `console.log(JSON.stringify(${publish}));`));
    expect(saved).toMatchObject({ kind: 'published', project: { name: creation.name, chatId: creation.chatId,
      creationRequestId: creation.requestId, creationRequestSignature: creation.signature } });
    expect((await disk(root)).projects).toEqual([saved.project]);
  });

  it('retains legacy deletion across every registry writer and allows ordinary rebind without reviving its old identity', async () => {
    const root = await home(); await successful(root, publish + ';' + add('Other'));
    await successful(root, `await m.removeProject('Created');await m.updateProject('Other',{branch:'changed'});
      await m.mutateProject('Other',row=>{row.directories={repositories:[]}});await m.resetProjectDirectoryOverride('Other','repositories');
      await m.setTierMergePending(['fixture-Other']);${add('Added')}
      await m.bindProject({name:'Rebound',chatId:'oc_created',cwd:{kind:'existing',path:'/legacy-cwd'},backend:'codex-appserver',defaultBackend:'codex-appserver',kind:'multi',noMention:true},async()=>({cwd:'/legacy-cwd',blank:false,createdAt:2,origin:'joined'}));
      console.log(JSON.stringify(await m.getCreationProject(${JSON.stringify(creation.requestId)},${target})));`);
    const saved = await disk(root);
    expect(saved.creationRemovals).toEqual([creation.requestId]); expect(saved.projects.map((p: { name: string }) => p.name)).toEqual(['Other', 'Added', 'Rebound']);
    const lookup = await successful(root, `console.log(JSON.stringify(await m.getCreationProject(${JSON.stringify(creation.requestId)},${target})));`);
    expect(JSON.parse(lookup)).toEqual({ kind: 'retired' });
    const readd = await actor(root, 'readd', `await m.addProject(${JSON.stringify({ ...project('Resurrected'), creationRequestId: creation.requestId })});`).done;
    expect(readd.code).toBe(1); expect(readd.stderr).toContain('Conflicting creation');
    expect(await disk(root)).toEqual(saved);
  });

  it('leaves bytes unchanged on guarded removal, failed replacement and identity mutation', async () => {
    const root = await home(); await successful(root, publish + ';'); const bytes = await readFile(join(root, 'projects.json'), 'utf8');
    const attempts = [
      `await m.removeProject('Created',row=>{row.creationRequestId='mutated-request-0001';throw Error('stale revision')});`,
      `await m.updateProject('Created',{creationRequestId:'mutated-request-0001'});`,
      `await m.mutateProject('Created',row=>{delete row.creationRequestId;delete row.creationRequestSignature});`,
      `await m.updateProject('Created',{creationRequestSignature:'changed'});`, `await m.updateProject('Created',{chatId:'oc_changed'});`,
    ];
    for (const code of attempts) { expect((await actor(root, 'rejected', code).done).code).toBe(1); expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes); }
    expect((await actor(root, 'failed-remove', `await m.removeProject('Created');`, { renameFailure: true }).done).code).toBe(1);
    expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
    await successful(root, `if(await m.removeProject('absent')!==undefined)throw Error('missing remove');await m.removeProject('Created');`);
    expect((await disk(root)).creationRemovals).toEqual([creation.requestId]);
  });

  it.each([null, {}, ['short'], ['creation-request-0001', 'creation-request-0001'], Array.from({ length: 4097 }, (_, i) => `retired-request-${String(i).padStart(5, '0')}`)])('refuses malformed deletion evidence without rewriting it (%#)', async removals => {
    const root = await home(), bytes = JSON.stringify({ version: 1, projects: [project('Other')], creationRemovals: removals });
    await writeFile(join(root, 'projects.json'), bytes);
    const result = await actor(root, 'corrupt', `await m.listProjects();await m.removeProject('Other');`).done;
    expect(result.code).toBe(1); expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
    expect((await actor(root, 'tier-corrupt', `await m.setTierMergePending(['fixture-Other']);`).done).code).toBe(1);
    expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
  });

  // Coverage generation pass 1, gap 25.
  // Value: protects=invalid live creation evidence refuses reads and writes with stored bytes unchanged;
  // fails_when=invalid IDs, orphan signatures or missing or empty chats are admitted;
  // why_new=existing corruption cases cover removal sets, duplicate IDs and live/removed contradictions; seam=none;
  // no_claim=no hostile writer or hardware power-loss protection is demonstrated.
  it('refuses duplicate live identities and live/removed contradictions, retaining unknown metadata on valid writes', async () => {
    const root = await home(), row = { ...project('Created'), creationRequestId: creation.requestId, creationRequestSignature: 'opaque legacy signature' };
    const malformedRows = [{ ...row, creationRequestId: 'short' },
      { ...project('Created'), creationRequestSignature: row.creationRequestSignature }, { ...row, chatId: undefined }, { ...row, chatId: '' }];
    for (const data of [{ projects: [row, { ...row, name: 'Other', chatId: 'oc_other' }] }, { projects: [row], creationRemovals: [creation.requestId] },
      ...malformedRows.map(invalid => ({ projects: [invalid] }))]) {
      const bytes = JSON.stringify({ version: 1, ...data }); await writeFile(join(root, 'projects.json'), bytes);
      expect((await actor(root, 'evidence-read', `await m.getCreationProject(${JSON.stringify(creation.requestId)},${target});`).done).code).toBe(1);
      expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
      expect((await actor(root, 'contradiction', `await m.removeProject('Created');`).done).code).toBe(1);
      expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
      expect((await actor(root, 'evidence-tier-write', `await m.setTierMergePending(['fixture-Created']);`).done).code).toBe(1);
      expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(bytes);
    }
    await writeFile(join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [row], future: { keep: true } }));
    await successful(root, `await m.removeProject('Created');${add('After')}`);
    expect(await disk(root)).toMatchObject({ creationRemovals: [creation.requestId], future: { keep: true } });
  });

  it('keeps all 4096 retirements, refuses the next tracked removal and still removes untracked rows', async () => {
    const root = await home(), removals = Array.from({ length: 4095 }, (_, i) => `retired-request-${String(i).padStart(5, '0')}`);
    await writeFile(join(root, 'projects.json'), JSON.stringify({ version: 1, creationRemovals: removals, projects: [
      { ...project('Created'), creationRequestId: creation.requestId }, { ...project('Next'), creationRequestId: 'creation-request-0002' }, project('Untracked'),
    ] }));
    await successful(root, `await m.removeProject('Created');`); const full = await readFile(join(root, 'projects.json'), 'utf8');
    const failed = await actor(root, 'full', `await m.removeProject('Next');`).done;
    expect(failed.code).toBe(1); expect(failed.stderr).toContain('Creation removal limit'); expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(full);
    await successful(root, `await m.removeProject('Untracked');`);
    const saved = await disk(root); expect(saved.creationRemovals).toEqual([...removals, creation.requestId]); expect(saved.projects.map((p: { name: string }) => p.name)).toEqual(['Next']);
  });
});

describe('project registry process ownership', () => {
  it('prepares and publishes one binding across eight independent processes', async () => {
    const root = await home();
    const cwd = join(root, 'projects', 'bound');
    await mkdir(cwd, { recursive: true });
    const identity = { name: 'bound', chatId: 'oc_bound', cwd: {kind:'existing',path:cwd}, backend: 'codex-appserver', defaultBackend: 'codex-appserver', kind: 'multi', noMention: true };
    const code = `const result=await m.bindProject(${JSON.stringify(identity)},async()=>{probe('prepare');return {cwd:${JSON.stringify(cwd)},blank:false,createdAt:1,origin:'joined',backend:'codex-appserver',directories:{workspaces:{primary:${JSON.stringify(cwd)},additional:[]}}}});console.log(JSON.stringify(result));`;
    const first = actor(root, 'bind-0', code, { hold: true });
    await first.wait('rename');
    const rest = Array.from({ length: 7 }, (_, index) => actor(root, `bind-${index + 1}`, code));
    await Promise.all(rest.map(state => state.wait('attempt')));
    first.release();
    const states = [first, ...rest];
    const results = await Promise.all(states.map(async state => {
      const result = await state.done;
      expect(result.stderr).toBe(''); expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    }));
    expect(results.filter(result => result.kind === 'bound')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'existing')).toHaveLength(7);
    expect(results.every(result => JSON.stringify(result.project) === JSON.stringify(results[0].project))).toBe(true);
    expect(states.flatMap(state => state.events).filter(event => event.event === 'prepare')).toHaveLength(1);
    expect((await disk(root)).projects).toEqual([results[0].project]);
  });

  it('releases a failed binding preparation and lets a separate process bind', async () => {
    const root = await home();
    const identity = { name: 'bound', chatId: 'oc_bound', cwd: {kind:'existing',path:'/legacy-cwd'}, backend: 'codex-appserver', defaultBackend: 'codex-appserver', kind: 'multi', noMention: true };
    const failed = actor(root, 'bind-failed', `await m.bindProject(${JSON.stringify(identity)},async()=>{throw Error('prepare-failed')});`);
    const result = await failed.done;
    expect(result.code).toBe(1); expect(result.stderr).toContain('prepare-failed');
    await expect(readFile(join(root, 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(failed.events.some(event => event.event === 'released')).toBe(true);
    const saved = await successful(root, `console.log(JSON.stringify(await m.bindProject(${JSON.stringify(identity)},async()=>({cwd:'/legacy-cwd',blank:true,createdAt:1}))));`);
    expect(JSON.parse(saved).kind).toBe('bound');
    expect((await disk(root)).projects).toHaveLength(1);
  });

  it('preserves all eight successful adds across a forced publication interleaving', async () => {
    const root = await home();
    const first = actor(root, 'add-0', add('add-0'), { hold: true });
    await first.wait('rename');
    const rest = Array.from({ length: 7 }, (_, index) => actor(root, `add-${index + 1}`, add(`add-${index + 1}`), { hold: true }));
    await Promise.all(rest.map(state => state.wait('attempt', 'rename')));
    await releaseAll([first, ...rest]);
    const saved = await disk(root);
    console.log(JSON.stringify({ scenario: 'eight-adds', trace: trace.filter(event => event.actor.startsWith('add-')), names: saved.projects.map((row: { name: string }) => row.name) }));
    expect(saved.projects.map((row: { name: string }) => row.name).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `add-${index}`));
  });

  it('applies eight function patches to the latest committed whitelist exactly once each', async () => {
    const root = await home();
    await successful(root, add('base'));
    const patch = (index: number) => `let calls=0;await m.updateProject('base',row=>{calls++;return {allowedUsers:[...(row.allowedUsers??[]),'user-${index}']}});if(calls!==1)throw Error('callback count');`;
    const first = actor(root, 'patch-0', patch(0), { hold: true });
    await first.wait('rename');
    const rest = Array.from({ length: 7 }, (_, index) => actor(root, `patch-${index + 1}`, patch(index + 1), { hold: true }));
    await Promise.all(rest.map(state => state.wait('attempt', 'rename')));
    await releaseAll([first, ...rest]);
    expect((await disk(root)).projects[0].allowedUsers.sort()).toEqual(Array.from({ length: 8 }, (_, index) => `user-${index}`));
  });

  it('retains independent changes from all six mutators and unknown metadata', async () => {
    const root = await home();
    await writeFile(join(root, 'projects.json'), JSON.stringify({ version: 1, future: { keep: true }, projects: [
      { ...project('update'), rowFuture: 'keep' }, project('remove'), project('mutate'),
      { ...project('reset'), directories: { repositories: [] } },
    ] }));
    const codes = [add('added'), `await m.setTierMergePending(['fixture-update']);`,
      `await m.updateProject('update',{branch:'changed',network:undefined});`,
      `await m.removeProject('remove',row=>{if(row.chatId!=='fixture-remove')throw Error('guard')});`,
      `const saved=await m.mutateProject('mutate',async row=>{await Promise.resolve();row.enabled=false});if(saved.enabled!==false)throw Error('snapshot');`,
      `await m.resetProjectDirectoryOverride('reset','repositories');`];
    const first = actor(root, 'mixed-0', codes[0]!, { hold: true });
    await first.wait('rename');
    const rest = codes.slice(1).map((code, index) => actor(root, `mixed-${index + 1}`, code, { hold: true }));
    await Promise.all(rest.map(state => state.wait('attempt', 'rename')));
    await releaseAll([first, ...rest]);
    const saved = await disk(root);
    expect(saved.future).toEqual({ keep: true });
    expect(saved.tierMergePending).toEqual(['fixture-update']);
    expect(saved.projects.find((row: { name: string }) => row.name === 'update')).toMatchObject({ branch: 'changed', rowFuture: 'keep', cwd: '/legacy-cwd' });
    expect(saved.projects.find((row: { name: string }) => row.name === 'remove')).toBeUndefined();
    expect(saved.projects.find((row: { name: string }) => row.name === 'mutate').enabled).toBe(false);
    expect(saved.projects.find((row: { name: string }) => row.name === 'reset').directories).toEqual({});
    expect(saved.projects.some((row: { name: string }) => row.name === 'added')).toBe(true);
  });

  it('enforces duplicate name and chat guards under eight competing processes', async () => {
    for (const sameName of [true, false]) {
      const root = await home();
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
        const row = { ...project(sameName ? 'same-name' : `different-${index}`), chatId: sameName ? `chat-${index}` : 'same-chat' };
        return actor(root, `duplicate-${index}`, `await m.addProject(${JSON.stringify(row)});`).done;
      }));
      expect(results.filter(result => result.code === 0)).toHaveLength(1);
      expect((await disk(root)).projects).toHaveLength(1);
    }
  });

  it('captures queued file and inputs before useBotDir switches the global selection', async () => {
    const root = await home();
    const code = `m.useBotDir('a');await m.addProject(${JSON.stringify(project('base'))});
      const held=m.mutateProject('base',async row=>{probe('callback');await new Promise(resolve=>process.once('message',resolve));row.branch='held'});
      const input=${JSON.stringify(project('queued'))};const next=m.addProject(input);input.name='mutated-input';
      const patch={branch:'captured'};const update=m.updateProject('queued',patch);patch.branch='mutated-patch';
      const chats=['fixture-base'];const pending=m.setTierMergePending(chats);chats[0]='mutated-chat';
      m.useBotDir('b');await held;await next;await update;await pending;`;
    const state = actor(root, 'capture', code);
    await state.wait('callback'); state.release(); expect((await state.done).code).toBe(0);
    const saved = JSON.parse(await readFile(join(root, 'bots/a/projects.json'), 'utf8'));
    expect(saved.projects.map((row: { name: string }) => row.name)).toEqual(['base', 'queued']);
    expect(saved.projects[1].branch).toBe('captured');
    expect(saved.tierMergePending).toEqual(['fixture-base']);
    await expect(readFile(join(root, 'bots/b/projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shares ownership through a canonical parent alias', async () => {
    const root = await home();
    const alias = join(scratch, `alias-${basename(root)}`);
    await symlink(scratch, alias);
    const first = actor(root, 'alias-first', add('first'), { hold: true });
    await first.wait('rename');
    const second = actor(join(alias, basename(root)), 'alias-second', add('second'), { hold: true });
    await second.wait('attempt', 'rename'); await releaseAll([first, second]);
    expect((await disk(root)).projects.map((row: { name: string }) => row.name).sort()).toEqual(['first', 'second']);
  });

  it('releases ownership after callback, admission and publication failures and keeps the queue usable', async () => {
    const root = await home();
    await successful(root, add('base') + `
      for(const invoke of [()=>m.mutateProject('base',async()=>{throw Error('callback-failure')}),
        ()=>m.updateProject('base',{directories:{workspaces:{primary:'/missing-test-workspace',additional:[]}}}),
        ()=>m.removeProject('base',()=>{throw Error('guard-failure')})]){
        let failed=false;try{await invoke()}catch{failed=true}if(!failed)throw Error('expected failure');}
      await m.updateProject('base',{branch:'after-failures'});`);
    const failed = await actor(root, 'rename-failure', add('failed'), { renameFailure: true }).done;
    expect(failed.code).toBe(1); expect(failed.stderr).toContain('rename-failure');
    await successful(root, add('after'));
    expect((await disk(root)).projects.map((row: { name: string }) => row.name)).toEqual(['base', 'after']);
    expect((await disk(root)).projects[0].branch).toBe('after-failures');
  });

  it('runs revision guards against the latest row and keeps missing-entry behavior', async () => {
    const root = await home();
    await successful(root, add('guarded') + `
      await m.updateProject('guarded',{branch:'new-revision'});
      let rejected=false;try{await m.removeProject('guarded',row=>{if(row.branch!=='old-revision')throw Error('stale-request')})}catch(error){rejected=error.message==='stale-request'};
      if(!rejected)throw Error('stale guard accepted');
      if(await m.removeProject('absent')!==undefined)throw Error('missing remove');
      await m.updateProject('absent',{enabled:false});await m.resetProjectDirectoryOverride('absent','repositories');
      let missing=false;try{await m.mutateProject('absent',()=>{throw Error('must-not-call')})}catch(error){missing=error.message==='项目不存在'};
      if(!missing)throw Error('missing mutation contract');`);
    expect((await disk(root)).projects[0].branch).toBe('new-revision');
  });

  it('preserves both callback and release failures', async () => {
    const root = await home(); await successful(root, add('base'));
    const result = await actor(root, 'double-failure', `await m.mutateProject('base',()=>{throw Error('business-failure')});`, { failRelease: true }).done;
    expect(result.code).toBe(1); expect(result.stderr).toContain('business-failure'); expect(result.stderr).toContain('release-failure');
    await successful(root, add('after'));
  });

  it('times out without entering the callback and reacquires after SIGKILL', async () => {
    const root = await home(); await successful(root, add('base'));
    const held = actor(root, 'kill-holder', `await m.mutateProject('base',async row=>{probe('callback');await new Promise(()=>setInterval(()=>{},1000));row.branch='never'});`);
    await held.wait('callback');
    const blocked = actor(root, 'timeout', `await m.mutateProject('base',()=>{probe('forbidden-callback')});`, { shortWait: true });
    await blocked.wait('attempt');
    const failed = await blocked.done;
    expect(failed.code).toBe(1); expect(blocked.events.some(event => event.event === 'forbidden-callback')).toBe(false);
    expect((await disk(root)).projects[0].branch).toBeUndefined();
    held.child.kill('SIGKILL'); await held.done;
    await successful(root, `await m.updateProject('base',{branch:'after-kill'})`);
    expect((await disk(root)).projects[0].branch).toBe('after-kill');
  });

});
