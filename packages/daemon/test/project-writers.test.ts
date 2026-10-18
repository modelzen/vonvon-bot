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
  await build({ stdin: { contents: `export * from './src/project/registry';export {useBotDir} from './src/config/paths';`,
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
function actor(root: string, name: string, code: string, options: { hold?: boolean; shortWait?: boolean; failRelease?: boolean; renameFailure?: boolean } = {}) {
  const setup = `const fs=require('node:fs/promises');const probe=(event,file)=>process.send({event,file,actor:process.env.ACTOR,time:performance.now()});
    const read=fs.readFile,write=fs.writeFile,rename=fs.rename;
    fs.readFile=async(p,...args)=>{if(String(p).endsWith('/projects.json'))probe('read-start',String(p));try{const result=await read(p,...args);if(String(p).endsWith('/projects.json'))probe('read-done',String(p));return result}catch(error){if(String(p).endsWith('/projects.json'))probe('read-failed',String(p));throw error}};
    fs.writeFile=async(p,...args)=>{const result=await write(p,...args);if(String(p).includes('projects.json.tmp-'))probe('temp-written',String(p));return result};
    fs.rename=async(a,b)=>{if(String(b).endsWith('/projects.json')){probe('rename',String(b));if(process.env.HOLD_RENAME)await new Promise(resolve=>process.once('message',resolve));if(process.env.FAIL_RENAME)throw Error('rename-failure');}return rename(a,b)};
    const m=require(${JSON.stringify(bundle)});`;
  const child = spawn(process.execPath, ['-e', `${setup}(async()=>{${code};probe('success')})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>process.disconnect?.())`], {
    env: { ...process.env, VONVON_HOME: root, ACTOR: name, ...(options.hold ? { HOLD_RENAME: '1' } : {}),
      ...(options.shortWait ? { SHORT_WAIT: '1' } : {}), ...(options.failRelease ? { FAIL_RELEASE: '1' } : {}), ...(options.renameFailure ? { FAIL_RENAME: '1' } : {}) },
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

describe('project registry process ownership', () => {
  it('prepares and publishes one binding across eight independent processes', async () => {
    const root = await home();
    const cwd = join(root, 'projects', 'bound');
    await mkdir(cwd, { recursive: true });
    const identity = { name: 'bound', chatId: 'oc_bound', cwd, backend: 'codex-appserver', defaultBackend: 'codex-appserver', kind: 'multi', noMention: true };
    const code = `const result=await m.bindProject(${JSON.stringify(identity)},async()=>{probe('prepare');return {blank:false,createdAt:1,origin:'joined',backend:'codex-appserver',directories:{workspaces:{primary:${JSON.stringify(cwd)},additional:[]}}}});console.log(JSON.stringify(result));`;
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
    const identity = { name: 'bound', chatId: 'oc_bound', cwd: '/legacy-cwd', backend: 'codex-appserver', defaultBackend: 'codex-appserver', kind: 'multi', noMention: true };
    const failed = actor(root, 'bind-failed', `await m.bindProject(${JSON.stringify(identity)},async()=>{throw Error('prepare-failed')});`);
    const result = await failed.done;
    expect(result.code).toBe(1); expect(result.stderr).toContain('prepare-failed');
    await expect(readFile(join(root, 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(failed.events.some(event => event.event === 'released')).toBe(true);
    const saved = await successful(root, `console.log(JSON.stringify(await m.bindProject(${JSON.stringify(identity)},async()=>({blank:true,createdAt:1}))));`);
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
