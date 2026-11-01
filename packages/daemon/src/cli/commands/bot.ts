import QRCode from 'qrcode';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import {
  botSteps, deleteAgentDescription, linuxSteps, serviceStep, toolSteps,
  type AdminReply, type AdminSetupStatus, type Agent, type AgentId, type Command, type CommandResult, type DesktopSnapshot, type Job, type JobId, type SetupStep, type StepAction, type StepTone,
} from '@vonvon/protocol';
import type { DirectoryRepair } from '../../config/bots';
import { badArgs, CommandError } from '../command-error';
import { localTime, pickBot, print, printable, want, withDaemon, withoutAvatar, NO_BOT, type Daemon, type Io } from '../daemon-client';

const MARK: Record<StepTone, string> = { success: '✓', warning: '!', danger: '✗', neutral: '·' };
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** 恢复运行 on the web page sends the same setAgentEnabled as `bot enable` (DiagnosticsPanel.tsx). */
const PAUSED_BOT = '已暂停：10 分钟内崩溃了 {n} 次，没有自动重启。查完原因后在网页的状态与诊断页点「恢复运行」，或运行 vonvon bot enable {id}。';

function botLine(agent: Agent, groups: number, hostPaused: boolean): string {
  const state = !agent.enabled ? '没启用' : agent.paused ? `已暂停（10 分钟内崩溃了 ${agent.paused.crashes} 次）`
    : hostPaused ? 'daemon 已暂停' : !agent.running ? '没运行' : '已启用';
  const connection = agent.connection === 'connected' ? '已连接' : agent.connection === 'connecting' || agent.connection === 'reconnecting' ? '连接中' : '未连接';
  const parts = [state, connection, `${groups} 个群`];
  if (agent.activation === 'restartRequired') parts.push('还没按新状态运行');
  if (agent.readError) parts.push(`读取失败：${agent.readError}`);
  return `${agent.name}  ${agent.id}  ${parts.join(' · ')}`;
}

export async function runBotList(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const snapshot = await daemon(call => call('读取快照', c => c.snapshot()));
  const human = snapshot.agents.length
    ? snapshot.agents.map(agent => botLine(agent, snapshot.memberships.filter(m => m.agentId === agent.id).length, Boolean(snapshot.application.crashes?.paused)))
    : [NO_BOT];
  print(io, human, { bots: snapshot.agents.map(withoutAvatar) });
}

/**
 * A step's button as the command that does the same (cli-2-bot 4.4); undefined keeps "在网页里点「…」". One line a kind,
 * and each slice changes only its own: C7 `environment`, C8 `serviceSkip` and `serviceRecheck`. `bot` is the id: a
 * name can hold spaces.
 */
const ACTION_COMMAND: Record<StepAction['kind'], (action: StepAction, bot: string) => string | undefined> = {
  reauthorize: (_a, bot) => `运行 vonvon bot rescan ${bot}`,
  open: a => a.kind === 'open' ? `${a.label}：${a.url}` : undefined,
  enable: (_a, bot) => `运行 vonvon bot enable ${bot}`,
  confirmCallback: (a, bot) => a.kind === 'confirmCallback' ? `运行 vonvon bot callback ${a.confirmed ? 'confirm' : 'unconfirm'} ${bot}` : undefined,
  environment: () => '运行 vonvon env scan',
  codexLogin: () => undefined,
  claudeLogin: () => undefined,
  serviceInstall: () => '运行 vonvon service install',
  serviceSkip: () => '运行 vonvon service skip',
  serviceRecheck: () => '运行 vonvon service status',
};

