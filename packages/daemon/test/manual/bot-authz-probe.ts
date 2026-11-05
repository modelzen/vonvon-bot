/**
 * devices-4b 6, Linux self-test: the daemon's API in this process on a temporary data root, and a fake Bot process forked
 * from this file that runs the real `createAgentEntries` and answers over the real admin IPC (`authorizeSessionCall`) and
 * host IPC (session tokens). The fake process opens turns (who, where, what they typed) as the host tells it; each step
 * then runs the bundled CLI with that session's token, as the Bot's shell would. Memory goes over the wire with the
 * token, as `vonvon memory` in a session still refuses before C5. Not a vitest file; nothing real is touched:
 *
 *   (in packages/daemon, protocol and client built: the bundles keep packages external and find them from here)
 *   mkdir -p node_modules/.cache && B=$(mktemp -d -p node_modules/.cache) && T=$(mktemp -d) && mkdir "${T:?}/home"
 *   npx esbuild src/cli/index.ts --bundle --platform=node --format=esm --packages=external --outfile="${B:?}/cli.mjs"
 *   npx esbuild test/manual/bot-authz-probe.ts --bundle --platform=node --format=esm --packages=external --outfile="${B:?}/probe.mjs"
 *   HOME="${T:?}/home" VONVON_HOME="${T:?}/vh" node "${B:?}/probe.mjs" "${B:?}/cli.mjs"
 *   rm -rf -- "${B:?}" "${T:?}"
 *
 * It prints two lines a step and exits 0 when every step came out as devices-4b's acceptance (and S1b's, Codex review 256–257) says, 1 otherwise.
 */
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectLocal } from '@vonvon/client';
import type { MemoryReply, ScheduledTaskView } from '@vonvon/protocol';
import agentFixture from '../../../protocol/test/fixtures/agent-settings.json';
import { askBotOver, createAdminIpcCaller, createAdminIpcResponder, createHostIpcCaller, createHostIpcResponder, sessionTurnEnded } from '../../src/admin/ipc';
import type { ScheduleActor } from '../../src/admin/schedule-commands';
import type { AdminService } from '../../src/admin/service';
import { createAgentEntries, type AgentPlace, type TurnScope } from '../../src/agent/entry/registry';
import type { AgentThread } from '../../src/agent/types';
import { paths } from '../../src/config/paths';
import { createSessionTokens } from '../../src/host/session-tokens';
import { startApi } from '../../src/server/http';

const APP_ID = 'cli_probe';
const GROUP_A = 'oc_probe_a';
const GROUP_B = 'oc_probe_b';
const PROJECT_A = 'prj_0000000a';
const PROJECT_B = 'prj_0000000b';
const OWNER = 'ou_probe_owner';
const ADMIN = 'ou_probe_admin';
const MEMBER = 'ou_probe_member';

type Control =
  | { probe: 'open'; id: number; place: 'dm' | 'group'; chatId: string; openId: string; text: string }
  | { probe: 'close'; id: number; sessionId: string }
  | { probe: 'switch'; id: number; on: boolean };

