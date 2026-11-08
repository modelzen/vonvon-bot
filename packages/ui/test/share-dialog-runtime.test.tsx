import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type AdminReply, type AdminRequest, type DesktopSnapshot, type ShareTarget} from '@vonvon/protocol';
import {LOCAL_ACTIVE_DEVICE, type ActiveDevice, type ShareRecording, type ShareShell} from '../src/client-context';
import type {NowProvider} from '../src/NowUsage';
import type {Usage} from '../src/management/usage-data';
import {ShareCard} from '../src/ShareCard';
import {ShareDialog} from '../src/ShareDialog';
import type {ShareModel} from '../src/share-model';
import {SHARE_OLD_DAEMON} from '../src/share-send';

// The actual dialog, its hooks run by hand; no DOM. Closing it is its unmount: the effects' cleanups.
type Slot = {states: unknown[]; refs: Array<{current: unknown}>; effects: Array<{deps?: unknown[]; cleanup?: () => void}>; memos: Array<{deps?: unknown[]; value: unknown}>; state: number; ref: number; effect: number; memo: number};
const h = vi.hoisted(() => ({
  slots: {} as Record<string, Slot>, active: '', pending: [] as Array<() => void>,
  client: {admin: vi.fn()}, device: undefined as unknown, judge: {read: {kind: 'loading'}, readAt: undefined},
}));
vi.mock('react', async original => {
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, at) => Object.is(value, b[at]));
  const memo = (factory: () => unknown, deps?: unknown[]) => {
    const slot = h.slots[h.active]!; const index = slot.memo++; const old = slot.memos[index];
    if (old && same(old.deps, deps)) return old.value;
    const value = factory(); slot.memos[index] = {deps, value}; return value;
  };
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const slot = h.slots[h.active]!; const index = slot.state++; if (!(index in slot.states)) slot.states[index] = typeof initial === 'function' ? initial() : initial; return [slot.states[index], (next: unknown) => {slot.states[index] = typeof next === 'function' ? next(slot.states[index]) : next;}];},
    useRef: (initial: unknown) => {const slot = h.slots[h.active]!; return slot.refs[slot.ref++] ??= {current: initial};},
    useMemo: memo,
    useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
      const slot = h.slots[h.active]!; const index = slot.effect++; const old = slot.effects[index];
      if (old && same(old.deps, deps)) return;
      h.pending.push(() => {old?.cleanup?.(); slot.effects[index] = {deps, cleanup: effect() || undefined};});
    },
  };
});
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(),
  useClient: () => h.client, useActiveDevice: () => h.device, useDevicesState: () => undefined, useShellCapabilities: () => undefined}));
vi.mock('../src/management/JudgeUsage', async original => ({...await original<typeof import('../src/management/JudgeUsage')>(), useJudgeUsage: () => h.judge}));

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.footer)] : [];}
function text(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return isValidElement<{children?: ReactNode}>(node) ? text(node.props.children) : '';}
const button = (all: Element[], label: string) => all.find(node => typeof node.props.onClick === 'function' && text(node.props.children) === label)!;
const card = (all: Element[]) => all.find(node => node.type === ShareCard)!.props.model as ShareModel;
const shownUsage = (model: ShareModel) => model.usage.map(item => item.kind === 'provider' ? item.id : item.kind);
const settle = () => new Promise(done => setTimeout(done, 0));

const snapshot = {
  attentionModel: 'group', revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [], groups: [], memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'},
} as unknown as DesktopSnapshot;
// This computer's day, as the usage panels date them.
const today = (() => {const now = new Date(); return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);})();
const usage = (): Usage => ({profile: {topInvocations: [], dailyBuckets: [{date: today, tokens: 100}], statsAsOf: today}, usage: {main: {}, extras: [], fetchedAt: 1}} as unknown as Usage);
const codex: NowProvider = {id: 'codex-appserver', name: 'Codex', account: {kind: 'subscription'}, data: usage()};
const claudeReading: NowProvider = {id: 'claude-agent', name: 'Claude Code', account: {kind: 'subscription'}, loading: true};
const claude: NowProvider = {...claudeReading, loading: false, data: usage()};
const bots: ShareTarget[] = [{agentId: agentIdSchema.parse('cli_a'), name: 'Vonvon', connected: true, recipients: [{openId: 'ou_a1', name: '林夏', creator: true}]}];

