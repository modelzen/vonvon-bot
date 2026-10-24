import {beforeEach, expect, it, vi} from 'vitest';
import type {AgentId} from '@vonvon/protocol';
import {useRoleMap} from '../src/role-map';
import {MapInlineEditor} from '../src/MapInlineEditor';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({states: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ri: 0, mi: 0, ei: 0, client: {settings: vi.fn()}}));
vi.mock('react', async original => {
  const memo = (make: () => unknown, deps?: unknown[]) => {const i = h.mi++; const old = h.memos[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return old.value; const value = make(); h.memos[i] = {value, deps}; return value;};
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const i = h.si++; if (!(i in h.states)) h.states[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.states[i], (next: unknown) => {h.states[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.states[i]) : next;}];},
    useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
    useMemo: memo, useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});},
  };
});
vi.mock('../src/client-context', () => ({useClient: () => h.client}));
vi.mock('../src/settings/DraftGuard', () => ({useInlineDraft: vi.fn()}));

const botId = 'cli_a' as AgentId;
const scope = {kind: 'agent' as const, botId};
const read = (revision = 'r1', access: object = {kind: 'writable'}) => ({kind: 'view', view: {scope, administrators: {}, sections: {role: {stored: {identity: '原身份', notes: '原说明'}, revision, access}}, roleInfo: {draft: '应用名草稿', integrity: 'ok'}}});
const saved = (revision = 'r2') => ({kind: 'saved', result: {kind: 'saved', section: {value: {revision}}}});
function render() {h.si = h.ri = h.mi = h.ei = 0; const result = useRoleMap(scope); for (const effect of h.pending.splice(0)) effect(); return result;}
async function flush() {for (let i = 0; i < 8; i++) await Promise.resolve();}
function editor() {const content = render().content('identity', 'identity'); expect(content?.type).toBe(MapInlineEditor); return content!.props;}
beforeEach(() => {h.states = []; h.refs = []; h.memos = []; h.effects = []; h.pending = []; vi.clearAllMocks(); h.client.settings.mockResolvedValue(read());});

it('edits Bot identity in the node, starts with the registration draft, and freezes its revision', async () => {
  render(); await flush(); render().beginEdit('identity');
  expect(editor().value).toBe('应用名草稿');
  expect(await editor().onCommit('a'.repeat(501))).toBe(false);
  expect(h.client.settings.mock.calls.filter(([request]) => request.type === 'save')).toHaveLength(0);
  expect(render().statusNodes.some(node => String(node.label).includes('最多 500 字'))).toBe(true);
  h.client.settings.mockResolvedValueOnce(saved());
  expect(await editor().onCommit('新身份')).toBe(true);
  expect(h.client.settings).toHaveBeenCalledWith({type: 'save', edit: {scope, section: 'role', patch: {identity: '新身份'}, revision: 'r1'}});
  expect(render().content('identity', 'identity')).toBeUndefined();
});

it('rejects oversized notes and readonly settings without opening an editor', async () => {
  h.client.settings.mockResolvedValue(read('r1', {kind: 'readonly', message: '只有主人可改'}));
  render(); await flush(); render().beginEdit('identity');
  expect(render().content('identity', 'identity')).toBeUndefined();
  expect(render().statusNodes.map(node => node.label)).toContain('只有主人可改');
  h.states = []; h.refs = []; h.memos = []; h.effects = []; h.pending = [];
  h.client.settings.mockResolvedValue(read()); render(); await flush(); render().beginEdit('notes');
  const content = render().content('notes', 'notes')!;
  expect(await content.props.onCommit('a'.repeat(8001))).toBe(false);
  expect(h.client.settings.mock.calls.filter(([request]) => request.type === 'save')).toHaveLength(0);
});

it('shows latest content after conflict and requires an explicit rebase action before retry', async () => {
  h.client.settings.mockImplementation(async (request: {type: string}) => request.type === 'read' ? read() : h.client.settings.mock.calls.filter(([entry]) => entry.type === 'save').length <= 2
    ? {kind: 'saved', result: {kind: 'conflict', current: {value: {revision: 'r2', stored: {identity: '他人修改'}}}}} : saved('r3'));
  render(); await flush(); render().beginEdit('identity');
  const first = editor(); const key = render().content('identity', 'identity')!.key;
  expect(await first.onCommit('我的草稿')).toBe(false);
  expect(render().content('identity', 'identity')!.key).toBe(key);
  expect(render().statusNodes.map(node => String(node.label)).join(' ')).toContain('他人修改');
  expect(await editor().onCommit('我的草稿')).toBe(false);
  expect(h.client.settings.mock.calls.filter(([request]) => request.type === 'save').map(([request]) => request.edit.revision)).toEqual(['r1', 'r1']);
  const action = render().statusNodes.find(node => node.id.startsWith('role-conflict-action:'))!.content!;
  const preventDefault = vi.fn(); action.props.onPointerDown({preventDefault}); expect(preventDefault).toHaveBeenCalledOnce();
  action.props.onClick({stopPropagation: vi.fn()});
  expect(render().content('identity', 'identity')!.key).toBe(key);
  expect(await editor().onCommit('我的草稿')).toBe(true);
  expect(h.client.settings.mock.calls.filter(([request]) => request.type === 'save').map(([request]) => request.edit.revision)).toEqual(['r1', 'r1', 'r2']);
});

it('guards navigation until the active editor session commits', async () => {
  render(); await flush(); render().beginEdit('identity');
  const session = editor().session;
  const action = vi.fn(); const focus = vi.fn();
  session.current = {commit: vi.fn().mockResolvedValue(false), focus};
  render().withSavedDraft(action); await flush(); expect(action).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce();
  session.current = {commit: vi.fn().mockResolvedValue(true), focus};
  render().withSavedDraft(action); await flush(); expect(action).toHaveBeenCalledOnce();
  render().withSavedDraft(action); await flush(); expect(action).toHaveBeenCalledTimes(2);
  expect(session.current.commit).toHaveBeenCalledOnce();
});
