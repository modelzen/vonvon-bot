import {beforeEach, expect, it, vi} from 'vitest';
import type {ReactElement} from 'react';
import type {DeviceRow} from '@vonvon/protocol';

// Codex 审查 237-1: a name typed into 改名 and not saved is a draft, so a switch asks first. No DOM in these tests: the
// hooks are driven by hand, one store per component, as in inline-draft-navigation.test.tsx.
const h = vi.hoisted(() => ({
  scope: 'guard', index: {state: 0, ref: 0},
  states: new Map<string, unknown[]>(), refs: new Map<string, Array<{current: unknown}>>(),
  cleanup: undefined as (() => void) | undefined, guard: undefined as unknown, shell: undefined as unknown,
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const list = h.states.get(h.scope) ?? [];
    h.states.set(h.scope, list);
    const index = h.index.state++;
    if (!(index in list)) list[index] = initial;
    return [list[index], (next: unknown) => { list[index] = typeof next === 'function' ? next(list[index]) : next; }];
  },
  useRef: (current: unknown) => {
    const list = h.refs.get(h.scope) ?? [];
    h.refs.set(h.scope, list);
    return list[h.index.ref++] ??= {current};
  },
  useMemo: (make: () => unknown) => make(), useCallback: (value: unknown) => value, useId: () => 'rename',
  useContext: () => h.guard,
  useLayoutEffect: (effect: () => (() => void) | void) => { h.cleanup?.(); h.cleanup = effect() ?? undefined; },
}));
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(), useShellCapabilities: () => h.shell}));

import {RenameRow} from '../src/devices/DevicesPanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';

type Guard = {navigate: (action: () => void) => void};
type Props = {open: boolean; footer: ReactElement<{children: Array<ReactElement<{onClick: () => void}> | false>}>};
const row: DeviceRow = {id: '11111111-1111-4111-8111-111111111111', name: '机房', current: false, status: 'unknown', routes: []};
function guardPage() {
  h.scope = 'guard'; h.index = {state: 0, ref: 0};
  const page = DraftGuardProvider({children: null}) as ReactElement<{value: Guard; children: [unknown, ReactElement<Props>]}>;
  return {guard: page.props.value, modal: page.props.children[1].props};
}
function renameForm(onDone: () => void) {
  h.scope = 'rename'; h.index = {state: 0, ref: 0};
  const form = RenameRow({row, onDone}) as ReactElement<{children: [ReactElement<{onChange: (event: unknown) => void}>]}>;
  return {type: (value: string) => form.props.children[0].props.onChange({target: {value}})};
}
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const footerButton = (modal: Props, index: number) => modal.footer.props.children[index] as ReactElement<{onClick: () => void}>;

beforeEach(() => {
  h.states.clear(); h.refs.clear(); h.cleanup = undefined;
  const {guard} = guardPage();
  h.guard = guard;
});

it('switches at once with nothing typed, and asks first with a name typed and not saved', () => {
  const rename = vi.fn(async () => {});
  h.shell = {devices: {rename}};
  const switchTo = vi.fn();
  renameForm(vi.fn()).type('机房');
  renameForm(vi.fn());
  guardPage().guard.navigate(switchTo);
  expect(switchTo).toHaveBeenCalledOnce();
  renameForm(vi.fn()).type('新机房');
  renameForm(vi.fn());
  guardPage().guard.navigate(switchTo);
  expect(switchTo).toHaveBeenCalledOnce();
  expect(guardPage().modal.open).toBe(true);
  expect(rename).not.toHaveBeenCalled();
});

it('saves the name before it switches, or drops it and closes the form', async () => {
  const rename = vi.fn(async () => {});
  h.shell = {devices: {rename}};
  const onDone = vi.fn();
  const switchTo = vi.fn();
  renameForm(onDone).type('新机房');
  renameForm(onDone);
  guardPage().guard.navigate(switchTo);
  footerButton(guardPage().modal, 2).props.onClick();
  await flush();
  expect(rename).toHaveBeenCalledExactlyOnceWith(row.id, '新机房');
  expect(onDone).toHaveBeenCalledOnce();
  expect(switchTo).toHaveBeenCalledOnce();

  h.cleanup?.(); h.cleanup = undefined; h.states.delete('rename'); h.refs.delete('rename');
  const dropped = vi.fn();
  renameForm(dropped).type('别的名字');
  renameForm(dropped);
  guardPage().guard.navigate(switchTo);
  footerButton(guardPage().modal, 1).props.onClick();
  expect(dropped).toHaveBeenCalledOnce();
  expect(switchTo).toHaveBeenCalledTimes(2);
  expect(rename).toHaveBeenCalledOnce();
});
