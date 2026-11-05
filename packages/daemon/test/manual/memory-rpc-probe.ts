/**
 * cli-5-memory-rpc 6, Linux self-test of `vonvon memory` in a Bot's group session: the daemon's API in this process on a
 * temporary data root, the real memory files, and a fake Bot process forked from this file that runs the real
 * `createAgentEntries` over the real admin and host IPC (as test/manual/bot-authz-probe.ts does). Each step runs the
 * bundled CLI with the session's token and `--scope`, as the Bot's shell would. Not a vitest file; nothing real is touched:
 *
 *   (in packages/daemon, protocol and client built: the bundles keep packages external and find them from here)
 *   mkdir -p node_modules/.cache && B=$(mktemp -d -p node_modules/.cache) && T=$(mktemp -d) && mkdir "${T:?}/home"
 *   npx esbuild src/cli/index.ts --bundle --platform=node --format=esm --packages=external --outfile="${B:?}/cli.mjs"
 *   npx esbuild test/manual/memory-rpc-probe.ts --bundle --platform=node --format=esm --packages=external --outfile="${B:?}/probe.mjs"
 *   HOME="${T:?}/home" VONVON_HOME="${T:?}/vh" node "${B:?}/probe.mjs" "${B:?}/cli.mjs"
 *   rm -rf -- "${B:?}" "${T:?}"
 *
 * It prints two lines a step and exits 0 when every step came out as the plan's acceptance says, 1 otherwise.
 */
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { askBotOver, createAdminIpcCaller, createAdminIpcResponder, createHostIpcCaller, createHostIpcResponder, sessionTurnEnded } from '../../src/admin/ipc';
import { libraryOverview } from '../../src/admin/library';
import type { AdminService } from '../../src/admin/service';
import { createAgentEntries, type AgentPlace } from '../../src/agent/entry/registry';
import type { AgentThread } from '../../src/agent/types';
import { paths } from '../../src/config/paths';
import { createSessionTokens } from '../../src/host/session-tokens';
import { startApi } from '../../src/server/http';

const APP_ID = 'cli_probe';
const GROUP_A = 'oc_probe_a';
const PROJECT_A = 'prj_0000000a';
const ADMIN = 'ou_probe_admin';
const MEMBER = 'ou_probe_member';

type Control = { probe: 'open'; id: number; chatId: string; openId: string; text: string };

