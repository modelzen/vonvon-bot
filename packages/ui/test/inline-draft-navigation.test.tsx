import {beforeEach, expect, it, vi} from 'vitest';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
const h = vi.hoisted(() => ({states: [] as unknown[], refs: [] as Array<{current: unknown}>, si: 0, ri: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.states)) h.states[i] = initial; return [h.states[i], (next: unknown) => {h.states[i] = typeof next === 'function' ? next(h.states[i]) : next;}];},
  useRef: (current: unknown) => h.refs[h.ri++] ??= {current},
  useMemo: (make: () => unknown) => make(), useCallback: (value: unknown) => value,
}));
function render() {h.si = h.ri = 0; const page = DraftGuardProvider({children: null}); return {guard: page.props.value, modal: page.props.children[1]};}
async function flush() {for (let i=0;i<10;i++) await Promise.resolve();}
beforeEach(() => {h.states = []; h.refs = [];});
it('waits for inline saves before leaving and never opens the unsaved changes window', async () => {
  let finish!: (ok: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => {finish = resolve;}));
  const action = vi.fn(); const {guard} = render();
  guard.register('map', {autoSave: true, title: '节点', save, discard: vi.fn()});
  guard.navigate(action);
  expect(action).not.toHaveBeenCalled(); expect(render().modal.props.open).toBe(false);
  finish(true); await flush();
  expect(action).toHaveBeenCalledOnce(); expect(render().modal.props.open).toBe(false);
});
it('keeps failed inline drafts on their page and allows another save attempt', async () => {
  const action = vi.fn(); const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const {guard} = render(); guard.register('map', {autoSave: true, title: '节点', save, discard: vi.fn()});
  guard.navigate(action); await flush();
  expect(action).not.toHaveBeenCalled(); expect(render().modal.props.open).toBe(false);
  guard.navigate(action); await flush(); expect(action).toHaveBeenCalledOnce();
});
it('retains the existing confirmation flow for other settings forms', () => {
  const {guard} = render(); guard.register('settings', {title: '设置', save: vi.fn(), discard: vi.fn()});
  guard.navigate(vi.fn()); expect(render().modal.props.open).toBe(true);
});
