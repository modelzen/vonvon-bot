/**
 * skills-scope 6, Linux self-test: every `vonvon …` line the builtin skills teach, run as a Bot's shell would run it.
 * The daemon's API runs in this process on a temporary data root, with a fake Bot process forked from this file that runs
 * the real `createAgentEntries` and answers over the real admin and host IPC (as bot-authz-probe.ts). For each skill the
 * probe opens the owner's turn where the skill is handed over (the group set in a group, the private-chat set in a
 * private chat), sets `VONVON_SESSION` and `VONVON_SCOPE` as handle-message does, and runs each line through `sh -c`
 * with `vonvon` the bundled CLI, `$VONVON_SCOPE` expanded by the shell. Then the refusals the skills tell the Bot to
 * expect. Not a vitest file; nothing real is touched:
 *
 *   (in packages/daemon, protocol and client built: the bundles keep packages external and find them from here)
 *   mkdir -p node_modules/.cache && B=$(mktemp -d -p node_modules/.cache) && T=$(mktemp -d) && mkdir "${T:?}/home"
 *   npx esbuild src/cli/index.ts --bundle --platform=node --format=esm --packages=external --outfile="${B:?}/cli.mjs"
 *   npx esbuild test/manual/skills-probe.ts --bundle --platform=node --format=esm --packages=external --outfile="${B:?}/probe.mjs"
 *   HOME="${T:?}/home" VONVON_HOME="${T:?}/vh" node "${B:?}/probe.mjs" "${B:?}/cli.mjs"
 *   rm -rf -- "${B:?}" "${T:?}"
 *
 * It prints two lines a step and exits 0 when every step came out as the skills say, 1 otherwise.
 */
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScheduledTaskView } from '@vonvon/protocol';
import agentFixture from '../../../protocol/test/fixtures/agent-settings.json';
import { askBotOver, createAdminIpcCaller, createAdminIpcResponder, createHostIpcCaller, createHostIpcResponder, sessionTurnEnded } from '../../src/admin/ipc';
import type { ScheduleActor } from '../../src/admin/schedule-commands';
import type { AdminService } from '../../src/admin/service';
import { builtinSkillsOfSet } from '../../src/agent/builtin-skills/registry';
import { createAgentEntries, type AgentPlace, type TurnScope } from '../../src/agent/entry/registry';
import type { AgentThread } from '../../src/agent/types';
import { paths } from '../../src/config/paths';
import { SESSION_SCOPE_ENV, sessionScope } from '../../src/config/session-env';
import { createSessionTokens } from '../../src/host/session-tokens';
import { startApi } from '../../src/server/http';
import { skillCommands } from '../helpers/skill-commands';

const APP_ID = 'cli_probe';
const GROUP_A = 'oc_probe_a';
const GROUP_B = 'oc_probe_b';
const DM = 'oc_probe_dm';
const PROJECT_A = 'prj_0000000a';
const PROJECT_B = 'prj_0000000b';
const OWNER = 'ou_probe_owner';
const ADMIN = 'ou_probe_admin';
const MEMBER = 'ou_probe_member';
const TASK = 'st_0000000000000001';
/** What each placeholder of the skills' lines stands for here. */
const VALUES: Record<string, string> = {
  '<chatId>': GROUP_A, '<taskId>': TASK, '<revision>': 'r1', '<openId>': 'ou_probe_new', '<名字>': '构建', '<任务内容>': '看一下构建',
  '<群名>': '新群', '<为什么改>': '主人说的', '<评论说明>': '只回和代码有关的评论',
};

type Control = { probe: 'open'; id: number; place: 'dm' | 'group'; chatId: string; openId: string } | { probe: 'close'; id: number; sessionId: string };

