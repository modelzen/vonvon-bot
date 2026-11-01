import { setTimeout as sleep } from 'node:timers/promises';
import type { BridgeImportReply, BridgeImportStep, BridgeImportView, BridgePreflight, MachineRequest } from '@vonvon/protocol';
import { CommandError } from '../command-error';
import { print, printable, withDaemon, type Call, type Daemon, type Io } from '../daemon-client';
import { interrupts, onSigint, type OnInterrupt } from '../interrupt';

export type ImportDeps = {
  daemon: Daemon;
  /** Waits `ms`, or until `signal` aborts. */
  pause: (ms: number, signal: AbortSignal) => Promise<void>;
  onInterrupt: OnInterrupt;
};
const importDeps = (): ImportDeps => ({
  daemon: withDaemon, pause: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined), onInterrupt: onSigint,
});

/** The web page's step names (BridgeImportPanel.tsx). */
const STEP: Record<BridgeImportStep, string> = {
  checking: '再次确认迁移条件', stopping: '停止旧 Bridge', locking: '保护旧 Bot 数据',
  staging: '复制并转换数据', codex: '确认 Codex 可用', hooks: '处理旧审批 Hook',
  moving: '保存导入结果', starting: '连接飞书 Bot', finishing: '完成迁移记录',
  done: '导入完成', 'rolling-back': '正在回滚', 'rolled-back': '已回滚',
  'rollback-failed': '回滚尚未完成', refused: '暂时无法导入',
};
const FINISHED = new Set<BridgeImportStep>(['done', 'rolled-back', 'rollback-failed', 'refused']);
const SECRET: Record<BridgePreflight['bots'][number]['secret'], string> = {
  decryptable: '凭据可以解密', plaintext: '凭据可以读取', missing: '缺少凭据', invalid: '凭据格式异常',
  'cannot-decrypt': '凭据无法解密，先在旧 Bridge 重新扫码', 'external-reference': '凭据在外部，需要处理', unknown: '凭据尚未确认',
};
const NOT_FOUND = '这台设备上没有找到旧版 bridge。';
const ACCEPT = '导入会停掉旧版 bridge，把它的 Bot 和群搬过来。看完上面的变化，加 --accept 再运行一次。';
const BACKGROUND = '导入在后台继续，运行 vonvon import status 查看。';