/** One checklist step as `bot status` prints it; exported for the tests of steps no status gives today. */
export function stepLines(step: SetupStep, bot: string): string[] {
  const out = [`${MARK[step.tone]} ${step.title}：${step.status}`];
  // A failed read's detail is the CLI's own error, which can run to two lines.
  for (const line of step.detail?.split('\n') ?? []) out.push(`    ${line}`);
  for (const item of step.items ?? []) out.push(`    - ${item}`);
  for (const warning of step.warnings ?? []) out.push(`    ${warning}`);
  // Unindented, with a blank line on each side, so the block pastes into a shell as is: an indented closing EOF
  // would not end the AppArmor step's heredoc.
  if (step.commands?.length) out.push('', ...step.commands, '');
  // A finished step's buttons (取消勾选, 检查登录) are not a next step, unless a warning still points at one.
  if (step.done && !step.warnings?.length) return out;
  for (const action of step.actions) out.push(`    ${ACTION_COMMAND[action.kind](action, bot) ?? `在网页里点「${action.label}」（vonvon open）`}`);
  return out;
}

/**
 * Exits 0 whatever the steps show; scripts read `ready` from --json. When the checklist read fails it prints what the
 * web page shows then (检测失败, the connection, the tools and the service) and exits 1; --json has them in `error.partial`.
 */
export async function runBotStatus(wanted: string | undefined, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { agent, setup, problem, tools, linux, service } = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = pickBot(snapshot.agents, wanted);
    let setup: AdminSetupStatus | undefined;
    let problem: string | undefined;
    try { setup = want('读取清单状态', await call('读取清单状态', c => c.admin({ type: 'setupStatus', agentId: agent.id }), { feishu: true }), 'setupStatus').status; }
    catch (error) { problem = messageOf(error); }
    return { agent, setup, problem, tools: toolSteps(snapshot.tools), linux: snapshot.application.platform === 'linux' ? linuxSteps(snapshot.tools) : [], service: serviceStep(snapshot.application) };
  });
  const bot = botSteps(agent, setup, problem);
  // The Linux steps and the service step are not required: they do not count toward `left` or `ready`.
  const steps = [...bot, ...tools.steps, ...linux, service];
  const left = bot.filter(step => !step.done).length + (tools.ready ? 0 : 1);
  const human = [`${agent.name}（${agent.id}）`, ...agent.paused ? [PAUSED_BOT.replace('{n}', String(agent.paused.crashes)).replace('{id}', agent.id)] : [], ...steps.flatMap(step => stepLines(step, agent.id))];
  const json = { bot: withoutAvatar(agent), ...(setup ? { setup } : { problem }), steps, ready: problem === undefined && left === 0 };
  if (problem === undefined) {
    human.push(left ? `还有 ${left} 步没完成。` : '全部就绪。');
    print(io, human, json);
    return;
  }
  if (!io.json) print(io, human, json);
  throw new CommandError('failed', '清单没有读全，稍后重新运行 vonvon bot status。', { partial: json });
}

type Registration = { kind: 'succeeded'; agentId: AgentId } | { kind: 'failed'; message: string; code?: string | undefined }
  | { kind: 'cancelled' } | { kind: 'refused'; message: string; code: string } | { kind: 'interrupted' } | { kind: 'lost'; shown: boolean };
export type AddDependencies = {
  /** stdout is a terminal: a QR in a log could be scanned by someone else. */
  tty: boolean;
  /** The QR for a terminal, with its colors. */
  qr: (url: string) => Promise<string>;
  /** Installs a Ctrl-C handler and returns its removal. */
  onInterrupt: (handler: () => void) => () => void;
};
const addDefaults = (): AddDependencies => ({
  tty: Boolean(process.stdout.isTTY),
  // The same package and code as the web page's image (D/server/jobs.ts); half blocks with explicit black and white.
  qr: url => QRCode.toString(url, { type: 'terminal', small: true }),
  onInterrupt: handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; },
});
/** --json: one JSON object per line, `event` naming it; the last line is the result, `ok: true`, or the failure. */
const emit = (io: Io, event: object): void => io.write(`${JSON.stringify(event)}\n`);
/** The QR expires after 10 minutes and the SDK then fails the job; this only bounds a daemon that never answers. */
const REGISTRATION_WAIT = 15 * 60_000;
const SCAN_UNKNOWN = '不知道扫码有没有完成：运行 vonvon bot list 看看。';

/** What `bot add` and `bot rescan` say differently (cli-2-bot 4.2); the rest is the same follow(). */
type Scan = { start: Command; purpose: string; again: string };

