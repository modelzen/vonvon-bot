import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let scratch: string;
let entry: string;
const children = new Set<ChildProcess>();
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'bot-namespace-')));
  entry = join(scratch, 'entry.cjs');
  await build({ stdin: { contents: `export * from './src/config/bots';export * from './src/bot/register-bot';export * from './src/config/store';export * from './src/project/registry';export {useBotDir,botPaths} from './src/config/paths';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@larksuiteoapi/node-sdk'] });
});
afterAll(async () => {
  const live = [...children].filter(child => child.exitCode === null && child.signalCode === null);
  const pending = live.map(child => once(child, 'exit'));
  for (const child of live) child.kill('SIGKILL');
  await Promise.all(pending);
  await rm(scratch, { recursive: true, force: true });
});
async function home(): Promise<string> { return mkdtemp(join(scratch, 'data-')); }
function run(root: string, code: string, setup = '') {
  const child = spawn(process.execPath, ['-e', `${setup};const m=require(${JSON.stringify(entry)});(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
    { env: { ...process.env, VONVON_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { children.delete(child); resolve({ code, stdout, stderr }); });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', () => { if (stdout.includes('BARRIER')) resolve(); });
    child.once('exit', () => { if (!stdout.includes('BARRIER')) reject(new Error(stderr || 'Exited before barrier')); });
  });
  void ready.catch(() => undefined);
  return { child, done, ready };
}
async function successful(root: string, code: string, setup?: string) {
  const result = await run(root, code, setup).done;
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return result.stdout;
}
async function registry(root: string) { return JSON.parse(await readFile(join(root, 'bots.json'), 'utf8')); }
const input = (appId: string, extra = {}) => JSON.stringify({ appId, tenant: 'feishu', desiredName: 'shared', ...extra });
const register = (appId: string, extra = {}, callback = 'async()=>{}') => `await m.registerBotEntry(${input(appId, extra)},${callback});`;
const credentials = (appId: string, preferences = {}) => `const result=await m.registerBotFromCredentials(${JSON.stringify({ appId, appSecret: 'fake-only', tenant: 'feishu', ownerOpenId: 'fixture', initialPreferences: preferences })},async()=>({ok:true,botName:'Shared'}));if(!result.ok)throw Error(result.reason);`;
const pause = `process.stdout.write('BARRIER');await new Promise(()=>setInterval(()=>{},1000));`;
function bind(name = 'Group', chatId = 'oc_group', identity = `m.botIdentity((await m.loadBots()).bots[0])`, parent = `process.env.VONVON_HOME+'/projects'`): string {
  return `(async()=>{const bot=${identity};m.useBotDir(bot.appId);return m.withBotGroupBinding(bot,{name:${JSON.stringify(name)},chatId:${JSON.stringify(chatId)},projectsRootDir:${parent}},async scope=>m.bindProject({name:${JSON.stringify(name)},chatId:${JSON.stringify(chatId)},cwd:{kind:'default',legacyPath:${parent}+'/'+${JSON.stringify(name)},allocatedPath:scope.allocatedPath},backend:'codex-appserver',defaultBackend:'codex-appserver',kind:'multi',noMention:true},async()=>({...await scope.prepareDefault(),createdAt:1,origin:'joined'}),{file:m.botPaths(bot.appId).projectsFile,dataRoot:process.env.VONVON_HOME}))})()`;
}

function intercept(stage: string): string {
  return `const fs=require('node:fs/promises');const oldRename=fs.rename,oldMkdir=fs.mkdir;
    fs.rename=async(a,b)=>{if(b.endsWith('/bots.json')){const doc=JSON.parse(await fs.readFile(a,'utf8'));const state=doc.allocations?.crash?.state;
      if(${JSON.stringify(stage)}==='before-intent'&&state==='reserved'){${pause}}
      await oldRename(a,b);
      if((${JSON.stringify(stage)}==='reserved'&&state==='reserved')||(${JSON.stringify(stage)}==='ready'&&state==='ready')){${pause}}return;
    }return oldRename(a,b)};
    fs.mkdir=async(p,o)=>{const result=await oldMkdir(p,o);if(${JSON.stringify(stage)}==='mkdir'&&p.endsWith('/projects/shared')){${pause}}return result};`;
}

describe('stable bot directory evidence', () => {
  it('admits creation after parent preparation, without reserving a group, and reuses that parent for binding', async () => {
    const root = await home();
    const output = await successful(root, `${register('cli_groups123')}
      const bot=m.botIdentity((await m.loadBots()).bots[0]);
      await m.withBotCreationAdmission(bot,{kind:'default',projectsRootDir:process.env.VONVON_HOME+'/projects'},async()=>{
        const state=await m.loadBots();if(state.groupContainers[bot.appId].state!=='ready'||state.groupAllocations)throw Error('wrong preflight');
        console.log(state.groupContainers[bot.appId].namespaceRoot);
      });
      const first=(await m.loadBots()).groupContainers[bot.appId];const bound=await ${bind()};
      if(!bound.project.cwd.startsWith(first.namespaceRoot+'/'))throw Error('second allocation authority');
      await require('node:fs/promises').writeFile(bound.project.cwd+'/sentinel','keep');
      await m.withBotCreationAdmission(bot,{kind:'default',projectsRootDir:process.env.VONVON_HOME+'/changed-root'},async()=>{});
      if(await require('node:fs/promises').readFile(bound.project.cwd+'/sentinel','utf8')!=='keep')throw Error('lost content');`);
    expect(output.trim()).toBe(join(root, 'projects/shared/groups'));
    const state = await registry(root);
    expect(Object.keys(state.groupAllocations)).toHaveLength(1); expect(state.groupContainers.cli_groups123.namespaceRoot).toBe(output.trim());
  });

  it('identity-only admission leaves absent parents alone and refuses stale registration before callbacks', async () => {
    const root = await home();
    await successful(root, `${register('cli_groups123')}
      const bot=m.botIdentity((await m.loadBots()).bots[0]);const fs=require('node:fs/promises');
      const bytes=await fs.readFile(process.env.VONVON_HOME+'/bots.json','utf8');
      await fs.rm(process.env.VONVON_HOME+'/projects',{recursive:true,force:true});
      if(await m.withBotCreationAdmission(bot,{kind:'identity'},async()=>7)!==7)throw Error('callback result');
      if(await fs.readFile(process.env.VONVON_HOME+'/bots.json','utf8')!==bytes)throw Error('identity rewrote registry');
      if(require('node:fs').existsSync(process.env.VONVON_HOME+'/projects'))throw Error('identity recreated directory');
      for(const stale of [{...bot,registrationId:'another-incarnation'},{...bot,tenant:'lark'},{...bot,createdAt:bot.createdAt+1}]){
        let rejected=false;try{await m.withBotCreationAdmission(stale,{kind:'identity'},async()=>{throw Error('must-not-call')})}catch(e){rejected=e.message.includes('重新注册')}
        if(!rejected)throw Error('stale admission');
      }`);
  });

  it('refuses a replaced ready parent before local work and releases ownership after callback failure', async () => {
    const root = await home();
    await successful(root, `${register('cli_groups123')}
      const bot=m.botIdentity((await m.loadBots()).bots[0]),workspace={kind:'default',projectsRootDir:process.env.VONVON_HOME+'/projects'};
      const failure=Error('local failure');try{await m.withBotCreationAdmission(bot,workspace,async()=>{throw failure})}catch(error){if(error!==failure)throw error}
      await m.withBotCreationAdmission(bot,{kind:'identity'},async()=>{});
      const state=await m.loadBots(),path=state.groupContainers[bot.appId].namespaceRoot,fs=require('node:fs/promises');
      await fs.rename(path,path+'-saved');await fs.mkdir(path);
      let called=false,rejected=false;try{await m.withBotCreationAdmission(bot,workspace,async()=>{called=true})}catch{rejected=true}
      if(called||!rejected)throw Error('replacement admitted');
      await m.withBotCreationAdmission(bot,{kind:'identity'},async()=>{});`);
  });

  it('retains group content through rename, root change, unbind and account re-registration, fencing the old identity', async () => {
    const root = await home();
    const output = await successful(root, `${register('cli_groups123')}
      const old=m.botIdentity((await m.loadBots()).bots[0]);const first=await ${bind()};
      await require('node:fs/promises').writeFile(first.project.cwd+'/sentinel','keep');
      await m.removeProject('Group');const renamed=await ${bind('Renamed', 'oc_group', 'old', `process.env.VONVON_HOME+'/elsewhere'`)};
      if(renamed.project.cwd!==first.project.cwd)throw Error('renamed directory');
      await m.setBotActivation(old.appId,false);await m.removeBot(old,{isRunning:async()=>false,cleanup:async()=>require('node:fs/promises').rm(m.botPaths(old.appId).dir??require('node:path').dirname(m.botPaths(old.appId).projectsFile),{recursive:true,force:true})});
      try{await ${bind('Stale', 'oc_stale', 'old')};throw Error('accepted stale')}catch(error){if(!error.message.includes('重新注册'))throw error}
      if(require('node:fs').existsSync(m.botPaths(old.appId).projectsFile))throw Error('stale recreated state');
      ${register('cli_groups123')}
      const next=await ${bind('Restored')};
      if(next.project.cwd!==first.project.cwd)throw Error('new namespace');
      if(await require('node:fs/promises').readFile(next.project.cwd+'/sentinel','utf8')!=='keep')throw Error('lost content');
      console.log(JSON.stringify(next.project));`);
    const saved = JSON.parse(output);
    expect(saved.cwd).toBe(join(root, 'projects/shared/groups/Group'));
    expect(saved.directories.workspaces).toEqual({ primary: saved.cwd, additional: [] });
    expect(saved.directories).not.toHaveProperty('repositories');
    const state = await registry(root);
    expect(Object.keys(state.groupAllocations)).toHaveLength(1);
    expect(Object.values(state.groupAllocations)[0]).toMatchObject({ initialName: 'Group', chatId: 'oc_group', state: 'ready' });
  });

  it('does not allocate or rewrite a legacy default binding on an identical retry or conflict', async () => {
    const root = await home();
    const bot = { name: 'legacy', appId: 'cli_legacy123', tenant: 'feishu', createdAt: 1 };
    const bytes = JSON.stringify({ version: 1, bots: [bot], future: true });
    await writeFile(join(root, 'bots.json'), bytes);
    await successful(root, `m.useBotDir('cli_legacy123');await m.addProject({name:'Group',chatId:'oc_group',cwd:process.env.VONVON_HOME+'/projects/Group',blank:true,createdAt:1});`);
    const file = join(root, 'bots/cli_legacy123/projects.json');
    const projects = await readFile(file, 'utf8');
    await successful(root, `const result=await ${bind()};if(result.kind!=='existing')throw Error('not existing');try{await ${bind('Other')};throw Error('accepted conflict')}catch(error){if(!error.message.includes('不可修改'))throw error}`);
    expect(await readFile(join(root, 'bots.json'), 'utf8')).toBe(bytes);
    expect(await readFile(file, 'utf8')).toBe(projects);
    await expect(readdir(join(root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
    await successful(root, `const result=await ${bind('Fresh','oc_fresh')};if(!result.project.cwd.endsWith('/legacy/groups/Fresh'))throw Error('wrong old bot namespace');`);
    expect((await registry(root)).bots[0]).toEqual(bot);
  });

  it('separates case-folding collisions and refuses replaced ancestors', async () => {
    const root = await home();
    await successful(root, `${register('cli_groups123')}const a=await ${bind()};const b=await ${bind('group','oc_other')};if(a.project.cwd===b.project.cwd)throw Error('collision');`);
    const state = await registry(root);
    const parent = state.allocations.cli_groups123.namespaceRoot;
    await rename(parent, `${parent}-old`);
    await mkdir(parent);
    const failed = await run(root, `await ${bind('New','oc_new')}`).done;
    expect(failed.code).toBe(1); expect(failed.stderr).toContain('Namespace directory changed');
  });

  it.each(['empty', 'content', 'symlink'])('refuses an unclaimed %s groups container', async occupied => {
      const data = await home();
      await successful(data, register('cli_groups123'));
      const target = join(data, 'projects/shared/groups');
      if (occupied === 'symlink') await symlink(scratch, target);
      else { await mkdir(target); if (occupied === 'content') await writeFile(join(target, 'keep'), 'keep'); }
      const result = await run(data, `await ${bind()}`).done;
      expect(result.code).toBe(1); expect(result.stderr).toContain('Namespace collision limit');
      expect((await registry(data)).groupContainers).toBeUndefined();
  });

  it.each(['account', 'parent', 'object', 'duplicate', 'limit'])('rejects a malformed group ledger: %s', async fault => {
    const root = await home();
    await successful(root, `${register('cli_groups123')}await ${bind()};`);
    const state = await registry(root);
    const container = state.groupContainers.cli_groups123;
    const key = Object.keys(state.groupAllocations)[0];
    if (key === undefined) throw new Error('Missing fixture group claim');
    const claim = state.groupAllocations[key];
    if (fault === 'account') container.tenant = 'lark';
    if (fault === 'parent') claim.parent = scratch;
    if (fault === 'object') claim.parentIdentity = { dev: '0', ino: '0' };
    if (fault === 'duplicate') state.groupAllocations[JSON.stringify(['cli_groups123', 'feishu', 'oc_duplicate'])] = { ...claim, chatId: 'oc_duplicate', namespaceRoot: join(claim.parent, 'gRoUp') };
    if (fault === 'limit') state.groupAllocations = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`${key}-${i}`, claim]));
    const bytes = JSON.stringify(state);
    await writeFile(join(root, 'bots.json'), bytes);
    const result = await run(root, 'await m.loadBots()').done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(fault === 'limit' ? 'Group allocation limit' : 'Invalid group');
    expect(await readFile(join(root, 'bots.json'), 'utf8')).toBe(bytes);
  });

  it.each(['container-intent', 'group-mkdir', 'group-ready'])('retains %s evidence across an actual killed binding', async stage => {
    const root = await home();
    await successful(root, register('cli_groups123'));
    const setup = `const fs=require('node:fs/promises'),rename=fs.rename,mkdir=fs.mkdir;let paused=false;
      fs.rename=async(a,b)=>{await rename(a,b);if(!paused&&b.endsWith('/bots.json')){const doc=JSON.parse(await fs.readFile(b,'utf8'));if((${JSON.stringify(stage)}==='container-intent'&&doc.groupContainers?.cli_groups123?.state==='reserved')||(${JSON.stringify(stage)}==='group-ready'&&Object.values(doc.groupAllocations??{}).some(c=>c.state==='ready'))){paused=true;${pause}}}};
      fs.mkdir=async(p,o)=>{const result=await mkdir(p,o);if(${JSON.stringify(stage)}==='group-mkdir'&&p.endsWith('/groups/Group')){${pause}}return result};`;
    const child = run(root, `await ${bind()}`, setup);
    await child.ready; child.child.kill('SIGKILL'); await child.done;
    const result = await run(root, `console.log(JSON.stringify(await ${bind()}))`).done;
    if (stage === 'group-mkdir') {
      expect(result.code).toBe(1); expect(result.stderr).toContain('Reserved namespace already exists');
      expect(Object.values((await registry(root)).groupAllocations)[0]).toMatchObject({ state: 'reserved' });
    } else {
      expect(result.code).toBe(0); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).project.cwd).toBe(join(root, 'projects/shared/groups/Group'));
    }
  });

  it('serializes competing root-to-project binders and an ordinary project writer', async () => {
    const root = await home();
    await successful(root, register('cli_groups123'));
    const setup = `const fs=require('node:fs/promises'),rename=fs.rename;let paused=false;fs.rename=async(a,b)=>{await rename(a,b);if(!paused&&b.endsWith('/bots.json')){const doc=JSON.parse(await fs.readFile(b,'utf8'));if(Object.values(doc.groupAllocations??{}).some(c=>c.state==='ready')){paused=true;process.stdout.write('BARRIER');await new Promise(r=>process.stdin.once('data',r));process.stdin.destroy()}}};`;
    const first = run(root, `console.log(JSON.stringify(await ${bind()}))`, setup);
    await first.ready;
    const next = run(root, `console.log('BARRIER');console.log(JSON.stringify(await ${bind()}))`);
    const writer = run(root, `m.useBotDir('cli_groups123');process.stdout.write('BARRIER');await m.addProject({name:'unrelated',chatId:'oc_unrelated',cwd:'/legacy',blank:false,createdAt:1})`);
    await Promise.all([next.ready, writer.ready]); first.child.stdin?.end('continue');
    const [a,b,c] = await Promise.all([first.done,next.done,writer.done]);
    expect([a.code,b.code,c.code]).toEqual([0,0,0]);
    expect(JSON.parse(a.stdout.replace('BARRIER','')).kind).toBe('bound');
    expect(JSON.parse(b.stdout.replace('BARRIER\n','')).kind).toBe('existing');
    const projects = JSON.parse(await readFile(join(root, 'bots/cli_groups123/projects.json'), 'utf8')).projects;
    expect(projects.map((p: { name: string }) => p.name).sort()).toEqual(['Group','unrelated']);
  });
  it('creates a default empty workspace through shared credential registration', async () => {
    const root = await home();
    await successful(root, credentials('cli_default123'));
    const saved = await registry(root);
    const allocation = saved.allocations.cli_default123;
    const config = JSON.parse(await readFile(join(root, 'bots/cli_default123/config.json'), 'utf8'));
    expect(allocation.state).toBe('ready');
    expect(config.preferences.directories.workspaces).toEqual({ primary: allocation.namespaceRoot, additional: [] });
    expect(config.preferences.directories).not.toHaveProperty('repositories');
    expect(await readdir(allocation.namespaceRoot)).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('fake-only');
  });

  it('preserves explicit workspaces, repositories and unknown complete preferences', async () => {
    const root = await home();
    const workspace = await realpath(await mkdtemp(join(scratch, 'explicit-')));
    await mkdir(join(root, 'bots/cli_explicit123'), { recursive: true });
    const preferences = { projectsRootDir: join(scratch, 'custom-parent'), directories: { workspaces: { primary: workspace, additional: [] }, repositories: [] }, future: { keep: true } };
    await writeFile(join(root, 'bots/cli_explicit123/config.json'), JSON.stringify({ accounts: { app: { id: 'cli_explicit123', secret: 'fixture', tenant: 'feishu' } }, preferences }));
    await successful(root, credentials('cli_explicit123', { projectsRootDir: '/ignored' }));
    const config = JSON.parse(await readFile(join(root, 'bots/cli_explicit123/config.json'), 'utf8'));
    expect(config.preferences.directories).toEqual(preferences.directories);
    expect(config.preferences.future).toEqual({ keep: true });
    expect((await registry(root)).allocations.cli_explicit123.parent).toBe(preferences.projectsRootDir);
  });

  it('keeps pending handles through account failure, activation and deletion, then reuses the proven namespace', async () => {
    const root = await home();
    expect((await run(root, register('pending', {}, `async()=>{throw Error('account-failure')}`)).done).code).toBe(1);
    let saved = await registry(root);
    const allocation = saved.allocations.pending;
    await successful(root, register('other'));
    saved = await registry(root);
    expect(saved.bots[0].name).toBe('shared-2');
    await successful(root, register('pending') + `await m.setBotActivation('pending',false);const row=(await m.loadBots()).bots.find(b=>b.appId==='pending');await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}});`);
    expect((await registry(root)).allocations.pending).toEqual(allocation);
    await writeFile(join(allocation.namespaceRoot, 'keep'), 'contents');
    await successful(root, register('pending', { desiredName: 'renamed', initialPreferences: { projectsRootDir: '/ignored-new-parent' } }));
    saved = await registry(root);
    expect(saved.allocations.pending).toEqual(allocation);
    expect(saved.bots.find((bot: { appId: string }) => bot.appId === 'pending').name).toBe('shared');
    expect(await readFile(join(allocation.namespaceRoot, 'keep'), 'utf8')).toBe('contents');
  });

  it('re-registers after account-state cleanup with a new incarnation and the same workspace', async () => {
    const root = await home();
    await successful(root, credentials('cli_repeat123'));
    const before = await registry(root);
    const allocation = before.allocations.cli_repeat123;
    await writeFile(join(allocation.namespaceRoot, 'keep'), 'survives');
    await successful(root, `await m.setBotActivation('cli_repeat123',false);const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{await require('node:fs/promises').rm(${JSON.stringify(root)}+'/bots/cli_repeat123',{recursive:true})}});`);
    await successful(root, credentials('cli_repeat123', { projectsRootDir: '/unused-new-root' }));
    const after = await registry(root);
    const config = JSON.parse(await readFile(join(root, 'bots/cli_repeat123/config.json'), 'utf8'));
    expect(after.bots[0].registrationId).not.toBe(before.bots[0].registrationId);
    expect(after.allocations.cli_repeat123).toEqual(allocation);
    expect(config.preferences.directories.workspaces.primary).toBe(allocation.namespaceRoot);
    expect(await readFile(join(allocation.namespaceRoot, 'keep'), 'utf8')).toBe('survives');
  });

  it('avoids existing case and Unicode names without touching their contents', async () => {
    const root = await home();
    await mkdir(join(root, 'projects/SHARED'), { recursive: true });
    await writeFile(join(root, 'projects/SHARED/keep'), 'old');
    await successful(root, register('first') + register('second'));
    const saved = await registry(root);
    expect(saved.allocations.first.namespaceRoot).not.toBe(join(root, 'projects/shared'));
    expect(saved.allocations.first.namespaceRoot).not.toBe(saved.allocations.second.namespaceRoot);
    expect(await readFile(join(root, 'projects/SHARED/keep'), 'utf8')).toBe('old');
  });

  it('rejects protected and dangling aliases before creating a candidate', async () => {
    for (const dangling of [false, true]) {
      const root = await home();
      await mkdir(join(root, 'bots'));
      await symlink(join(root, dangling ? 'missing' : 'bots'), join(root, 'projects'));
      const result = await run(root, register('unsafe')).done;
      expect(result.code).toBe(1);
      expect(await readdir(join(root, 'bots'))).toEqual([]);
      await expect(readFile(join(root, 'bots.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refuses ready target and parent replacement while the old inode still exists', async () => {
    for (const parent of [false, true]) {
      const root = await home();
      await run(root, register('replace', {}, `async()=>{throw Error('account-failure')}`)).done;
      const allocation = (await registry(root)).allocations.replace;
      const selected = parent ? allocation.parent : allocation.namespaceRoot;
      await rename(selected, `${selected}-old`);
      await mkdir(selected);
      const result = await run(root, register('replace')).done;
      expect(result.code).toBe(1);
      expect(await readdir(selected)).toEqual([]);
      expect((await registry(root)).bots).toEqual([]);
    }
  });

  it('refuses tenant changes, unsafe IDs and malformed/symlink/oversized evidence', async () => {
    const root = await home();
    await run(root, register('pending', {}, `async()=>{throw Error('account-failure')}`)).done;
    expect((await run(root, register('pending', { tenant: 'lark' })).done).code).toBe(1);
    expect((await run(root, register('../escape')).done).code).toBe(1);
    const saved = await registry(root);
    saved.allocations.pending.unexpected = true;
    await writeFile(join(root, 'bots.json'), JSON.stringify(saved));
    expect((await run(root, `await m.loadBots()`).done).code).toBe(1);
    await writeFile(join(root, 'bots.json'), ' '.repeat(4 * 1024 * 1024 + 1));
    expect((await run(root, `await m.loadBots()`).done).code).toBe(1);
    await rename(join(root, 'bots.json'), join(root, 'other.json'));
    await symlink(join(root, 'other.json'), join(root, 'bots.json'));
    expect((await run(root, `await m.loadBots()`).done).code).toBe(1);
  });

  for (const stage of ['before-intent', 'reserved', 'mkdir', 'ready', 'account']) {
    it(`replays a SIGKILL at ${stage} conservatively in a fresh process`, async () => {
      const root = await home();
      const held = run(root, register('crash', {}, stage === 'account' ? `async ctx=>{await m.saveConfig({accounts:{app:{id:'crash',secret:'fixture',tenant:'feishu'}}},${JSON.stringify(root)}+'/bots/crash/config.json',ctx.snapshot);${pause}}` : 'async()=>{}'), intercept(stage));
      await held.ready;
      const exited = once(held.child, 'exit');
      held.child.kill('SIGKILL');
      await exited;
      const result = await run(root, register('crash')).done;
      expect(result.code).toBe(stage === 'mkdir' ? 1 : 0);
      if (stage === 'mkdir') {
        const saved = await registry(root);
        expect(saved.allocations.crash.state).toBe('reserved');
        expect(saved.bots).toEqual([]);
        expect(await readdir(saved.allocations.crash.namespaceRoot)).toEqual([]);
      } else expect((await registry(root)).bots).toHaveLength(1);
    });
  }

  for (const operation of ['file-sync', 'directory-sync', 'rename']) {
    it(`reports ${operation} failure and permits conservative fresh-process recovery`, async () => {
      const root = await home();
      const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open,oldRename=fs.rename;
        fs.open=async(...args)=>{const file=await oldOpen(...args);if(${JSON.stringify(operation)}==='file-sync'&&String(args[0]).includes('/bots.json.tmp-'))file.sync=async()=>{throw Error('injected-file-sync')};
        if(${JSON.stringify(operation)}==='directory-sync'&&String(args[0]).endsWith('/projects/shared'))file.sync=async()=>{throw Error('injected-directory-sync')};return file};
        fs.rename=async(a,b)=>{if(${JSON.stringify(operation)}==='rename'&&b.endsWith('/bots.json'))throw Error('injected-rename');return oldRename(a,b)};`;
      const failed = await run(root, register('failure'), setup).done;
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain('injected-');
      const retry = await run(root, register('failure')).done;
      expect(retry.code).toBe(operation === 'directory-sync' ? 1 : 0);
      if (operation === 'directory-sync') expect((await registry(root)).allocations.failure.state).toBe('reserved');
    });
  }

  it('does not allocate on legacy reads, refresh, activation or duplicate registration', async () => {
    const root = await home();
    const legacy = { appId: 'legacy', tenant: 'feishu', name: 'legacy', createdAt: 1 };
    await writeFile(join(root, 'bots.json'), JSON.stringify({ version: 1, bots: [legacy], current: 'legacy' }));
    await successful(root, `const reg=await m.ensureRegistry();await m.commitBotCredentialRefresh(m.botIdentity(reg.bots[0]),async()=>{});await m.setBotActivation('legacy',true);${register('legacy')}`);
    expect((await registry(root)).allocations).toBeUndefined();
    await expect(readdir(join(root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses missing ready directories and malformed allocation deletion before cleanup', async () => {
    const root = await home();
    await successful(root, register('saved') + `await m.setBotActivation('saved',false)`);
    const before = await registry(root);
    const originalId = before.bots[0].registrationId;
    const allocation = before.allocations.saved;
    allocation.tenant = 'lark';
    await writeFile(join(root, 'bots.json'), JSON.stringify(before));
    const refused = await run(root, `const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{throw Error('cleanup-must-not-run')}})`).done;
    expect(refused.stderr).toContain('Bot allocation account conflict');
    expect(refused.stderr).not.toContain('cleanup-must-not-run');
    allocation.tenant = 'feishu';
    await writeFile(join(root, 'bots.json'), JSON.stringify(before));
    await successful(root, `const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}})`);
    await successful(root, register('saved'));
    expect((await registry(root)).bots[0].registrationId).not.toBe(originalId);
    await successful(root, `await m.setBotActivation('saved',false);const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}})`);
    await rm(allocation.namespaceRoot, { recursive: true });
    expect((await run(root, register('saved')).done).code).toBe(1);
    await expect(readdir(allocation.namespaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects dangling registry links and hard-linked evidence', async () => {
    const root = await home();
    await symlink(join(root, 'absent'), join(root, 'bots.json'));
    expect((await run(root, register('link')).done).code).toBe(1);
    await rm(join(root, 'bots.json'));
    await writeFile(join(root, 'evidence'), JSON.stringify({ version: 1, bots: [] }));
    const { link } = await import('node:fs/promises');
    await link(join(root, 'evidence'), join(root, 'bots.json'));
    expect((await run(root, register('link')).done).code).toBe(1);
  });

  it('reports a final registry sync failure even when the registered row is visible', async () => {
    const root = await home();
    const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open;fs.open=async(...args)=>{
      const file=await oldOpen(...args);if(String(args[0])===process.env.VONVON_HOME){const sync=file.sync.bind(file);file.sync=async()=>{
        let doc;try{doc=JSON.parse(await fs.readFile(process.env.VONVON_HOME+'/bots.json','utf8'))}catch{};
        if(doc?.bots?.length)throw Error('final-sync-failure');return sync();};}return file;};`;
    const failed = await run(root, register('visible'), setup).done;
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('final-sync-failure');
    expect((await registry(root)).bots).toHaveLength(1);
    await successful(root, `const result=await m.registerBotEntry(${input('visible')},async()=>{throw Error('must-not-write-account')});if(result.kind!=='already-registered')throw Error('not duplicate');`);
  });

  it('keeps the primary file-sync error when cleanup and close also fail', async () => {
    const root = await home();
    const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open,oldUnlink=fs.unlink;fs.open=async(...args)=>{
      const file=await oldOpen(...args);if(String(args[0]).includes('/bots.json.tmp-')){const close=file.close.bind(file);file.sync=async()=>{throw Error('primary-sync-failure')};file.close=async()=>{await close();throw Error('secondary-close-failure')};}return file;};
      fs.unlink=async p=>{if(String(p).includes('/bots.json.tmp-'))throw Error('secondary-cleanup-failure');return oldUnlink(p)};`;
    const result = await run(root, register('errors'), setup).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('primary-sync-failure');
    expect(result.stderr).not.toContain('secondary-close-failure');
    expect(result.stderr).not.toContain('secondary-cleanup-failure');
    await successful(root, register('errors'));
  });

  it('does not create suffixes under a file parent or reuse Unicode-folded entries', async () => {
    const root = await home();
    const parent = join(scratch, `parent-file-${Date.now()}`);
    await writeFile(parent, 'unchanged');
    expect((await run(root, register('file', { initialPreferences: { projectsRootDir: join(parent, 'child') } })).done).code).toBe(1);
    expect(await readFile(parent, 'utf8')).toBe('unchanged');
    await mkdir(join(root, 'projects/ＳＨＡＲＥＤ'), { recursive: true });
    await successful(root, register('unicode'));
    expect((await registry(root)).allocations.unicode.namespaceRoot).not.toBe(join(root, 'projects/shared'));
    expect(await readdir(join(root, 'projects/ＳＨＡＲＥＤ'))).toEqual([]);
  });

  it('resynchronizes parent chains left visible by an earlier failed attempt', async () => {
    const root = await home();
    const parent = join(root, 'projects/nested/final');
    const failedNode = join(root, 'projects/nested');
    const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open;fs.open=async(...args)=>{
      const file=await oldOpen(...args);if(String(args[0])===${JSON.stringify(failedNode)})file.sync=async()=>{throw Error('ancestor-sync-failure')};return file;};`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run(root, register('ancestor', { initialPreferences: { projectsRootDir: parent } }), setup).done;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ancestor-sync-failure');
      expect(await readdir(failedNode)).toEqual([]);
      await expect(readFile(join(root, 'bots.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await successful(root, register('ancestor', { initialPreferences: { projectsRootDir: parent } }));
    expect((await registry(root)).allocations.ancestor.parent).toBe(parent);
  });

  it('captures caller input before queueing and detaches callback preferences from evidence', async () => {
    const root = await home();
    await successful(root, `const input=${input('detached', { initialPreferences: { projectsRootDir: join(root, 'projects/chosen') } })};
      const promise=m.registerBotEntry(input,async ctx=>{ctx.snapshot.preferences={future:'callback'};ctx.preferences.projectsRootDir='/mutated-in-callback';});
      input.initialPreferences.projectsRootDir='/mutated-before-owner';await promise;`);
    expect((await registry(root)).allocations.detached.parent).toBe(join(root, 'projects/chosen'));
  });

  it('passes one detached config snapshot and refuses a concurrent edit at account save', async () => {
    const root = await home();
    const refused = await run(root, register('snapshot', {}, `async ctx=>{
      const fs=require('node:fs/promises'),p=${JSON.stringify(root)}+'/bots/snapshot/config.json';
      await fs.mkdir(require('node:path').dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify({preferences:{future:'concurrent'}}));
      await m.saveConfig({accounts:{app:{id:'snapshot',secret:'fixture',tenant:'feishu'}}},p,ctx.snapshot);
    }`)).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('配置已被其他进程修改');
    expect((await registry(root)).bots).toEqual([]);
    expect((await registry(root)).allocations.snapshot.state).toBe('ready');
    expect(JSON.parse(await readFile(join(root, 'bots/snapshot/config.json'), 'utf8')).preferences.future).toBe('concurrent');
  });

  it('snapshots expected config at save entry despite caller mutation', async () => {
    const root = await home();
    await successful(root, `const fs=require('node:fs/promises');const p=${JSON.stringify(root)}+'/config.json';await fs.writeFile(p,'{}');
      const expected={};const promise=m.saveConfig({accounts:{app:{id:'save',secret:'fixture',tenant:'feishu'}}},p,expected);expected.preferences={future:'mutation'};await promise;`);
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).accounts.app.id).toBe('save');
  });
});
