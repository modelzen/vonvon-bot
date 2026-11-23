import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fixtureNode } from './fixture-node';
import { agentIdSchema, groupIdSchema, requestSchema, responseSchema } from '@vonvon/protocol';
import { fakeService, socketClient, startFixture } from './server-fixture';

const processTestTimeout = process.platform === 'win32' ? 90_000 : undefined;
const requestTimeout = process.platform === 'win32' ? 20_000 : 3_000;

async function writeTool(directory: string, name: string, script: string) {
  const executable = join(directory, process.platform === 'win32' ? `${name}.cmd` : name);
  const source = process.platform === 'win32' ? join(directory, `${name}.cjs`) : executable;
  await writeFile(source, script, { mode: 0o700 });
  if (process.platform === 'win32') await writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
  return executable;
}

const operationId = '00000000-0000-4000-8000-000000000001';

it('serves browser daemon branches and keeps local URL and shell actions unsupported', async () => {
  const fixture = await startFixture();
  try {
    const client = await socketClient(fixture.api.port, fixture.credential, undefined, requestTimeout);
    await client.ready();
    const daemon = [
      ['command', { type: 'refresh' }],
      ['machine', { type: 'status' }],
      ['machine', { type: 'logs' }],
      ['environment', { type: 'toolInstallStatus' }],
      ['environment', { type: 'loginStatus' }],
      ['environment', { type: 'profileInitStatus' }],
      ['environment', { type: 'cancelInstall', operationId }],
      ['environment', { type: 'cancelLogin', operationId }],
      ['environment', { type: 'profileInitCancel', operationId }],
    ] as const;
    for (const [method, payload] of daemon) {
      const frame = await client.call(requestSchema.parse({ type: 'request', id: `daemon-${method}-${payload.type}`, method, payload }));
      expect(frame.type, `${method}.${payload.type}`).toBe('response');
      expect(responseSchema.safeParse(frame).success, `${method}.${payload.type}`).toBe(true);
      if (method === 'command') expect(frame).toMatchObject({ payload: { kind: 'applied' } });
      if (method === 'machine' && payload.type === 'status') expect(frame).toMatchObject({ payload: { type: 'status', host: { ownership: 'owned', pid: process.pid }, cli: { kind: 'ready' } } });
      if (method === 'machine' && payload.type === 'logs') expect(frame).toMatchObject({ payload: { type: 'logs', text: 'log\n' } });
    }
    const startHost = await client.call(requestSchema.parse({ type: 'request', id: 'machine-startHost', method: 'machine', payload: { type: 'startHost' } }));
    expect(startHost).toMatchObject({ type: 'error', code: 'unsupported' });
    const service = await client.call(requestSchema.parse({ type: 'request', id: 'machine-service', method: 'machine', payload: { type: 'service', action: 'install' } }));
    expect(service).toMatchObject({ type: 'error', code: 'unsupported' });
    await client.close();
  } finally { await fixture.close(); }
});

it('holds the real API drain until a login child exits after stop intent', async ({ signal, onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-browser-drain-'));
  const release = join(dir, 'release');
  const started = join(dir, 'started');
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  let starting: ReturnType<typeof startFixture> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    await writeFile(release, 'go');
    await (fixture ?? await starting?.catch(() => undefined))?.close();
    await rm(dir, { recursive: true, force: true });
  })();
  // A timed-out test's body is not awaited; the hook must await the same cleanup.
  onTestFinished(cleanup);
  try {
    const nodePath = await fixtureNode(dir);
    await writeTool(dir, 'lark-cli', `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0)}},20);\n`);
    signal.throwIfAborted();
    fixture = await (starting = startFixture(fakeService(), { home: dir, getDataRoot: () => dir, resolveCodex: () => null, nodePath, path: dir, fetchLatest: async () => null }));
    signal.throwIfAborted();
    const client = await socketClient(fixture.api.port, fixture.credential, undefined, requestTimeout);
    await client.ready();
    const login = await client.call(requestSchema.parse({ type: 'request', id: 'login', method: 'environment', payload: { type: 'startLogin', tool: 'lark-cli' } }));
    expect(login).toMatchObject({ type: 'response', payload: { kind: 'operation', operation: { kind: 'running' } } });
    // Wait for the real child to start; this tests drain ordering, not OS startup speed.
    // The test deadline aborts both the read and timer, then finally releases the child.
    for (;;) {
      signal.throwIfAborted();
      const ready = await readFile(started, { encoding: 'utf8', signal }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (ready === 'started') break;
      await wait(20, undefined, { signal });
    }
    const stop = await client.call(requestSchema.parse({ type: 'request', id: 'stop', method: 'machine', payload: { type: 'stopHost' } }));
    expect(stop).toMatchObject({ type: 'response', payload: { type: 'done' } });
    let drained = false;
    const draining = fixture.api.beginDrain().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(drained).toBe(false);
    await writeFile(release, 'go');
    await draining;
    expect(drained).toBe(true);
    await client.close();
  } finally { await cleanup(); }
}, processTestTimeout);