/** The fake Bot process: the real registry, its turns opened as the host says, its tokens asked of the host. */
async function bot(): Promise<void> {
  const send = (message: unknown): void => { if (process.connected) process.send?.(message, undefined, {}, () => {}); };
  const hostApi = createHostIpcCaller(send);
  process.on('message', hostApi.onMessage);
  const entries = createAgentEntries({
    appId: APP_ID, isAdmin: id => id === OWNER || id === ADMIN, isOwner: id => id === OWNER, chatSettingsOn: () => true,
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
      if (control.probe === 'close') { turns.get(control.sessionId)?.close(); send({ probe: 'done', id: control.id }); return; }
      const place: AgentPlace = { kind: control.place === 'dm' ? 'p2p' : 'group', chatId: control.chatId };
      const entry = entries.issue(place);
      const made = thread();
      entry.attach(made);
      const token = await hostApi.issueSessionToken({ appId: APP_ID, place: control.place, chatId: control.chatId, sessionId: entry.sessionId });
      turns.set(entry.sessionId, entries.openTurn(made, { requesterOpenId: control.openId, requesterKind: 'user', triggerMessageId: `om_probe_${++message}`,
        retry: false, initiative: false, wake: false, typed: true, triggerText: '你好', requesterName: control.openId.replace('ou_probe_', '') }));
      send({ probe: 'done', id: control.id, token, sessionId: entry.sessionId });
    })();
  });
  const thread = (): AgentThread => ({
    sessionId: 'probe', isAlive: () => true, close: async () => {}, runStreamed: () => { throw new Error('unused'); }, runGoal: () => { throw new Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {}, compact: async () => ({ compacted: false, usage: null }),
  });
  process.once('disconnect', () => process.exit(0));
  send({ probe: 'ready' });
}