/**
 * Follows one registration job, started by `start` as the web page does (`registerAgent`, or `refreshAgentCredentials`
 * for a bot's new credentials), until it ends. Ctrl-C cancels the job (5 s at most), a second one or a dropped
 * connection leaves it to the daemon, which cancels a closed connection's registration.
 */
function follow(c: VonvonClient, io: Io, d: AddDependencies, scan: Scan, onStop: (stop: () => void) => void): Promise<Registration> {
  return new Promise((resolve, reject) => {
    let jobId: JobId | undefined;
    let latest: DesktopSnapshot | undefined;
    let url: string | undefined;
    let status: string | undefined;
    let said = false;
    let interrupted = false;
    let settled = false;
    let queue = Promise.resolve();
    const stops: Array<() => void> = [];
    const stop = (): void => { for (const each of stops.splice(0)) each(); };
    onStop(stop);
    const settle = (end: () => void): void => { if (!settled) { settled = true; stop(); end(); } };
    const finish = (outcome: Registration): void => settle(() => resolve(outcome));
    const fail = (error: unknown): void => settle(() => reject(error));
    async function show(job: Job): Promise<void> {
      if (settled) return;
      if (job.phase === 'running' && !said) { said = true; if (io.json) emit(io, { event: 'phase', phase: job.phase, message: job.message }); else io.write(`${printable(job.message)}\n`); }
      if (job.phase === 'qr') {
        const switched = job.status !== status;
        if (switched) {
          status = job.status;
          if (status === 'domain_switched' && !io.json) io.write('识别到国际版租户，改用 larksuite.com。\n');
        }
        if (io.json && (switched || job.url !== url)) emit(io, { event: 'qr', url: job.url, expiresAt: job.expiresAt, ...(job.status ? { status: job.status } : {}) });
        if (job.url === url) return;
        url = job.url;
        if (io.json) return;
        const art = await d.qr(job.url);
        // The QR keeps its escape sequences; the link from Feishu does not.
        io.write(`用飞书 App 扫下面的二维码，${scan.purpose}（${localTime(job.expiresAt).slice(11)} 前有效）：\n${art.replace(/\n?$/, '\n')}`
          + `扫不了的话，在手机飞书里打开：${printable(job.url)}\n等你在飞书里确认…（Ctrl-C 取消）\n`);
      }
      if (job.phase === 'succeeded') finish(job.agentId ? { kind: 'succeeded', agentId: job.agentId } : { kind: 'failed', message: 'daemon 没说存成了哪个 Bot。运行 vonvon bot list 看看。' });
      if (job.phase === 'failed') finish({ kind: 'failed', message: job.message, code: job.code });
      if (job.phase === 'cancelled' && !interrupted) finish({ kind: 'cancelled' });
    }
    const observe = (snapshot: DesktopSnapshot): void => {
      latest = snapshot;
      const job = jobId === undefined ? undefined : snapshot.jobs.find(each => each.id === jobId);
      if (job) queue = queue.then(() => show(job)).catch(fail);
    };
    stops.push(c.watchSnapshots(observe));
    stops.push(c.onError(error => { if (error instanceof ConnectionError) finish({ kind: 'lost', shown: url !== undefined }); }));
    stops.push(d.onInterrupt(() => {
      if (interrupted || jobId === undefined) { finish({ kind: 'interrupted' }); return; }
      interrupted = true;
      let timer: NodeJS.Timeout | undefined;
      const wait = new Promise<void>(done => { timer = setTimeout(done, 5_000); });
      void Promise.race([c.run({ type: 'cancelJob', jobId }).catch(() => undefined), wait]).then(() => { clearTimeout(timer); finish({ kind: 'interrupted' }); });
    }));
    c.run(scan.start).then(result => {
      if (result.kind === 'refused') finish({ kind: 'refused', message: result.message, code: result.code });
      else if (result.kind !== 'started') fail(new Error(`daemon 回了意外的结果（${result.kind}）。`));
      else { jobId = result.jobId; if (latest) observe(latest); }
    }, error => {
      if (error instanceof ConnectionError) finish({ kind: 'lost', shown: false });
      else fail(error);
    });
  });
}