it('sends one valid WebSocket request for every browser protocol union variant', async () => {
  const schemas = await import('@vonvon/protocol');
  const environmentHome = await mkdtemp(join(tmpdir(), 'vonvon-union-environment-'));
  const nodePath = await fixtureNode(environmentHome);
  await writeTool(environmentHome, 'lark-cli', `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('lark-cli 1.2.3');process.exit(0)}
if(args[0]==='auth'&&args[1]==='status'){process.stdout.write(JSON.stringify({defaultAs:'user',identities:{user:{available:false},bot:{available:false}}}));process.exit(0)}
if(args[0]==='auth'&&args[1]==='login'){process.stdout.write('https://accounts.feishu.cn/login');process.exit(0)}
if(args[0]==='profile'&&args[1]==='list'){process.stdout.write('[]');process.exit(0)}
if(args[0]==='profile'&&args[1]==='add'){process.stdin.resume();process.stdin.on('end',()=>process.exit(0))}
else process.exit(0);
`);
  await writeTool(environmentHome, 'claude', '#!/usr/bin/env node\nprocess.stdout.write("claude 1.2.3");\n');
  const npm = await writeTool(environmentHome, 'npm', '#!/usr/bin/env node\nprocess.exit(1);\n');
  const environmentOptions = { home: environmentHome, getDataRoot: () => environmentHome, resolveCodex: () => null, nodePath, npmPath: npm, path: environmentHome, fetchLatest: async () => null };
  const agentId = 'cli_fixture';
  const groupId = 'oc_fixture';
  const projectName = 'fixture';
  const project = { name: projectName, chatId: groupId, cwd: '/fixture', kind: 'multi' as const, backend: 'codex-appserver', enabled: true, revision: 'token' };
  const bot = { appId: agentId, name: 'fixture', tenant: 'feishu' as const, active: true, current: true, running: true, completionReminder: { mode: 'always' as const, longTaskMinutes: 7 } };
  const host = { scope: { kind: 'host' as const }, sections: { execution: { stored: { codexBin: null }, effective: { codexBin: null }, revision: 'token', access: { kind: 'writable' as const }, apply: [] } }, runtime: { codexBin: null, fallbackCwd: '/fixture', platform: 'darwin' } };
  const stopSubagent = vi.fn(async (_agent: string, _request: unknown) => ({ ok: true }));
  const members = [{ openId: 'ou_fixture_member', name: 'Fixture member' }];
  const groupMembers = vi.fn(async (_agent: string, _group: string, _cursor?: string) => ({ members, nextCursor: 'members-next' }));
  const service = fakeService({
    listBots: async () => [bot],
    feishuRead: async () => ({ ok: true, result: { title: 'fixture' } }),
    listProjects: async () => [{ name: projectName, chatId: groupId, cwd: '/fixture', blank: false, kind: 'multi', origin: 'joined', noMention: false, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 }],
    pendingGroups: async () => ({ groups: [] }),
    joinedGroups: async () => ({ groups: [] }),
    readGroupIdentity: async (agentId, groupId) => ({kind: 'groupIdentity', agentId: agentIdSchema.parse(agentId), groupId: groupIdSchema.parse(groupId), name: '飞书物理群名'}),
    groupMembers,
    bindGroup: async () => ({ name: projectName, chatId: groupId, cwd: '/fixture', blank: false, kind: 'multi', origin: 'joined', noMention: false, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 }),
    collaboration: async (_agent, request) => {
      if (request.action === 'project') return { project };
      if (request.action === 'history') return { sessions: [], threads: [], backend: 'codex-appserver' };
      if (request.action === 'context') return { threadId: request.threadId, usage: null, run: null };
      if (request.action === 'stopSubagent') return stopSubagent(_agent, request);
      if (request.action === 'shareUsage') return { messageId: 'om_fixture' };
      if (request.action === 'createProject' || request.action === 'editProject') return { ok: true, project };
      if (request.action === 'removeProject') return { ok: true, groupEffect: 'left' };
      if (request.action === 'resume') return { ok: true, threadId: 'thread' };
      if (request.action === 'clear' || request.action === 'compact' || request.action === 'startGoal') return { ok: true, threadId: request.threadId };
      return { ok: true };
    },
    settings: {
      read: async () => ({ ...host, sections: { ...host.sections, judge: { stored: { byProvider: {} }, effective: { byProvider: { 'codex-appserver': { model: 'gpt-6-luna' }, 'claude-agent': { model: 'haiku' }, typesafe: { model: 'jev-latest' } } }, revision: 'judge-token', access: { kind: 'writable' as const }, apply: [] } } }),
      save: async () => ({ kind: 'rejected', fields: [{ field: 'fixture', message: 'fixture' }] }),
      act: async () => ({ kind: 'rejected', fields: [{ field: 'fixture', message: 'fixture' }] }),
      models: async query => ({ backend: query.backend, models: [], state: 'unavailable', source: 'backend-provided', observedAt: new Date().toISOString(), titleEfforts: [] }),
    },
  });
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  try {
    fixture = await startFixture(service, environmentOptions);
    const client = await socketClient(fixture.api.port, fixture.credential, undefined, requestTimeout);
    await client.ready();
    const folderReply = await client.call(requestSchema.parse({ type: 'request', id: 'folder-for-union', method: 'directory', payload: { type: 'choose', path: process.env.HOME } }));
    if (folderReply.type !== 'response' || folderReply.method !== 'directory' || folderReply.payload.kind !== 'folderChosen') throw new Error('Folder token missing');
    const folderToken = folderReply.payload.folder.token;
    const target = { agentId, groupId, projectName };
    const session = { ...target, threadId: 'thread' };
    const cases = {
      command: [
        { type: 'refresh' }, { type: 'listPendingGroups', agentId },
        { type: 'registerAgent' }, { type: 'refreshAgentCredentials', agentId }, { type: 'restartHost' },
        { type: 'listJoinedGroups', agentId }, {type: 'readGroupIdentity', agentId, groupId}, { type: 'listGroupMembers', agentId, groupId, cursor: 'members-page' }, { type: 'feishuRead', agentId, tool: 'feishu_doc', args: { doc: 'dox' } }, { type: 'bindGroup', agentId, groupId, projectName, folder: { kind: 'existing', folderToken }, tool: 'codex', conversation: 'threads' },
        { type: 'setResponse', membershipId: JSON.stringify([agentId, groupId]), response: 'all' },
        { type: 'setPermission', membershipId: JSON.stringify([agentId, groupId]), administrator: 'write', network: true },
        { type: 'setAgentEnabled', agentId, enabled: true }, {type: 'setAgentBadgeNumber', agentId, badgeNumber: '007'},
        { type: 'deleteAgent', agentId }, { type: 'cancelJob', jobId: operationId },
      ],
      settings: [
        { type: 'read', scope: { kind: 'host' } },
        { type: 'save', edit: { scope: { kind: 'host' }, section: 'execution', revision: 'token', patch: { codexBin: null } } },
        { type: 'act', action: { kind: 'voice', botId: agentId, action: { action: 'disable' } } },
        { type: 'models', query: { botId: agentId, backend: 'codex-appserver', purpose: 'session' } },
        { type: 'sessions', botId: agentId, projectName },
      ],
      collaboration: [
        { action: 'providerModels', backend: 'codex-appserver' },
        { action: 'createProject', agentId, name: projectName, folder: { kind: 'default' }, tool: 'codex', conversation: 'threads' },
        { action: 'project', ...target }, { action: 'editProject', ...target, expectedRevision: 'token' }, { action: 'removeProject', ...target, expectedRevision: 'token' },
        { action: 'history', ...target }, { action: 'context', ...session }, { action: 'clear', ...session }, { action: 'compact', ...session },
        { action: 'resume', ...target, sessionId: 'session', backend: 'codex-appserver' }, { action: 'startGoal', ...session, objective: 'fixture' },
        { action: 'stop', ...session, runId: 'run' }, { action: 'stopSubagent', ...session, runId: 'run', subagentId: 'child' }, { action: 'endGoal', ...session, runId: 'run' }, { action: 'reminder', ...session, runId: 'run', requested: true },
        { action: 'usage', force: false }, { action: 'shareUsage', ...target, sections: ['stats'] },
      ],
      environment: [
        { type: 'backendInstallStatus', id: 'claude-agent' }, { type: 'cancelBackendInstall', operationId },
        { type: 'scan' }, { type: 'backendCatalog' }, { type: 'backendVersion', id: 'claude-agent' }, { type: 'backendLogin', id: 'claude-agent', refresh: false }, { type: 'backendInstall', id: 'claude-agent', update: false }, { type: 'backendUninstall', id: 'claude-agent' },
        { type: 'install', tool: 'lark-cli' }, { type: 'update', tool: 'lark-cli' }, { type: 'toolInstallStatus' }, { type: 'cancelInstall', operationId }, { type: 'uninstall', tool: 'lark-cli' },
        { type: 'authStatus', tool: 'lark-cli' }, { type: 'startLogin', tool: 'lark-cli' }, { type: 'loginStatus' }, { type: 'cancelLogin', operationId },
        { type: 'profileList' }, { type: 'profileUse', name: 'test' }, { type: 'profileAdd', name: 'test', appId: 'cli_test', appSecret: 'fake-secret', brand: 'feishu', use: false },
        { type: 'profileInit', name: 'test' }, { type: 'profileInitStatus' }, { type: 'profileInitCancel', operationId },
      ],
      machine: [
        { type: 'mcp', request: { action: 'list', provider: 'claude' } }, { type: 'bridgeImport', action: 'status' },
        { type: 'status' }, { type: 'service', action: 'install' }, { type: 'setServiceSkipped', skipped: false }, { type: 'startHost' }, { type: 'stopHost' }, { type: 'logs' },
        { type: 'checkCoreUpdate' }, { type: 'applyCoreUpdate' }, { type: 'coreUpdateStatus' },
        { type: 'desktopUpdateReport', requestId: 'dur_0000000000000000', state: 'current', message: 'x' },
      ],
    };
    const unions = {
      command: schemas.commandSchema, settings: schemas.settingsRequestSchema, collaboration: schemas.collaborationRequestSchema,
      environment: schemas.environmentRequestSchema, machine: schemas.machineRequestSchema,
    };
    const unsupported = new Set(['machine.bridgeImport', 'machine.service', 'machine.startHost']);
    // devices-ui-4: only this computer's desktop shell, having declared it, reports its own update
    const shellOnly = new Set(['machine.desktopUpdateReport']);
    for (const method of Object.keys(cases) as (keyof typeof cases)[]) {
      const variants = cases[method];
      const actual = variants.map(value => 'type' in value ? value.type : value.action);
      const defined = unions[method].options.map(option => 'type' in option.shape ? option.shape.type.value : option.shape.action.value);
      expect(new Set(actual), `${method} has every union variant once`).toEqual(new Set(defined));
      expect(actual.length, `${method} has no duplicate variant`).toBe(new Set(actual).size);
      for (const payload of variants) {
        const variant = 'type' in payload ? payload.type : payload.action;
        const key = `${method}.${variant}`;
        const frame = await client.call(requestSchema.parse({ type: 'request', id: `union-${key}`, method, payload }));
        if (unsupported.has(key)) expect(frame, key).toMatchObject({ type: 'error', code: 'unsupported' });
        else if (shellOnly.has(key)) expect(frame, key).toMatchObject({ type: 'error', code: 'forbidden' });
        else {
          expect(frame.type, key).toBe('response');
          expect(responseSchema.safeParse(frame).success, key).toBe(true);
          if (key === 'collaboration.providerModels') expect(frame).toMatchObject({ payload: { kind: 'providerModels', backend: 'codex-appserver', state: 'unavailable', models: [] } });
          if (key === 'environment.backendInstallStatus') expect(frame).toMatchObject({ payload: { kind: 'backendInstallStatus', operation: null } });
          if (key === 'machine.mcp') expect(frame).toMatchObject({ payload: { type: 'mcp', provider: 'claude', status: 'ready', entries: [] } });
          if (key === 'collaboration.stopSubagent') expect(frame).toMatchObject({ type: 'response', method: 'collaboration', payload: { kind: 'applied' } });
          if (key === 'command.feishuRead') expect(frame).toMatchObject({ type: 'response', method: 'command', payload: { kind: 'feishuRead', result: { title: 'fixture' } } });
          if (key === 'command.readGroupIdentity') expect(frame).toMatchObject({type: 'response', method: 'command', payload: {kind: 'groupIdentity', agentId, groupId, name: '飞书物理群名'}});
          if (key === 'command.listGroupMembers') expect(frame).toMatchObject({ type: 'response', method: 'command', payload: { kind: 'members', members, nextCursor: 'members-next' } });
        }
      }
    }
    expect(stopSubagent).toHaveBeenCalledExactlyOnceWith(agentId, {
      action: 'stopSubagent', projectName, chatId: groupId, threadId: 'thread', runId: 'run', subagentId: 'child',
    });
    expect(groupMembers).toHaveBeenCalledExactlyOnceWith(agentId, groupId, 'members-page');
    expect(unsupported.size).toBe(3);
    await client.close();
  } finally {
    await fixture?.close();
    await rm(environmentHome, { recursive: true, force: true });
  }
}, processTestTimeout);