interface Session { token: string; scope: string; sessionId: string }

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
  /** A turn of `openId` and its session's environment, as handle-message's sessionEnv sets it. */
  const turn = async (place: 'dm' | 'group', openId: string): Promise<Session> => {
    const chatId = place === 'dm' ? DM : GROUP_A;
    const reply = await control({ probe: 'open', place, chatId, openId });
    return { token: reply.token!, sessionId: reply.sessionId!, scope: sessionScope(APP_ID, place === 'group' ? chatId : undefined) };
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
  const fill = (line: string): string => Object.entries(VALUES).reduce((text, [key, value]) => text.split(key).join(value), line);

  // Each skill's lines, in the place its set goes to, as the owner's turn: the owner may do all of it.
  const group = await turn('group', OWNER);
  const dm = await turn('dm', OWNER);
  for (const [set, session] of [['group', group], ['dm', dm]] as const) {
    for (const skill of builtinSkillsOfSet(set)) {
      for (const line of skillCommands(skill.body)) check(`${set === 'group' ? '群里' : '私聊'}，主人这一轮，${skill.name}：${line}`, await shell(cli, session, fill(line)), { code: 0 });
    }
  }

  // What the skills say is refused, and in which words.
  const groupMember = await turn('group', MEMBER);
  const add = 'vonvon schedule add 看一下构建 --name 构建 --daily 09:00 --group oc_probe_a';
  check('群里：建任务不带 --scope', await shell(cli, group, `${add} --json`), { code: 4, reason: 'scope_required', text: '必须带 `--scope' });
  check('群里：建任务，--scope 只写 bot（比本群大）', await shell(cli, group, `${add} --scope bot=${APP_ID} --json`), { code: 4, reason: 'scope_required', text: '范围超过了这条会话' });
  check('群里：建任务，--scope 写成别的群', await shell(cli, group, `${add} --scope bot=${APP_ID},group=${GROUP_B} --json`), { code: 4, reason: 'scope_required', text: '范围超过了这条会话' });
  check('群里：VONVON_SCOPE 是空的（这一版之前起的会话）', await shell(cli, { ...group, scope: '' }, `${add} --scope "$VONVON_SCOPE" --json`), { code: 2, text: '--scope 的写法' });
  check('群里，成员这一轮：照任务 skill 建任务', await shell(cli, groupMember, `${add} --scope "$VONVON_SCOPE" --json`), { code: 0 });
  for (const [what, line] of [
    ['改本群权限', 'vonvon settings set --group oc_probe_a permission.mode=qa'],
    ['改本群会话方式', 'vonvon group set oc_probe_a --conversation smart'],
    ['改本群响应成员', 'vonvon settings act member add ou_probe_new --group oc_probe_a'],
    ['建群', 'vonvon group create 新群 --conversation multi'],
    ['读整个 Bot 的设置', 'vonvon settings get'],
  ] as const) check(`群里，主人这一轮：${what}`, await shell(cli, group, `${line} --scope "$VONVON_SCOPE" --json`), { code: 4, reason: 'not-dm', text: '设置只能在私聊里改。请对方去私聊里跟我说。' });
  for (const line of ['vonvon daemon restart', 'vonvon update', 'vonvon service install', 'vonvon pair', 'vonvon daemon stop']) {
    check(`群里：${line}`, await shell(cli, group, `${line} --json`), { code: 4, reason: 'not_in_session', text: '不能在 Bot 会话里运行。告诉用户去设备上或桌面端里做。' });
  }
  check('群里：vonvon remote enable 1.2.3.4（D3 之前没有这条命令）', await shell(cli, group, 'vonvon remote enable 1.2.3.4 --json'), { code: 2 });
  for (const [what, line] of [
    ['绑别的群', 'vonvon group bind oc_probe_c --name c --conversation multi'],
    ['解绑本群', 'vonvon group unbind oc_probe_a --yes'],
  ] as const) check(`群里：${what}`, await shell(cli, group, `${line} --scope "$VONVON_SCOPE" --json`), { code: 4 });

  // The private chat: who may change what, and what is never done from a chat.
  const dmMember = await turn('dm', MEMBER);
  const dmAdmin = await turn('dm', ADMIN);
  check('私聊，成员这一轮：改群的权限', await shell(cli, dmMember, 'vonvon settings set --group oc_probe_a permission.mode=qa --scope "$VONVON_SCOPE" --json'),
    { code: 4, text: '只有主人和管理员发消息触发的那一轮能改设置。' });
  check('私聊，管理员这一轮：改群的权限', await shell(cli, dmAdmin, 'vonvon settings set --group oc_probe_a permission.mode=qa --scope "$VONVON_SCOPE" --json'), { code: 0 });
  check('私聊，管理员这一轮：加管理员', await shell(cli, dmAdmin, 'vonvon settings act admin add ou_probe_new --scope "$VONVON_SCOPE" --json'), { code: 4, text: '本机管理员名单只有主人能改。' });
  for (const [what, line] of [
    ['换项目的文件夹', 'vonvon project workspace a --primary /tmp'],
    ['换群的文件夹', 'vonvon group set oc_probe_a --folder /tmp'],
    ['建群时指定文件夹', 'vonvon group create 新群 --conversation multi --folder /tmp'],
    ['绑已有的群', 'vonvon group bind oc_probe_c --name c --conversation multi'],
    ['解绑群', 'vonvon group unbind oc_probe_a --yes'],
    ['本机设置', 'vonvon settings get --host'],
  ] as const) check(`私聊，主人这一轮：${what}`, await shell(cli, dm, `${line} --scope "$VONVON_SCOPE" --json`), { code: 4 });
  for (const line of ['vonvon secrets list', 'vonvon daemon restart']) check(`私聊：${line}`, await shell(cli, dm, `${line} --json`), { code: 4, reason: 'not_in_session' });
  await control({ probe: 'close', sessionId: dm.sessionId });
  check('私聊，主人那一轮结束后：改群的权限', await shell(cli, dm, 'vonvon settings set --group oc_probe_a permission.mode=qa --scope "$VONVON_SCOPE" --json'),
    { code: 4, text: '这次调用对应的那一轮对话已经结束，不能再改设置。' });

  child.kill('SIGTERM');
  await api.close();
  process.stdout.write(failed ? `${failed} 步不对。\n` : '全部符合。\n');
  return failed ? 1 : 0;
}