/** The fake Bot process: the real registry, its turns opened as the host says, its tokens asked of the host. */
async function bot(): Promise<void> {
  // A host that is gone is not written to: the error goes to the callback, not the process.
  const send = (message: unknown): void => { if (process.connected) process.send?.(message, undefined, {}, () => {}); };
  const hostApi = createHostIpcCaller(send);
  process.on('message', hostApi.onMessage);
  let switchOn = true;
  const entries = createAgentEntries({
    appId: APP_ID, isAdmin: id => id === OWNER || id === ADMIN, chatSettingsOn: () => switchOn,
    sessions: { revoke: sessionId => { void hostApi.revokeSessionToken(sessionId).catch(() => {}); } },
    memoryPlace: async turn => turn.place === 'group' ? { chatProjectId: PROJECT_A } : { botProjectIds: [PROJECT_A, PROJECT_B] },
  });
  process.on('message', createAdminIpcResponder(async op => {
    if (op.kind !== 'authorizeSessionCall') throw new Error(`the probe's Bot process does not do ${op.kind}`);
    return entries.authorizeSessionCall(op.sessionId, op.action);
  }, send));
  const turns = new Map<string, TurnScope>();
  let message = 0;
  process.on('message', (raw: unknown) => {
    const control = raw as Control;
    if (!control || typeof control !== 'object' || !('probe' in control)) return;
    void (async () => {
      switch (control.probe) {
        case 'open': {
          const place: AgentPlace = { kind: control.place === 'dm' ? 'p2p' : 'group', chatId: control.chatId };
          const entry = entries.issue(place);
          const made = thread();
          entry.attach(made);
          const token = await hostApi.issueSessionToken({ appId: APP_ID, place: control.place, chatId: control.chatId, sessionId: entry.sessionId });
          const facts = { requesterOpenId: control.openId, requesterKind: 'user' as const, triggerMessageId: `om_probe_${++message}`, retry: false, initiative: false, wake: false,
            typed: true, triggerText: control.text, requesterName: control.openId.replace('ou_probe_', '') };
          turns.set(entry.sessionId, entries.openTurn(made, facts));
          send({ probe: 'done', id: control.id, token, sessionId: entry.sessionId });
          return;
        }
        case 'close': turns.get(control.sessionId)?.close(); break;
        case 'switch': switchOn = control.on; break;
      }
      send({ probe: 'done', id: control.id });
    })();
  });
  /** A provider thread that is alive and runs nothing: the turns are what the probe looks at. */
  const thread = (): AgentThread => ({
    sessionId: 'probe', isAlive: () => true, close: async () => {}, runStreamed: () => { throw new Error('unused'); }, runGoal: () => { throw new Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {}, compact: async () => ({ compacted: false, usage: null }),
  });
  process.once('disconnect', () => process.exit(0));
  send({ probe: 'ready' });
}

async function host(cli: string | undefined): Promise<number> {
  if (!cli) { process.stderr.write('usage: node probe.mjs <bundled cli.mjs>\n'); return 2; }
  await mkdir(join(paths.appDir, 'library'), { recursive: true, mode: 0o700 });
  await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [{ appId: APP_ID, name: 'Probe', tenant: 'feishu', createdAt: 1 }] }));
  const library = (id: string, name: string) => ({ id, name, createdAt: 1, revision: 1, workspace: { primary: `/probe/${name}`, additional: [] } });
  await writeFile(join(paths.appDir, 'library', 'projects.json'), JSON.stringify({ version: 1, projects: [library(PROJECT_A, 'a'), library(PROJECT_B, 'b')] }));

  const tokens = createSessionTokens();
  const child: ChildProcess = fork(process.argv[1]!, ['--bot'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const caller = createAdminIpcCaller(message => { if (!child.connected) throw new Error('IPC 通道已关闭'); child.send(message); });
  child.on('message', caller.onMessage);
  child.on('message', createHostIpcResponder({ issueSessionToken: async input => tokens.issue(input), revokeSessionToken: async sessionId => { tokens.revoke(sessionId); } },
    message => { if (child.connected) child.send(message); }).onMessage);
  const waiting = new Map<number, (reply: { token?: string; sessionId?: string }) => void>();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  child.on('message', (raw: unknown) => {
    const reply = raw as { probe?: string; id?: number; token?: string; sessionId?: string };
    if (reply?.probe === 'ready') ready();
    if (reply?.probe === 'done' && reply.id !== undefined) { waiting.get(reply.id)?.(reply); waiting.delete(reply.id); }
  });
  let next = 0;
  const control = (message: Control extends infer C ? C extends Control ? Omit<C, 'id'> : never : never): Promise<{ token?: string; sessionId?: string }> => new Promise(resolve => {
    const id = ++next;
    waiting.set(id, resolve);
    child.send({ ...message, id });
  });
  const turn = async (place: 'dm' | 'group', openId: string, text = '你好') => {
    const reply = await control({ probe: 'open', place, chatId: place === 'dm' ? 'oc_probe_dm' : GROUP_A, openId, text });
    return { token: reply.token!, sessionId: reply.sessionId!, close: () => control({ probe: 'close', sessionId: reply.sessionId! }) };
  };

  const api = await startApi({
    service: service(), port: 0, sessionTokens: tokens,
    askBot: (appId, sessionId, action) => appId === APP_ID && child.connected ? askBotOver(caller, sessionId, action) : Promise.resolve(sessionTurnEnded()),
  });
  await writeFile(join(paths.appDir, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: api.listen }));
  await started;

  let failed = 0;
  const check = (step: string, result: Result, expected: { code: number; text?: string; reason?: string }) => {
    const good = result.code === expected.code && (!expected.text || result.full.includes(expected.text)) && (!expected.reason || result.reason === expected.reason);
    if (!good) failed++;
    process.stdout.write(`${good ? 'ok  ' : 'FAIL'} ${step}\n     → exit ${result.code}${result.reason ? ` ${result.reason}` : ''}：${result.text}\n`);
  };
  const dmScope = ['--scope', `bot=${APP_ID}`];

  const member = await turn('dm', MEMBER);
  check('私聊，成员这一轮：settings set cards.showToolCalls=false', await run(cli, member.token, ['settings', 'set', 'cards.showToolCalls=false', ...dmScope]),
    { code: 4, reason: 'permission_denied', text: '只有主人和管理员发消息触发的那一轮能改设置。' });

  const admin = await turn('dm', ADMIN);
  await control({ probe: 'switch', on: false });
  check('私聊，管理员这一轮，"聊天改设置"关着：settings set cards.showToolCalls=false', await run(cli, admin.token, ['settings', 'set', 'cards.showToolCalls=false', ...dmScope]),
    { code: 4, reason: 'permission_denied', text: '主人关了私聊里的“聊天改设置”' });
  await control({ probe: 'switch', on: true });
  check('私聊，管理员这一轮：settings act admin add ou_probe_new', await run(cli, admin.token, ['settings', 'act', 'admin', 'add', 'ou_probe_new', ...dmScope]),
    { code: 4, reason: 'permission_denied', text: '本机管理员名单只有飞书应用的拥有者能改。' });
  check('私聊，管理员这一轮：settings set cards.showToolCalls=false', await run(cli, admin.token, ['settings', 'set', 'cards.showToolCalls=false', ...dmScope]), { code: 0, text: '"kind":"saved"' });

  const owner = await turn('dm', OWNER);
  check('私聊，主人这一轮：settings act admin add ou_probe_new', await run(cli, owner.token, ['settings', 'act', 'admin', 'add', 'ou_probe_new', ...dmScope]), { code: 0, text: '"result":"saved"' });
  check('私聊，主人这一轮：settings set --group oc_probe_b permission.mode=full（同一个 Bot 的另一个群）',
    await run(cli, owner.token, ['settings', 'set', '--group', GROUP_B, 'permission.mode=full', ...dmScope]), { code: 0, text: '"kind":"saved"' });
  // D4a's reach first: the snapshot of a reach of one group shows no other, so the command line cannot even name it.
  check('私聊，主人这一轮，--scope 只到 oc_probe_a：settings set --group oc_probe_b（D4a 的范围先拦）',
    await run(cli, owner.token, ['settings', 'set', '--group', GROUP_B, 'permission.mode=full', '--scope', `bot=${APP_ID},group=${GROUP_A}`]), { code: 2, text: '没有绑定「oc_probe_b」' });
  await owner.close();
  check('同一枚令牌，那一轮结束后：settings set cards.showToolCalls=false', await run(cli, owner.token, ['settings', 'set', 'cards.showToolCalls=false', ...dmScope]),
    { code: 4, reason: 'permission_denied', text: '这次调用对应的那一轮对话已经结束，不能再改设置。' });

  const groupScope = ['--scope', `bot=${APP_ID},group=${GROUP_A}`];
  const groupMember = await turn('group', MEMBER, '记住 周四发版');
  check('群里，成员这一轮：settings set --group oc_probe_a permission.mode=full', await run(cli, groupMember.token, ['settings', 'set', '--group', GROUP_A, 'permission.mode=full', ...groupScope]),
    { code: 4, reason: 'not-dm', text: '群里不能改设置。' });
  // Codex review 256 / 257: the group's own project by its right name, and its id; a comment's session with its own sentence
  check('群里，成员这一轮：group set a --disable（本群项目的名字）', await run(cli, groupMember.token, ['group', 'set', 'a', '--disable', ...groupScope]),
    { code: 4, reason: 'not-dm', text: '群里不能改设置。私聊我可以改' });
  check('群里，成员这一轮：group set oc_probe_a --disable', await run(cli, groupMember.token, ['group', 'set', GROUP_A, '--disable', ...groupScope]),
    { code: 4, reason: 'not-dm', text: '群里不能改设置。私聊我可以改' });
  const comment = tokens.issue({ appId: APP_ID, place: 'comment', sessionId: 'ses_00000000000000c0' });
  check('评论会话：group set oc_probe_a --disable', await run(cli, comment, ['group', 'set', GROUP_A, '--disable', '--scope', `bot=${APP_ID}`]),
    { code: 4, reason: 'not-dm', text: '评论里不能改设置。私聊我可以改' });
  for (const [who, token] of [['群里，成员这一轮', groupMember.token], ['评论会话', comment]] as const) {
    check(`${who}：service status（服务管理器的，会话里不能用）`, await run(cli, token, ['service', 'status']), { code: 4, reason: 'not_in_session', text: '不能在 Bot 会话里运行' });
    const status = await run(cli, token, ['daemon', 'status']);
    check(`${who}：daemon status（只有在不在跑和端口）`, fields(status), { code: 0, text: 'fields listen,running,source' });
    const { client, serverInfo } = await connectLocal({ home: paths.appDir, cliEntry: cli, credential: token });
    await client.close();
    check(`${who}：握手（不带设备名、机器标识）`, result(0, `fields ${Object.keys(serverInfo).sort().join(',')}`), { code: 0, text: 'fields principal,protocolVersion,type,version' });
  }
  // The fake schedule echoes the actor it was given as the task's creator: shown alone, the rest of the task is the fake's.
  const added = await run(cli, groupMember.token, ['schedule', 'add', '看一下构建', '--name', '构建', '--every', '30m', '--group', GROUP_A, ...groupScope]);
  const creator = added.code === 0 ? JSON.stringify((JSON.parse(added.full) as { task?: { createdBy?: unknown } }).task?.createdBy) : added.full;
  check('群里，成员这一轮：schedule add（以这一轮的成员身份建，记成命令行建的）', { ...added, text: `createdBy ${creator}` }, { code: 0, text: '"createdBy":{"via":"cli","openId":"ou_probe_member"' });
  const memberMemory = await remember(cli, groupMember.token, '周四发版');
  check('群里，成员这一轮：memory add（要写 Bot 记忆，经 wire）', memberMemory, { code: 0, text: `"scope":{"kind":"project","projectId":"${PROJECT_A}"}` });
  check('  … 那一条不在 Bot 记忆里，在本群项目里、不可信', await listed(cli, groupMember.token, '周四发版'), { code: 0, text: 'bot:0 project:1 untrusted' });
  const groupAdmin = await turn('group', ADMIN, '记住 先写结论');
  check('群里，管理员这一轮，原话里有：memory add（要写 Bot 记忆）', await remember(cli, groupAdmin.token, '先写结论'), { code: 0, text: '"scope":{"kind":"bot"},"text":"先写结论"' });
  await groupMember.close();
  check('群里，成员那一轮结束后：schedule list', await run(cli, groupMember.token, ['schedule', 'list', '--group', GROUP_A, ...groupScope]), { code: 4, reason: 'permission_denied', text: '这次调用对应的那一轮对话已经结束' });

  // No Bot process to ask (it went, its tokens not yet revoked): refused, never let through.
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  check('Bot 进程没了（令牌还没作废）：settings set', await run(cli, admin.token, ['settings', 'set', 'cards.showToolCalls=false', ...dmScope]), { code: 4, reason: 'permission_denied', text: '这次调用对应的那一轮对话已经结束' });

  await api.close();
  process.stdout.write(failed ? `${failed} 步不对。\n` : '全部符合。\n');
  return failed ? 1 : 0;
}