/** The fake Bot process: the real registry, its group turns opened as the host says, its tokens asked of the host. */
async function bot(): Promise<void> {
  const send = (message: unknown): void => { if (process.connected) process.send?.(message, undefined, {}, () => {}); };
  const hostApi = createHostIpcCaller(send);
  process.on('message', hostApi.onMessage);
  const entries = createAgentEntries({
    appId: APP_ID, isAdmin: id => id === ADMIN, chatSettingsOn: () => true,
    sessions: { revoke: sessionId => { void hostApi.revokeSessionToken(sessionId).catch(() => {}); } },
    memoryPlace: async () => ({ chatProjectId: PROJECT_A }),
  });
  process.on('message', createAdminIpcResponder(async op => {
    if (op.kind !== 'authorizeSessionCall') throw new Error(`the probe's Bot process does not do ${op.kind}`);
    return entries.authorizeSessionCall(op.sessionId, op.action);
  }, send));
  const thread = (): AgentThread => ({
    sessionId: 'probe', isAlive: () => true, close: async () => {}, runStreamed: () => { throw new Error('unused'); }, runGoal: () => { throw new Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {}, compact: async () => ({ compacted: false, usage: null }),
  });
  let message = 0;
  process.on('message', (raw: unknown) => {
    const control = raw as Control;
    if (control?.probe !== 'open') return;
    void (async () => {
      const place: AgentPlace = { kind: 'group', chatId: control.chatId };
      const entry = entries.issue(place);
      const made = thread();
      entry.attach(made);
      const token = await hostApi.issueSessionToken({ appId: APP_ID, place: 'group', chatId: control.chatId, sessionId: entry.sessionId });
      entries.openTurn(made, { requesterOpenId: control.openId, requesterKind: 'user', triggerMessageId: `om_probe_${++message}`, retry: false, initiative: false, wake: false,
        typed: true, triggerText: control.text, requesterName: control.openId.replace('ou_probe_', '') });
      send({ probe: 'done', id: control.id, token });
    })();
  });
  process.once('disconnect', () => process.exit(0));
  send({ probe: 'ready' });
}

async function host(cli: string | undefined): Promise<number> {
  if (!cli) { process.stderr.write('usage: node probe.mjs <bundled cli.mjs>\n'); return 2; }
  await mkdir(join(paths.appDir, 'library'), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.appDir, 'bots', APP_ID), { recursive: true, mode: 0o700 });
  await writeFile(paths.botsFile, JSON.stringify({ version: 1, bots: [{ appId: APP_ID, name: 'Probe', tenant: 'feishu', createdAt: 1 }] }));
  await writeFile(join(paths.appDir, 'library', 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: PROJECT_A, name: 'a', createdAt: 1, revision: 1, workspace: { primary: '/probe/a', additional: [] } }] }));

  const tokens = createSessionTokens();
  const child: ChildProcess = fork(process.argv[1]!, ['--bot'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const caller = createAdminIpcCaller(message => { if (!child.connected) throw new Error('IPC 通道已关闭'); child.send(message); });
  child.on('message', caller.onMessage);
  child.on('message', createHostIpcResponder({ issueSessionToken: async input => tokens.issue(input), revokeSessionToken: async sessionId => { tokens.revoke(sessionId); } },
    message => { if (child.connected) child.send(message); }).onMessage);
  const waiting = new Map<number, (token: string) => void>();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  child.on('message', (raw: unknown) => {
    const reply = raw as { probe?: string; id?: number; token?: string };
    if (reply?.probe === 'ready') ready();
    if (reply?.probe === 'done' && reply.id !== undefined) { waiting.get(reply.id)?.(reply.token!); waiting.delete(reply.id); }
  });
  let next = 0;
  const turn = (openId: string, text: string): Promise<string> => new Promise(resolve => {
    const id = ++next;
    waiting.set(id, resolve);
    child.send({ probe: 'open', id, chatId: GROUP_A, openId, text } satisfies Control);
  });

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
  const scope = ['--scope', `bot=${APP_ID},group=${GROUP_A}`];

  const member = await turn(MEMBER, '记住 周四发版');
  check('群里，成员这一轮：memory add 周四发版 --bot cli_probe（要写 Bot 记忆）', await run(cli, member, ['memory', 'add', '周四发版', '--bot', APP_ID, ...scope]),
    { code: 0, text: `"scope":{"kind":"project","projectId":"${PROJECT_A}"}` });
  const listed = await run(cli, member, ['memory', 'list', '--project', 'a', ...scope]);
  const entry = listed.code === 0 ? (JSON.parse(listed.full) as { items: { id: string; text: string; trust: string; revision: number }[] }).items.find(item => item.text === '周四发版') : undefined;
  const source = listed.code === 0 ? (JSON.parse(listed.full) as { source?: string }).source : undefined;
  check('  … memory list --project a：那一条在本群项目里、不可信，读的是 daemon', { ...listed, text: `source ${source ?? '?'} · ${entry ? `${entry.text} ${entry.trust}` : '没有'}` },
    { code: 0, text: '"source":"daemon"' });
  if (entry?.trust !== 'untrusted') { failed++; process.stdout.write('FAIL   … 那一条应该是 untrusted\n'); }
  const botList = await run(cli, member, ['memory', 'list', '--bot', APP_ID, ...scope]);
  const where = botList.code !== 0 ? botList.full : botList.full.includes('周四发版') ? '在 Bot 记忆里' : '不在 Bot 记忆里';
  check('  … memory list --bot cli_probe：Bot 记忆里没有它', { ...botList, text: where, full: where }, { code: 0, text: '不在 Bot 记忆里' });
  const admin = await turn(ADMIN, '记住 先写结论');
  check('群里，管理员这一轮，原话里有：memory add 先写结论 --bot Probe（名字）', await run(cli, admin, ['memory', 'add', '先写结论', '--bot', 'Probe', ...scope]),
    { code: 0, text: '"scope":{"kind":"bot"}' });
  check('群里，管理员这一轮：memory branch-delete（没有对应的工具，会话一律拒）', await run(cli, admin, ['memory', 'branch-delete', '其他', '--project', 'a', ...scope]),
    { code: 4, reason: 'permission_denied', text: '这个操作不能从 Bot 会话里做。' });
  check('群里，成员这一轮：memory purge --yes（会话一律拒）', await run(cli, member, ['memory', 'purge', entry?.id ?? 'x', '--yes', '--project', 'a', ...scope]),
    { code: 4, reason: 'permission_denied' });
  check('群里，成员这一轮：不带 --scope 的 memory list', await run(cli, member, ['memory', 'list', '--project', 'a']), { code: 4, reason: 'scope_required' });
  check('只有 FEISHU_CODEX_BRIDGE=1、没有令牌：memory list', await run(cli, '', ['memory', 'list', '--project', 'a', ...scope], { FEISHU_CODEX_BRIDGE: '1' }),
    { code: 4, reason: 'session_token_missing' });

  child.kill('SIGTERM');
  await api.close();
  process.stdout.write(failed ? `${failed} 步不对。\n` : '全部符合。\n');
  return failed ? 1 : 0;
}

/** `text` is what a step shows (cut at 300 characters), `full` what it is checked against. */
interface Result { code: number | null; reason?: string; text: string; full: string }
const result = (code: number | null, full: string, reason?: string): Result => ({ code, full, text: full.length > 300 ? `${full.slice(0, 300)}…` : full, ...(reason ? { reason } : {}) });
/** The bundled CLI as the Bot's shell runs it: the token in front of the command, the owner's credential never read. */
function run(cli: string, token: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Result> {
  const child = spawn(process.execPath, [cli, ...args, '--json'], { env: { ...process.env, VONVON_SESSION: token, FEISHU_CODEX_BRIDGE: '', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** What the steps reach: the bot, its one group bound to project `a`, and the real library on the temporary root. */
function service(): AdminService {
  const row = { name: 'a', chatId: GROUP_A, projectId: PROJECT_A, cwd: '/probe/a', blank: false, kind: 'multi', origin: 'joined', noMention: false,
    mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 };
  return {
    listBots: async () => [{ appId: APP_ID, name: 'Probe', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } }],
    listProjects: async (botId: string) => botId === APP_ID ? [row] : [],
    listSessions: async () => [],
    getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'probe', supported: false }),
    updateStatus: () => null,
    codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }),
    // the library's own overview, with the group bound as the bot's projects file would have it
    library: {
      overview: async () => {
        const overview = await libraryOverview();
        return { ...overview, projects: overview.projects.map(project => project.id === PROJECT_A
          ? { ...project, bindings: [{ botId: APP_ID, botName: 'Probe', chatId: GROUP_A, name: 'a', enabled: true }] } : project) };
      },
    },
  } as unknown as AdminService;
}

// Last, after every constant above is set: `--bot` is the forked Bot process, anything else the host and its steps.
if (process.argv[2] === '--bot') await bot();
else process.exit(await host(process.argv[2]));