/**
 * `vonvon bot add`: the web page's QR registration in a terminal (3.10 step 5). Exits 0 once the bot is saved, even
 * when its checklist cannot be read; 1 when the scan fails or is cancelled elsewhere, 3 when the connection drops before
 * the QR and 6 after it, 130 on Ctrl-C. --json (devices 8.1) prints JSON Lines: the steps, each QR link, then the result.
 */
export async function runBotAdd(io: Io, daemon: Daemon = withDaemon, overrides: Partial<AddDependencies> = {}): Promise<void> {
  await runRegistration('add', undefined, io, daemon, overrides);
}

/** `vonvon bot rescan`: 重新扫码 for a bot's new Feishu credentials, its groups, sessions and settings kept; as `bot add` otherwise. */
export async function runBotRescan(wanted: string | undefined, io: Io, daemon: Daemon = withDaemon, overrides: Partial<AddDependencies> = {}): Promise<void> {
  await runRegistration('rescan', wanted, io, daemon, overrides);
}

async function runRegistration(kind: 'add' | 'rescan', wanted: string | undefined, io: Io, daemon: Daemon, overrides: Partial<AddDependencies>): Promise<void> {
  const d: AddDependencies = { ...addDefaults(), ...overrides };
  // --json is asked for by name, like `pair --json`: the link is the output, kept out of logs by whoever runs it
  if (!d.tty && !io.json) {
    throw badArgs(`vonvon bot ${kind} 要在终端里运行：二维码打进日志会被别人扫走。脚本里用 vonvon bot ${kind} --json（输出别进日志），或者${kind === 'add' ? '用网页注册' : '在网页里重新扫码'}（vonvon open --print）。`);
  }
  let stop = (): void => {};
  try {
    await daemon(async call => {
      let scan: Scan = { start: { type: 'registerAgent' }, purpose: '建一个新的飞书应用', again: 'vonvon bot add' };
      let refreshed: Agent | undefined;
      if (kind === 'rescan') {
        refreshed = pickBot((await call('读取快照', c => c.snapshot())).agents, wanted);
        scan = { start: { type: 'refreshAgentCredentials', agentId: refreshed.id }, purpose: `给「${printable(refreshed.name)}」换一套飞书凭据`, again: `vonvon bot rescan ${refreshed.id}` };
      }
      const outcome = await call(kind === 'add' ? '扫码注册' : '重新扫码', c => follow(c, io, d, scan, each => { stop = each; }), { ms: REGISTRATION_WAIT, unknown: SCAN_UNKNOWN });
      switch (outcome.kind) {
        case 'interrupted': throw new CommandError('interrupted', '已取消扫码。');
        case 'failed': throw new CommandError('failed', `${outcome.message}${outcome.code === 'expired_token' ? `重新运行 ${scan.again}。` : ''}`, outcome.code ? { reason: outcome.code } : {});
        case 'cancelled': throw new CommandError('failed', '扫码被取消了：可能在网页里又开了一次注册（同一时间只能有一个）。', { reason: 'cancelled' });
        case 'refused': throw new CommandError('failed', outcome.message, { reason: outcome.code });
        case 'lost': throw outcome.shown ? new CommandError('outcome-unknown', SCAN_UNKNOWN) : new CommandError('connection', `和 daemon 的连接断了，扫码已经取消。重新运行 ${scan.again}。`);
        case 'succeeded': break;
      }
      let agent: Agent | undefined;
      let setup: AdminSetupStatus | undefined;
      let problem: string | undefined;
      try {
        agent = (await call('读取快照', c => c.snapshot())).agents.find(each => each.id === outcome.agentId);
        if (agent) setup = want('读取清单状态', await call('读取清单状态', c => c.admin({ type: 'setupStatus', agentId: outcome.agentId }), { feishu: true }), 'setupStatus').status;
      } catch (error) { problem = messageOf(error).replace(/[。.]\s*$/, ''); }
      const human = [refreshed
        ? `✓ 已更新「${(agent ?? refreshed).name}」的飞书凭据。`
        : `✓ 已保存 Bot：${agent ? `${agent.name}（${agent.id}）` : outcome.agentId}${agent?.enabled ? '，已启用' : ''}。`];
      if (problem !== undefined) human.push(`清单没读到：${problem}。稍后运行 vonvon bot status。`);
      else if (agent && setup) human.push('接下来在飞书开发者后台做完这几步，做完一步运行 vonvon bot status 看进度：', ...botSteps(agent, setup).flatMap(step => stepLines(step, agent.id)));
      else human.push('运行 vonvon bot status 看接下来的几步。');
      print(io, human, { event: 'result', agentId: outcome.agentId, ...(agent ? { bot: withoutAvatar(agent) } : {}), ...(setup ? { setup } : {}), ...(problem === undefined ? {} : { problem }) });
    });
  } finally { stop(); }
}