/** `text` is what a step shows (cut at 300 characters), `full` what it is checked against. */
interface Result { code: number | null; reason?: string; text: string; full: string }
const result = (code: number | null, full: string, reason?: string): Result => ({ code, full, text: full.length > 300 ? `${full.slice(0, 300)}…` : full, ...(reason ? { reason } : {}) });
/**
 * One line as the Bot's shell runs it: `vonvon` the bundled CLI, the session's token and scope in the environment, the
 * owner's credential never read. Only these two vonvon variables, as handle-message sets them; nothing of the probe's.
 */
function shell(cli: string, session: Session, line: string): Promise<Result> {
  const env = { ...process.env, VONVON_SESSION: session.token, [SESSION_SCOPE_ENV]: session.scope, FEISHU_CODEX_BRIDGE: '', VONVON_CLI: cli };
  const child = spawn('sh', ['-c', `vonvon() { "${process.execPath}" "$VONVON_CLI" "$@"; }; ${line}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += String(data); });
  child.stderr.on('data', data => { err += String(data); });
  return new Promise(done => child.once('close', code => {
    try {
      const json = JSON.parse(out.trim().split('\n').at(-1) ?? '') as { ok: boolean; error?: { reason?: string; kind?: string; message?: string } } & Record<string, unknown>;
      done(result(code, json.ok ? JSON.stringify(json) : json.error?.message ?? '', json.error ? json.error.reason ?? json.error.kind : undefined));
    } catch { done(result(code, `${out}${err}`.trim())); }
  }));
}

/** What the lines reach: the settings views the protocol's schemas take, groups, members, sessions and one task. */
function service(): AdminService {
  const row = (name: string, chatId: string, projectId: string) => ({ name, chatId, projectId, cwd: `/probe/${name}`, blank: false, kind: 'multi', origin: 'joined', noMention: false,
    mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 1, createdAt: 1 });
  const record = (name: string, chatId: string) => ({ name, chatId, cwd: `/probe/${name}`, kind: 'multi', backend: 'codex-appserver', enabled: true, revision: 'r1' });
  const agent = { ...agentFixture, scope: { kind: 'agent', botId: APP_ID } };
  const section = (value: unknown) => ({ stored: value, effective: value, revision: 'r1', access: { kind: 'writable' }, apply: [{ fields: [], when: 'next-turn', detail: '下一轮生效' }] });
  const options = { tiers: ['qa', 'write', 'full'].map(tier => ({ tier, name: '权限', summary: '说明', native: '' })), strength: '能力说明', fields: [], expanded: { qa: {}, write: {}, full: {} } };
  const project = (name: string, chatId: string) => ({
    scope: { kind: 'project', botId: APP_ID, projectName: name },
    sections: { permission: section({ mode: 'write', guestMode: 'write', network: true, custom: null, options }), response: section({ noMention: false }), model: section({ selection: { kind: 'default' } }) },
    identity: { chatId, backend: 'codex-appserver', cwd: `/probe/${name}`, kind: 'multi' }, members: { openIds: [], revision: 'm1' },
  });
  const projects = [row('a', GROUP_A, PROJECT_A), row('b', GROUP_B, PROJECT_B)];
  const nameOf = (chatId: string) => chatId === GROUP_B ? 'b' : 'a';
  const viewOf = (scope: { kind: string; projectName?: string }) => scope.kind === 'agent' ? agent : project(scope.projectName!, scope.projectName === 'b' ? GROUP_B : GROUP_A);
  const task = (actor: ScheduleActor): ScheduledTaskView => ({
    id: TASK, botId: APP_ID, chatId: GROUP_A, revision: 'r1', name: '构建', instruction: '看一下构建', spec: { kind: 'daily', time: '09:00' }, timeZone: 'UTC', placement: { kind: 'follow' },
    state: 'active', createdBy: actor.kind === 'session' ? { via: 'cli', openId: actor.openId, role: actor.role, ...(actor.name ? { name: actor.name } : {}) } : { via: 'cli' },
    createdAt: 1, updatedAt: 1, nextRunAt: 2, running: false, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], describe: '每天 09:00',
  });
  return {
    listBots: async () => [{ appId: APP_ID, name: 'Probe', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } }],
    listProjects: async (botId: string) => botId === APP_ID ? projects : [],
    listSessions: async (_botId: string, name: string) => [{ threadId: `th_${name}`, chatId: name === 'b' ? GROUP_B : GROUP_A, sessionId: `s_${name}`, summary: '看构建', backend: 'codex-appserver', createdAt: 1, updatedAt: 2 }],
    getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'probe', supported: false }),
    updateStatus: () => null,
    codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }),
    // Read through, never written: a session reaching `workspace` would print the probe's error, not exit 4.
    library: {
      overview: async () => ({ unlinked: [], projects: [[PROJECT_A, 'a', GROUP_A], [PROJECT_B, 'b', GROUP_B]].map(([id, name, chatId]) => ({
        id, name, revision: 1, workspace: { primary: `/probe/${name}`, additional: [] }, bindings: [{ botId: APP_ID, chatId, name, enabled: true }] })) }),
      workspace: async () => { throw new Error('the probe reached library.workspace'); },
    },
    joinedGroups: async () => ({ groups: [{ chatId: GROUP_A, name: 'a', bound: true }, { chatId: GROUP_B, name: 'b', bound: true }] }),
    groupMembers: async () => ({ members: [{ openId: OWNER, name: 'owner' }, { openId: MEMBER, name: 'member' }] }),
    collaboration: async (_botId: string, request: { action: string; chatId?: string; name?: string }) => {
      switch (request.action) {
        case 'project': return { project: record(nameOf(request.chatId!), request.chatId!) };
        case 'history': return { sessions: [{ threadId: 'th_a', chatId: GROUP_A, sessionId: 's_a', summary: '看构建', backend: 'codex-appserver', cwd: '/probe/a', createdAt: 1, updatedAt: 2 }], threads: [], backend: 'codex-appserver' };
        case 'editProject': return { ok: true, project: record(nameOf(request.chatId!), request.chatId!) };
        case 'createProject': return { ok: true, project: record(request.name!, 'oc_probe_new') };
        default: throw new Error(`the probe does not do collaboration.${request.action}`);
      }
    },
    executeSchedule: async (_botId: string, actor: ScheduleActor, request: { action: string; taskId?: string }) => {
      switch (request.action) {
        case 'list': return { kind: 'tasks', tasks: [task(actor)], now: Date.now(), timeZone: 'UTC' };
        case 'delete': return { kind: 'deleted', taskId: request.taskId! };
        case 'runNow': return { kind: 'started', taskId: request.taskId!, runId: 'run_1' };
        default: return { kind: 'task', task: task(actor) };
      }
    },
    settings: {
      read: async (scope: { kind: string; projectName?: string }) => viewOf(scope),
      save: async (edit: { scope: { kind: string; projectName?: string }; section: string }) => ({
        kind: 'saved', section: { scope: edit.scope, section: edit.section, value: section({}) }, effects: [{ fields: [], when: 'next-turn', detail: '下一轮生效' }],
      }),
      act: async (action: { kind: string; projectName?: string }) => ({
        kind: 'saved', view: action.projectName ? project(action.projectName, action.projectName === 'b' ? GROUP_B : GROUP_A) : agent, effects: [], warnings: [],
      }),
      models: async () => { throw new Error('unused'); },
    },
  } as unknown as AdminService;
}

// Last, after every constant above is set: `--bot` is the forked Bot process, anything else the host and its steps.
if (process.argv[2] === '--bot') await bot();
else process.exit(await host(process.argv[2]));