/** `text` is what a step shows (cut at 300 characters), `full` what it is checked against. */
interface Result { code: number | null; reason?: string; text: string; full: string }
const result = (code: number | null, full: string, reason?: string): Result => ({ code, full, text: full.length > 300 ? `${full.slice(0, 300)}…` : full, ...(reason ? { reason } : {}) });
/** A successful --json reply as the names of its fields (besides `ok`), so a step checks nothing more came. */
const fields = (step: Result): Result => {
  try { return result(step.code, `fields ${Object.keys(JSON.parse(step.full) as object).filter(key => key !== 'ok').sort().join(',')}`, step.reason); }
  catch { return step; }
};
/** The bundled CLI as the Bot's shell runs it: the token in front of the command, the owner's credential never read. */
function run(cli: string, token: string, args: string[]): Promise<Result> {
  const child = spawn(process.execPath, [cli, ...args, '--json'], { env: { ...process.env, VONVON_SESSION: token, FEISHU_CODEX_BRIDGE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += String(data); });
  child.stderr.on('data', data => { err += String(data); });
  return new Promise(done => child.once('close', code => {
    try {
      const json = JSON.parse(out) as { ok: boolean; error?: { reason?: string; kind?: string; message?: string } } & Record<string, unknown>;
      done(result(code, json.ok ? JSON.stringify(json) : json.error?.message ?? '', json.error ? json.error.reason ?? json.error.kind : undefined));
    } catch { done(result(code, `${out}${err}`.trim())); }
  }));
}
/** `memory add --bot` as C5 will send it: the memory RPC with the session's token and scope. */
async function remember(cli: string, token: string, text: string): Promise<Result> {
  const { client } = await connectLocal({ home: paths.appDir, cliEntry: cli, credential: token });
  try {
    await client.admin({ type: 'negotiate', capabilities: ['cli'], scope: { bot: APP_ID, group: GROUP_A } });
    const reply = await client.memory({ type: 'add', scope: { kind: 'bot', botId: APP_ID }, text });
    const item = reply.kind === 'item' ? reply.item : undefined;
    return result(item ? 0 : 1, item ? JSON.stringify({ scope: item.scope, text: item.text, trust: item.trust, source: item.source }) : JSON.stringify(reply));
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return result(4, failure.message ?? String(error), failure.code ?? 'error');
  } finally { await client.close(); }
}
/** Where `text` is: counted in the bot's memory and the group's project, with the project item's trust. */
async function listed(cli: string, token: string, text: string): Promise<Result> {
  const { client } = await connectLocal({ home: paths.appDir, cliEntry: cli, credential: token });
  try {
    await client.admin({ type: 'negotiate', capabilities: ['cli'], scope: { bot: APP_ID, group: GROUP_A } });
    const items = (reply: MemoryReply) => reply.kind === 'list' ? reply.items.filter(item => item.text === text) : [];
    const bot = items(await client.memory({ type: 'list', scope: { kind: 'bot', botId: APP_ID } }));
    const project = items(await client.memory({ type: 'list', scope: { kind: 'project', projectId: PROJECT_A } }));
    return result(0, `bot:${bot.length} project:${project.length} ${project.map(item => item.trust).join(',')}`);
  } finally { await client.close(); }
}

/** What the steps reach: settings views that pass the protocol's schemas, and a schedule that shows who it ran as. */
function service(): AdminService {
  const row = (name: string, chatId: string, projectId: string) => ({ name, chatId, projectId, cwd: `/probe/${name}`, blank: false, kind: 'multi', origin: 'joined', noMention: false,
    mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 });
  const agent = { ...agentFixture, scope: { kind: 'agent', botId: APP_ID } };
  const section = (value: unknown) => ({ stored: value, effective: value, revision: 'r1', access: { kind: 'writable' }, apply: [] });
  const options = { tiers: ['qa', 'write', 'full'].map(tier => ({ tier, name: '权限', summary: '说明', native: '' })), strength: '能力说明', fields: [], expanded: { qa: {}, write: {}, full: {} } };
  const project = (name: string, chatId: string) => ({
    scope: { kind: 'project', botId: APP_ID, projectName: name },
    sections: { permission: section({ mode: 'qa', guestMode: 'qa', network: false, custom: null, options }), response: section({ noMention: false }), model: section({ selection: { kind: 'default' } }) },
    identity: { chatId, backend: 'codex-appserver', cwd: `/probe/${name}`, kind: 'multi' }, members: { openIds: [], revision: 'm1' },
  });
  const projects = [row('a', GROUP_A, PROJECT_A), row('b', GROUP_B, PROJECT_B)];
  const viewOf = (scope: { kind: string; projectName?: string }) => scope.kind === 'agent' ? agent : project(scope.projectName!, scope.projectName === 'a' ? GROUP_A : GROUP_B);
  const task = (actor: ScheduleActor): ScheduledTaskView => ({
    id: 'st_0000000000000001', botId: APP_ID, chatId: GROUP_A, revision: 'r1', name: '构建', instruction: '看一下构建', spec: { kind: 'every', minutes: 30 }, timeZone: 'UTC', placement: { kind: 'follow' },
    state: 'active', createdBy: actor.kind === 'session' ? { via: 'cli', openId: actor.openId, role: actor.role, ...(actor.name ? { name: actor.name } : {}) } : { via: 'cli' },
    createdAt: 1, updatedAt: 1, nextRunAt: 2, running: false, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], describe: '每 30 分钟',
  });
  return {
    listBots: async () => [{ appId: APP_ID, name: 'Probe', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } }],
    listProjects: async (botId: string) => botId === APP_ID ? projects : [],
    listSessions: async () => [],
    getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'probe', supported: false }),
    updateStatus: () => null,
    codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }),
    executeSchedule: async (_botId: string, actor: ScheduleActor, request: { action: string }) => request.action === 'create'
      ? { kind: 'task', task: task(actor) } : { kind: 'tasks', tasks: [], now: Date.now(), timeZone: 'UTC' },
    settings: {
      read: async (scope: { kind: string; projectName?: string }) => viewOf(scope),
      save: async (edit: { scope: { kind: string; projectName?: string }; section: string }) => ({
        kind: 'saved', section: { scope: edit.scope, section: edit.section, value: section({}) }, effects: [{ fields: [], when: 'immediate', detail: '设置已保存' }],
      }),
      act: async () => ({ kind: 'saved', view: { ...agent, administrators: { ...agent.administrators, openIds: [...agent.administrators.openIds, 'ou_probe_new'], revision: 'a2' } }, effects: [], warnings: [] }),
      models: async () => { throw new Error('unused'); },
    },
  } as unknown as AdminService;
}

// Last, after every constant above is set: `--bot` is the forked Bot process, anything else the host and its steps.
if (process.argv[2] === '--bot') await bot();
else process.exit(await host(process.argv[2]));