/** A write's reply that is not the one asked for: the daemon's refusal in its own words, exit 4 with its code as `reason`. */
function notDone(what: string, reply: CommandResult | AdminReply, unknown: string): CommandError {
  if (reply.kind === 'refused') return new CommandError('refused', reply.message, { reason: reply.code });
  if (reply.kind === 'outcomeUnknown') return new CommandError('outcome-unknown', `${what}没有确认：${reply.message}\n${unknown}`);
  return new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}

const ENABLE_UNKNOWN = '可能已经改了，运行 vonvon bot list 查看。';
/**
 * `vonvon bot enable / disable` (cli-2-bot 4.2): the web page's switch, sent even when the bot is already so (the daemon
 * is idempotent); `enable` is also 恢复运行 for a bot paused after crashing. A change saved that runs only after a restart
 * (`activationPending`) exits 0, as the web page shows it.
 */
export async function runBotEnable(enabled: boolean, wanted: string | undefined, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const verb = enabled ? '启用' : '停用';
  const { before, result, snapshot } = await daemon(async call => {
    const before = pickBot((await call('读取快照', c => c.snapshot())).agents, wanted);
    const result = await call(`${verb} Bot`, c => c.run({ type: 'setAgentEnabled', agentId: before.id, enabled }), { unknown: ENABLE_UNKNOWN });
    if (result.kind !== 'applied' && result.kind !== 'activationPending') throw notDone(`${verb} Bot`, result, ENABLE_UNKNOWN);
    // the daemon rebuilt its snapshot before it answered the write (cli-1-conventions 第 3 节)
    return { before, result, snapshot: await call('读取快照', c => c.snapshot()) };
  });
  const agent = snapshot.agents.find(each => each.id === before.id) ?? before;
  const bot = withoutAvatar(agent);
  if (result.kind === 'activationPending') { print(io, [result.message], { bot, activation: 'restartRequired', message: result.message }); return; }
  const groups = snapshot.memberships.filter(m => m.agentId === agent.id).length;
  print(io, [`已${verb}「${agent.name}」。`, botLine(agent, groups, Boolean(snapshot.application.crashes?.paused))], { bot, activation: 'active' });
}

const REMOVE_UNKNOWN = '可能已经移除了，运行 vonvon bot list 查看。';
/**
 * `vonvon bot remove` (cli-2-bot 4.2): asks nothing. Without --yes it sends no deleteAgent and fails (2) with what the web
 * page's confirmation says; with it a bot still enabled is refused (4) before anything is sent.
 */