async function request(call: Call, what: string, action: Extract<MachineRequest, { type: 'bridgeImport' }>['action'], unknown?: string): Promise<BridgeImportReply> {
  const reply = await call(what, c => c.machine(action === 'start' ? { type: 'bridgeImport', action, acceptedChanges: true } : { type: 'bridgeImport', action }), unknown ? { unknown } : {});
  if (reply.type !== 'bridgeImport') throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.type}）。`);
  return reply;
}

function preflightLines(preflight: BridgePreflight | null): string[] {
  if (!preflight) return ['没有检查结果。'];
  const lines = [preflight.canImport ? '可以导入：' : '现在不能导入：'];
  for (const bot of preflight.bots) lines.push(`  ${bot.name}（${bot.appId}）  ${bot.groups ?? '?'} 个群  ${SECRET[bot.secret]}`);
  for (const problem of preflight.problems) lines.push(`  ✗ ${problem.message}`);
  if (preflight.notes.length) lines.push('导入后会变的：', ...preflight.notes.map(note => `  · ${note.message}`));
  return lines;
}
const viewLines = (view: BridgeImportView | null): string[] => !view ? ['还没有导入过。']
  : [`${STEP[view.step]}${view.error ? `：${view.error.message}` : ''}`, ...view.bots.map(bot => `  ${bot.name}（${bot.appId}）`), ...view.canRollback && FINISHED.has(view.step) ? ['运行 vonvon import rollback 再试一次回滚。'] : []];

/** `import detect / preflight / status`: reads; a computer without the old bridge exits 0. */
export async function runImportRead(action: 'detect' | 'preflight' | 'status', io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const reply = await daemon(call => request(call, action === 'detect' ? '找旧版 bridge' : action === 'preflight' ? '检查导入' : '读导入状态', action));
  if (action === 'status') { print(io, viewLines(reply.view), { view: reply.view }); return; }
  if (action === 'preflight') { print(io, preflightLines(reply.preflight), { preflight: reply.preflight }); return; }
  const detection = reply.detection;
  const human = !detection || detection.kind === 'not-found' ? [NOT_FOUND]
    : detection.kind === 'found' ? [detection.message, '运行 vonvon import preflight 看导入会改什么。'] : [detection.message];
  print(io, human, { detection });
}

/**
 * `import start`: without --accept only the changes (2, `confirm_required`), as the web page's confirmation step; with it
 * the import, followed each second until it ends. Ctrl-C leaves it running (there is no cancel: a half import is worse).
 */
export async function runImportStart(accept: boolean, io: Io, overrides: Partial<ImportDeps> = {}): Promise<void> {
  const d = { ...importDeps(), ...overrides };
  await d.daemon(async call => {
    if (!accept) {
      const { preflight } = await request(call, '检查导入', 'preflight');
      if (!io.json) print(io, preflightLines(preflight), {});
      if (!preflight?.canImport) throw new CommandError('refused', '现在不能导入，原因见上面。', { reason: 'preflight-refused', partial: { preflight } });
      throw new CommandError('bad-args', ACCEPT, { reason: 'confirm_required', partial: { preflight } });
    }
    const view = await follow(call, io, d, '开始导入', 'start');
    if (view.step === 'refused') throw new CommandError('refused', `没有导入：${view.error?.message ?? '预检没通过。'}`, { reason: view.error?.code ?? 'refused', partial: { view } });
    if (view.step !== 'done') throw new CommandError('failed', `没有导入成：${STEP[view.step]}${view.error ? `（${view.error.message}）` : ''}。`, { reason: view.step, partial: { view } });
    print(io, viewLines(view), { event: 'result', view });
  });
}

/** `import rollback`: only what the daemon says can be rolled back; followed as `import start`. */
export async function runImportRollback(io: Io, overrides: Partial<ImportDeps> = {}): Promise<void> {
  const d = { ...importDeps(), ...overrides };
  await d.daemon(async call => {
    const { view: before } = await request(call, '读导入状态', 'status');
    if (!before?.canRollback) throw new CommandError('refused', '没有可以回滚的导入。运行 vonvon import status 查看。', { reason: 'cannot_rollback', partial: { view: before } });
    const view = await follow(call, io, d, '回滚导入', 'rollback');
    if (view.step !== 'rolled-back') throw new CommandError('failed', `回滚没有完成：${STEP[view.step]}${view.error ? `（${view.error.message}）` : ''}。`, { reason: view.step, partial: { view } });
    print(io, viewLines(view), { event: 'result', view });
  });
}

/**
 * Sends the start or the rollback, prints each new step (--json: a JSON line each) and asks again every second until
 * the import ends. Ctrl-C from the moment it is sent ends the command at once with 130, the import left to the daemon;
 * a reply, a timeout or a dropped connection after it changes nothing.
 */
async function follow(call: Call, io: Io, d: ImportDeps, what: string, action: 'start' | 'rollback'): Promise<BridgeImportView> {
  const ctrlC = interrupts(d.onInterrupt, () => new CommandError('interrupted', BACKGROUND));
  try {
    let view = (await ctrlC.until(request(call, what, action, BACKGROUND))).view;
    let shown: BridgeImportStep | undefined;
    for (;;) {
      if (!view) throw new CommandError('failed', 'daemon 没有回导入状态。运行 vonvon import status 查看。');
      if (view.step !== shown) {
        shown = view.step;
        io.write(io.json ? `${JSON.stringify({ event: 'step', step: view.step })}\n` : `${printable(STEP[view.step])}…\n`);
      }
      if (FINISHED.has(view.step)) return view;
      await ctrlC.until(d.pause(1000, ctrlC.signal));
      view = (await ctrlC.until(request(call, '读导入状态', 'status'))).view;
    }
  } finally { ctrlC.stop(); }
}
