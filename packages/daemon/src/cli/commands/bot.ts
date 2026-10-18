import QRCode from 'qrcode';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import { botSteps, linuxSteps, serviceStep, toolSteps, type AdminSetupStatus, type Agent, type AgentId, type DesktopSnapshot, type Job, type JobId, type SetupStep, type StepTone } from '@vonvon/protocol';
import { localTime, pickBot, print, printable, want, withDaemon, withoutAvatar, NO_BOT, type Daemon, type Io } from '../daemon-client';

const MARK: Record<StepTone, string> = { success: '✓', warning: '!', danger: '✗', neutral: '·' };
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const PAUSED_BOT = '已暂停：10 分钟内崩溃了 {n} 次，没有自动重启。查完原因后在网页的状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。';

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

function stepLines(step: SetupStep): string[] {
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
  for (const action of step.actions) {
    if (action.kind === 'open') out.push(`    ${action.label}：${action.url}`);
    else if (action.kind === 'serviceInstall') out.push('    运行 vonvon service install');
    else out.push(`    在网页里点「${action.label}」（vonvon open）`);
  }
  return out;
}

/**
 * Exits 0 whatever the steps show; scripts read `ready` from --json. When the checklist read fails it prints what the
 * web page shows then (检测失败, the connection, the tools and the service) and exits 1.
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
  const human = [`${agent.name}（${agent.id}）`, ...agent.paused ? [PAUSED_BOT.replace('{n}', String(agent.paused.crashes))] : [], ...steps.flatMap(stepLines)];
  if (problem === undefined) human.push(left ? `还有 ${left} 步没完成。` : '全部就绪。');
  print(io, human, { bot: withoutAvatar(agent), ...(setup ? { setup } : { problem }), steps, ready: problem === undefined && left === 0 });
  if (problem !== undefined) throw new Error('清单没有读全，稍后重新运行 vonvon bot status。');
}

type Registration = { kind: 'succeeded'; agentId: AgentId } | { kind: 'failed'; message: string; code?: string | undefined }
  | { kind: 'cancelled' } | { kind: 'refused'; message: string } | { kind: 'interrupted' } | { kind: 'lost'; shown: boolean };
export type AddDependencies = {
  /** stdout is a terminal: a QR in a log could be scanned by someone else. */
  tty: boolean;
  /** The QR for a terminal, with its colors. */
  qr: (url: string) => Promise<string>;
  /** Installs a Ctrl-C handler and returns its removal. */
  onInterrupt: (handler: () => void) => () => void;
  exitCode: (code: number) => void;
};
const addDefaults = (): AddDependencies => ({
  tty: Boolean(process.stdout.isTTY),
  // The same package and code as the web page's image (D/server/jobs.ts); half blocks with explicit black and white.
  qr: url => QRCode.toString(url, { type: 'terminal', small: true }),
  onInterrupt: handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; },
  exitCode: code => { process.exitCode = code; },
});
/** The QR expires after 10 minutes and the SDK then fails the job; this only bounds a daemon that never answers. */
const REGISTRATION_WAIT = 15 * 60_000;
const SCAN_UNKNOWN = '不知道扫码有没有完成：运行 vonvon bot list 看看。';

/**
 * Follows one registration job of the web page's `registerAgent` RPC until it ends. Ctrl-C cancels the job (5 s at most),
 * a second one or a dropped connection leaves it to the daemon, which cancels a closed connection's registration.
 */
function follow(c: VonvonClient, io: Io, d: AddDependencies, onStop: (stop: () => void) => void): Promise<Registration> {
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
      if (job.phase === 'running' && !said) { said = true; io.write(`${printable(job.message)}\n`); }
      if (job.phase === 'qr') {
        if (job.status !== status) {
          status = job.status;
          if (status === 'domain_switched') io.write('识别到国际版租户，改用 larksuite.com。\n');
        }
        if (job.url === url) return;
        url = job.url;
        const art = await d.qr(job.url);
        // The QR keeps its escape sequences; the link from Feishu does not.
        io.write(`用飞书 App 扫下面的二维码，建一个新的飞书应用（${localTime(job.expiresAt).slice(11)} 前有效）：\n${art.replace(/\n?$/, '\n')}`
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
    c.run({ type: 'registerAgent' }).then(result => {
      if (result.kind === 'refused') finish({ kind: 'refused', message: result.message });
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
 * when its checklist cannot be read; 1 when the scan fails, is cancelled elsewhere or the connection drops; 130 on Ctrl-C.
 */
export async function runBotAdd(io: Io, daemon: Daemon = withDaemon, overrides: Partial<AddDependencies> = {}): Promise<void> {
  const d: AddDependencies = { ...addDefaults(), ...overrides };
  if (!d.tty) throw new Error('vonvon bot add 要在终端里运行：二维码打进日志会被别人扫走。没有终端的话，用网页注册（vonvon open --print）。');
  let stop = (): void => {};
  try {
    await daemon(async call => {
      const outcome = await call('扫码注册', c => follow(c, io, d, each => { stop = each; }), { ms: REGISTRATION_WAIT, unknown: SCAN_UNKNOWN });
      switch (outcome.kind) {
        case 'interrupted': io.write('已取消扫码。\n'); d.exitCode(130); return;
        case 'failed': throw new Error(`${outcome.message}${outcome.code === 'expired_token' ? '重新运行 vonvon bot add。' : ''}`);
        case 'cancelled': throw new Error('扫码被取消了：可能在网页里又开了一次注册（同一时间只能有一个）。');
        case 'refused': throw new Error(outcome.message);
        case 'lost': throw new Error(outcome.shown ? SCAN_UNKNOWN : '和 daemon 的连接断了，扫码已经取消。重新运行 vonvon bot add。');
        case 'succeeded': break;
      }
      let agent: Agent | undefined;
      let setup: AdminSetupStatus | undefined;
      let problem: string | undefined;
      try {
        agent = (await call('读取快照', c => c.snapshot())).agents.find(each => each.id === outcome.agentId);
        if (agent) setup = want('读取清单状态', await call('读取清单状态', c => c.admin({ type: 'setupStatus', agentId: outcome.agentId }), { feishu: true }), 'setupStatus').status;
      } catch (error) { problem = messageOf(error).replace(/[。.]\s*$/, ''); }
      const human = [`✓ 已保存 Bot：${agent ? `${agent.name}（${agent.id}）` : outcome.agentId}${agent?.enabled ? '，已启用' : ''}。`];
      if (problem !== undefined) human.push(`清单没读到：${problem}。稍后运行 vonvon bot status。`);
      else if (agent && setup) human.push('接下来在飞书开发者后台做完这几步，做完一步运行 vonvon bot status 看进度：', ...botSteps(agent, setup).flatMap(stepLines));
      else human.push('运行 vonvon bot status 看接下来的几步。');
      print(io, human, null);
    });
  } finally { stop(); }
}
