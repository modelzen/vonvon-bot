import { expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import type { BridgeImportReply, BridgeImportStep, BridgeImportView, BridgePreflight, MachineRequest } from '@vonvon/protocol';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runImportRead, runImportRollback, runImportStart, type ImportDeps } from '../src/cli/commands/import';

/** cli-8-machine: import detect / preflight / start / status / rollback through a fake client behind the real withDaemon. */
const preflight = (canImport = true): BridgePreflight => ({
  canImport, service: 'running', bundledCodex: 'present', problems: canImport ? [] : [{ code: 'no-bots', message: '旧 Bridge 中没有可导入的 Bot。' }],
  bots: [{ appId: 'cli_a', name: '小助手', groups: 2, directories: [], secret: 'decryptable', hooks: { claude: 'absent', codex: 'installed' }, running: 'running', problems: [] }],
  notes: [{ kind: 'hook', message: '会移除旧的审批 Hook。' }],
});
const view = (step: BridgeImportStep, extra: Partial<BridgeImportView> = {}): BridgeImportView => ({ txId: 't1', step, bots: [{ appId: 'cli_a', name: '小助手' }], notes: [], cleanupPending: false, canRollback: false, ...extra });
const reply = (extra: Partial<BridgeImportReply> = {}): BridgeImportReply => ({ type: 'bridgeImport', detection: { kind: 'found', message: '发现飞书 Codex Bridge。' }, preflight: null, view: null, ...extra });
type Request = Extract<MachineRequest, { type: 'bridgeImport' }>;
function harness(answer: (request: Request) => BridgeImportReply) {
  const machine = vi.fn(async (request: Request) => answer(request));
  const close = vi.fn(async () => {});
  const daemon: Daemon = fn => withDaemon(fn, async () => ({ machine, close }) as unknown as VonvonClient, { local: 50, feishu: 50 });
  let out = '';
  let interrupt = (): void => {};
  const deps: Partial<ImportDeps> = { daemon, pause: async () => {}, onInterrupt: handler => { interrupt = handler; return () => { interrupt = () => {}; }; } };
  return { machine, close, daemon, deps, interrupt: () => interrupt(), sent: () => machine.mock.calls.map(([call]) => call), io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out };
}
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string; partial?: Record<string, unknown> });
/** A daemon whose status walks through `steps`, one per read. */
function walking(steps: BridgeImportStep[], first: Partial<BridgeImportReply> = {}) {
  const queue = [...steps];
  return harness(request => request.action === 'preflight' ? reply({ preflight: preflight() })
    : request.action === 'start' || request.action === 'rollback' ? reply({ view: view('checking'), ...first })
      : reply({ view: view(queue.length > 1 ? queue.shift()! : queue[0]!) }));
}

// main 必败: there was no import start
it('import start without --accept only checks and fails with the changes to read', async () => {
  const h = walking(['done']);
  const error = await caught(runImportStart(false, h.io(true), h.deps));
  expect(error).toMatchObject({ kind: 'bad-args', reason: 'confirm_required', partial: { preflight: preflight() } });
  expect(h.sent()).toEqual([{ type: 'bridgeImport', action: 'preflight' }]);
  expect(h.out()).toBe('');
  const human = walking(['done']);
  expect(await caught(runImportStart(false, human.io(), human.deps))).toMatchObject({ message: '导入会停掉旧版 bridge，把它的 Bot 和群搬过来。看完上面的变化，加 --accept 再运行一次。' });
  expect(human.out()).toBe('可以导入：\n  小助手（cli_a）  2 个群  凭据可以解密\n导入后会变的：\n  · 会移除旧的审批 Hook。\n');
  const refused = harness(() => reply({ preflight: preflight(false) }));
  expect(await caught(runImportStart(false, refused.io(true), refused.deps))).toMatchObject({ kind: 'refused', reason: 'preflight-refused' });
});

// main 必败: there was no import start
it('import start --accept starts with the confirmation and follows each step to done', async () => {
  const h = walking(['staging', 'staging', 'starting', 'done']);
  await runImportStart(true, h.io(true), h.deps);
  expect(h.sent()[0]).toEqual({ type: 'bridgeImport', action: 'start', acceptedChanges: true });
  expect(h.sent().slice(1).every(call => call.action === 'status')).toBe(true);
  const lines = h.out().trimEnd().split('\n').map(line => JSON.parse(line));
  expect(lines.slice(0, -1)).toEqual(['checking', 'staging', 'starting', 'done'].map(step => ({ event: 'step', step })));
  expect(lines.at(-1)).toEqual({ ok: true, event: 'result', view: view('done') });
  expect(h.close).toHaveBeenCalled();
});

// main 必败: there was no import start
it('import start fails as the import ends: rolled back 1, refused 4 with its code', async () => {
  const rolled = walking(['rolling-back', 'rolled-back']);
  expect(await caught(runImportStart(true, rolled.io(), rolled.deps))).toMatchObject({ kind: 'failed', reason: 'rolled-back' });
  expect(rolled.out()).toBe('再次确认迁移条件…\n正在回滚…\n已回滚…\n');
  const refused = walking(['refused'], { view: view('refused', { error: { code: 'destination-conflict', message: 'Vonvon 中已有相同 Bot。' } }) });
  expect(await caught(runImportStart(true, refused.io(), refused.deps))).toMatchObject({ kind: 'refused', reason: 'destination-conflict', message: '没有导入：Vonvon 中已有相同 Bot。' });
});

// main 必败: there was no import start
it('import start leaves the import running on Ctrl-C (130) and sends nothing more', async () => {
  const h = walking(['staging']);
  let reads = 0;
  h.deps.pause = async () => { if (++reads === 2) h.interrupt(); };
  const error = await caught(runImportStart(true, h.io(), h.deps));
  expect(error).toMatchObject({ kind: 'interrupted', message: '导入在后台继续，运行 vonvon import status 查看。' });
  expect(h.sent().map(call => call.action)).toEqual(['start', 'status']);
});

// main 必败: there was no import detect / status / rollback
it('import detect says when there is no old bridge, and rollback needs one to roll back', async () => {
  for (const detection of [null, { kind: 'not-found' as const, message: '没有发现飞书 Codex Bridge 数据。' }]) {
    const h = harness(() => reply({ detection }));
    await runImportRead('detect', h.io(), h.daemon);
    expect(h.out()).toBe('这台设备上没有找到旧版 bridge。\n');
  }
  const status = harness(() => reply({ view: view('rollback-failed', { canRollback: true, error: { code: 'rollback-incomplete', message: '恢复尚未完成。' } }) }));
  await runImportRead('status', status.io(), status.daemon);
  expect(status.out()).toBe('回滚尚未完成：恢复尚未完成。\n  小助手（cli_a）\n运行 vonvon import rollback 再试一次回滚。\n');
  const none = harness(() => reply({ view: view('done') }));
  expect(await caught(runImportRollback(none.io(), none.deps))).toMatchObject({ kind: 'refused', reason: 'cannot_rollback' });
  expect(none.sent()).toEqual([{ type: 'bridgeImport', action: 'status' }]);
  const retry = harness(request => request.action === 'rollback' ? reply({ view: view('rolling-back', { canRollback: true }) })
    : reply({ view: retry.machine.mock.calls.length > 1 ? view('rolled-back') : view('rollback-failed', { canRollback: true }) }));
  await runImportRollback(retry.io(), retry.deps);
  expect(retry.sent().map(call => call.action)).toEqual(['status', 'rollback', 'status']);
  expect(retry.out()).toBe('正在回滚…\n已回滚…\n已回滚\n  小助手（cli_a）\n');
});
