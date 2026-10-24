import {beforeEach, expect, it, vi} from 'vitest';
import {MindMap, type MapNode} from '../src/MindMap';
import {MapInlineEditor} from '../src/MapInlineEditor';

vi.mock('react', async original => ({...await original<typeof import('react')>(), useId: () => 'tree', useLayoutEffect: () => {}, useState: (value: unknown) => [value, vi.fn()], useRef: (value: unknown) => ({current: value})}));
vi.mock('../src/MindMapCanvas', () => ({useMindMapCanvas: () => ({host: {current: null}, slots: new Map()})}));
const preventDefault = vi.fn();
const stopPropagation = vi.fn();
beforeEach(() => vi.clearAllMocks());
const event = (key: string, field = false) => ({key, target: {closest: () => field ? {} : null}, nativeEvent: {}, preventDefault, stopPropagation});
const node = (extra: Partial<MapNode> = {}): MapNode => ({id: 'item', kind: 'leaf', label: '记忆', selected: true, ...extra});

it('deletes the selected item only outside a text editor; protected nodes never send a deletion', () => {
  const onDelete = vi.fn();
  const tree = MindMap({root: node({onDelete}), label: 'map'});
  tree.props.onKeyDown(event('Delete'));
  expect(onDelete).toHaveBeenCalledOnce();
  tree.props.onKeyDown(event('Backspace', true));
  expect(onDelete).toHaveBeenCalledOnce();
  MindMap({root: node(), label: 'map'}).props.onKeyDown(event('Backspace'));
  expect(onDelete).toHaveBeenCalledOnce();
});

it('typing starts an edit while add shortcuts and IME composition stay distinct', () => {
  const onEdit = vi.fn(); const onAdd = vi.fn();
  const tree = MindMap({root: node({onEdit, onAdd}), label: 'map'});
  tree.props.onKeyDown(event('a'));
  expect(onEdit).toHaveBeenCalledWith({text: 'a'});
  tree.props.onKeyDown(event('Enter'));
  expect(onAdd).toHaveBeenCalledOnce();
  tree.props.onKeyDown({...event('中'), nativeEvent: {isComposing: true}});
  expect(onEdit).toHaveBeenCalledOnce();
});

it('Enter and Escape commit current text once, and never commit an unfinished IME composition', async () => {
  let resolve!: (ok: boolean) => void;
  const onCommit = vi.fn(() => new Promise<boolean>(done => {resolve = done;}));
  const editor = MapInlineEditor({value: '原文', onCommit});
  editor.props.ref.current = {innerText: '中文草稿'};
  editor.props.onCompositionStart();
  editor.props.onKeyDown(event('Enter'));
  expect(onCommit).not.toHaveBeenCalled();
  editor.props.onCompositionEnd();
  editor.props.onKeyDown(event('Escape'));
  editor.props.onBlur();
  await Promise.resolve();
  expect(onCommit).toHaveBeenCalledExactlyOnceWith('中文草稿');
  resolve(true); await Promise.resolve();
});

it('an empty existing item validates through commit; an empty new draft cancels', async () => {
  const onCommit = vi.fn(() => false); const onCancel = vi.fn();
  const existing = MapInlineEditor({value: '原文', onCommit, onCancel});
  existing.props.ref.current = {innerText: ''}; existing.props.onKeyDown(event('Enter'));
  await Promise.resolve();
  expect(onCommit).toHaveBeenCalledWith(''); expect(onCancel).not.toHaveBeenCalled();
  const adding = MapInlineEditor({value: '', onCommit, onCancel, cancelWhenEmpty: true});
  adding.props.ref.current = {innerText: ''}; adding.props.onBlur();
  expect(onCancel).toHaveBeenCalledOnce();
});


it('defers blur during composition and commits the completed Chinese text afterwards', async () => {
  const onCommit = vi.fn(() => true);
  const editor = MapInlineEditor({value: '', onCommit});
  editor.props.ref.current = {innerText: '中文组合完成'};
  editor.props.onCompositionStart(); editor.props.onBlur();
  await Promise.resolve(); expect(onCommit).not.toHaveBeenCalled();
  editor.props.onCompositionEnd(); await Promise.resolve();
  expect(onCommit).toHaveBeenCalledExactlyOnceWith('中文组合完成');
});