function shell() {
  const finishing: Array<() => void> = [];
  let next = 0;
  const share = {
    record: vi.fn((_model: unknown, _progress?: (fraction: number) => void) => new Promise<ShareRecording>(resolve => {
      const id = `r${++next}`;
      finishing.push(() => resolve({id, bytes: 10, sha256: 'a'.repeat(64), width: 904, height: 1050, durationMs: 4000}));
    })),
    copy: vi.fn(async (_id: string) => ({path: '/share/now.gif'})),
    reveal: vi.fn(async (_path: string) => undefined),
    bytes: vi.fn(async (_id: string) => new Uint8Array(10)),
    discard: vi.fn(async (_id: string) => undefined),
    cancel: vi.fn(async () => undefined),
  } satisfies ShareShell;
  return {share, finish: () => finishing.shift()!()};
}
function render(share: ShareShell, providers: readonly NowProvider[]) {
  const slot = h.slots.dialog ??= {states: [], refs: [], effects: [], memos: [], state: 0, ref: 0, effect: 0, memo: 0};
  slot.state = slot.ref = slot.effect = slot.memo = 0; h.active = 'dialog';
  const all = nodes(ShareDialog({share, snapshot, providers, onClose: () => undefined}));
  for (const effect of h.pending.splice(0)) effect();
  return all;
}
function close() {
  for (const effect of h.slots.dialog?.effects ?? []) effect.cleanup?.();
  delete h.slots.dialog;
}
const sending = {...LOCAL_ACTIVE_DEVICE, capabilities: ['device', 'share.gif']} satisfies ActiveDevice;

beforeEach(() => {
  h.slots = {}; h.pending = []; h.device = sending;
  h.client.admin.mockReset().mockImplementation(async (request: AdminRequest): Promise<AdminReply> =>
    request.type === 'shareTargets' ? {kind: 'shareTargets', bots} : {kind: 'refused', message: `${request.type} 不该发`});
  vi.stubGlobal('localStorage', {getItem: () => null, setItem: () => undefined});
});
afterEach(() => {close(); vi.unstubAllGlobals();});

it('stops the recording and copies nothing once the dialog is closed while recording; one that still ends is discarded', async () => {
  const {share, finish} = shell();
  button(render(share, [codex]), '复制').props.onClick();
  expect(button(render(share, [codex]), '正在生成…')).toBeDefined();
  close();
  expect(share.cancel).toHaveBeenCalledOnce();
  finish();
  await settle();
  expect(share.copy).not.toHaveBeenCalled();
  expect(share.discard).toHaveBeenCalledExactlyOnceWith('r1');
});

it('stops nothing when the dialog closes after its recording is done', async () => {
  const {share, finish} = shell();
  button(render(share, [codex]), '复制').props.onClick();
  finish();
  await settle();
  expect(share.copy).toHaveBeenCalledExactlyOnceWith('r1');
  close();
  await settle();
  expect(share.cancel).not.toHaveBeenCalled();
  expect(share.discard).toHaveBeenCalledExactlyOnceWith('r1');
});

it('sends nothing once the dialog is closed while recording', async () => {
  const {share, finish} = shell();
  render(share, [codex]);
  await settle();
  const send = button(render(share, [codex]), '发到飞书');
  expect(send.props.disabled).toBe(false);
  send.props.onClick();
  expect(share.record).toHaveBeenCalledOnce();
  close();
  expect(share.cancel).toHaveBeenCalledOnce();
  finish();
  await settle();
  expect(share.bytes).not.toHaveBeenCalled();
  expect(h.client.admin.mock.calls.map(([request]) => (request as AdminRequest).type)).toEqual(['shareTargets']);
  expect(share.discard).toHaveBeenCalledExactlyOnceWith('r1');
});

it('takes a device without share.gif for an old daemon, never asking it', async () => {
  h.device = LOCAL_ACTIVE_DEVICE;
  const {share} = shell();
  render(share, [codex]);
  await settle();
  const send = button(render(share, [codex]), '发到飞书');
  expect(send.props).toMatchObject({disabled: true, title: SHARE_OLD_DAEMON});
  expect(h.client.admin).not.toHaveBeenCalled();
});

it('copies what the preview showed at the click, though a usage reply comes in while recording', async () => {
  const {share, finish} = shell();
  const shown = card(render(share, [codex, claudeReading]));
  expect(shownUsage(shown)).toEqual(['codex-appserver']);
  button(render(share, [codex, claudeReading]), '复制').props.onClick();
  expect(share.record).toHaveBeenCalledExactlyOnceWith(shown, expect.any(Function));
  // Claude Code's usage, read only now: the preview stays what is being recorded.
  expect(shownUsage(card(render(share, [codex, claude])))).toEqual(['codex-appserver']);
  finish();
  await settle();
  expect(share.copy).toHaveBeenCalledExactlyOnceWith('r1');
  expect(share.discard).not.toHaveBeenCalled();
  const after = render(share, [codex, claude]);
  expect(after.find(node => node.props.toast)?.props.toast).toEqual({kind: 'copied', path: '/share/now.gif'});
  expect(button(after, '复制')).toBeDefined();
  expect(share.record).toHaveBeenCalledOnce();
});