export async function runBotRemove(wanted: string, options: { yes?: boolean | undefined }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const removed = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = pickBot(snapshot.agents, wanted);
    if (!options.yes) {
      const groups = snapshot.memberships.filter(m => m.agentId === agent.id).length;
      // counted as the web page counts them, and left out like there when they cannot be read
      let memories: number | undefined;
      try {
        const reply = await call('读取 Bot 记忆', c => c.memory({ type: 'list', scope: { kind: 'bot', botId: agent.id } }));
        if (reply.kind === 'list') memories = reply.used;
      } catch { /* the description leaves the count out */ }
      throw new CommandError('bad-args', `${deleteAgentDescription(agent.name, groups, memories)}确认后加 --yes 再运行一次。`, {
        reason: 'confirm_required',
        partial: { bot: { id: agent.id, name: agent.name, enabled: agent.enabled, running: agent.running }, groups, ...(memories === undefined ? {} : { botMemories: memories }) },
      });
    }
    if (agent.enabled) throw new CommandError('refused', `「${agent.name}」还启用着：先运行 vonvon bot disable ${agent.id}，等它停下来再移除。`, { reason: 'bot_enabled' });
    const result = await call('移除 Bot', c => c.run({ type: 'deleteAgent', agentId: agent.id }), { unknown: REMOVE_UNKNOWN });
    if (result.kind !== 'applied') throw notDone('移除 Bot', result, REMOVE_UNKNOWN);
    return { id: agent.id, name: agent.name };
  });
  print(io, [`已移除「${removed.name}」。`], { removed });
}

type CardCallback = AdminSetupStatus['cardCallback'];
/** The card callback in two lines: what this computer recorded, then what the developer console has (if it was read). */
function callbackLines({ confirmed, verifiedAt, configuration }: CardCallback): string[] {
  const received = verifiedAt ? `已收到过真实回调（${localTime(verifiedAt)}）` : confirmed ? '你已确认配置，还没收到真实回调' : '还没确认';
  const remote = configuration?.state === 'configured' ? '已配置（长连接）' : configuration?.state === 'missing' ? '没配置'
    : configuration?.state === 'wrong-mode' ? `配成了 ${configuration.mode ?? 'webhook'}，要改成长连接` : '没检查';
  return [`卡片回调：${received}`, `开发者后台：${remote}`];
}

const CALLBACK_UNKNOWN = '可能已经改了，运行 vonvon bot callback status 查看。';
/** `vonvon bot callback status / confirm / unconfirm`: the web page's 我已配置 and 撤销确认, then the status read again. */
export async function runBotCallback(action: 'status' | 'confirm' | 'unconfirm', wanted: string | undefined, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { agent, cardCallback } = await daemon(async call => {
    const agent = pickBot((await call('读取快照', c => c.snapshot())).agents, wanted);
    if (action !== 'status') {
      const what = action === 'confirm' ? '确认卡片回调' : '撤销卡片回调的确认';
      const reply = await call(what, c => c.admin({ type: 'confirmCardCallback', agentId: agent.id, confirmed: action === 'confirm' }), { unknown: CALLBACK_UNKNOWN });
      if (reply.kind !== 'applied') throw notDone(what, reply, CALLBACK_UNKNOWN);
    }
    const reply = await call('读取卡片回调', c => c.admin({ type: 'cardCallbackStatus', agentId: agent.id }));
    return { agent, cardCallback: want('读取卡片回调', reply, 'cardCallbackStatus').cardCallback };
  });
  print(io, callbackLines(cardCallback), { bot: withoutAvatar(agent), ...(action === 'status' ? {} : { confirmed: action === 'confirm' }), cardCallback });
}

/**
 * `vonvon bot repair-dir`: the bot's directories, recorded again where they are now (s36c2d). It writes bots.json under
 * the lock the daemon uses, so it runs with or without one.
 */
export async function runBotRepairDir(wanted: string, io: Io, repair?: (wanted: string) => Promise<DirectoryRepair>): Promise<void> {
  const result = await (repair ?? (await import('../../config/bots')).repairBotDirectories)(wanted);
  const human = [`✓ 已按现在的位置重新记录「${result.handle}」的 ${result.recorded} 个目录。`];
  if (result.missing) human.push(`另有 ${result.missing} 个目录不在了，下次用到时会重建一个空的。`);
  if (result.others.length) human.push(`同一个项目根目录下的 bot 也要各运行一次：${result.others.map(handle => `vonvon bot repair-dir ${handle}`).join('；')}。`);
  print(io, human, result);
}
