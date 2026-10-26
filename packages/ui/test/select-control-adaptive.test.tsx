import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {SelectControl, type SelectionOption} from '../src/reference/components/ui';

vi.mock('react', async original => ({...await original<typeof import('react')>(), useId: () => 'adaptive-select'}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];
}
const options: SelectionOption<string>[] = [{value: 'codex', label: 'Codex'}, {value: 'claude', label: 'Claude'}];
const render = (overrides: Partial<Parameters<typeof SelectControl<string>>[0]> = {}) => SelectControl({label: '模型 Provider', value: '', options, onChange: vi.fn(), ...overrides});

it('shows a short choice directly without silently selecting or writing a default', () => {
  const changed = vi.fn();
  const ui = render({onChange: changed});
  expect(ui.props).toMatchObject({role: 'radiogroup', 'aria-label': '模型 Provider'});
  const radios = nodes(ui).filter(node => node.type === 'input');
  expect(radios.map(node => [node.props.value, node.props.checked])).toEqual([['codex', false], ['claude', false]]);
  expect(changed).not.toHaveBeenCalled();
  radios[1]!.props.onChange();
  expect(changed).toHaveBeenCalledExactlyOnceWith('claude');
});

it('keeps selected unavailable choices readable and guards disabled or unchanged edits', () => {
  const changed = vi.fn();
  const unavailable = [{value: 'codex', label: 'Codex', disabled: true}, options[1]!];
  const ui = render({value: 'codex', options: unavailable, onChange: changed});
  const radios = nodes(ui).filter(node => node.type === 'input');
  expect(radios[0]!.props).toMatchObject({checked: true, disabled: true});
  radios[0]!.props.onChange();
  expect(changed).not.toHaveBeenCalled();
  const readonly = nodes(render({disabled: true, onChange: changed})).filter(node => node.type === 'input');
  expect(readonly.every(node => node.props.disabled)).toBe(true);
  readonly[1]!.props.onChange();
  const same = nodes(render({value: 'claude', onChange: changed})).filter(node => node.type === 'input');
  same[1]!.props.onChange();
  expect(changed).not.toHaveBeenCalled();
});

it('preserves field naming and validation metadata for the visible choice group', () => {
  const ui = render({id: 'provider', 'aria-labelledby': 'provider-heading', 'aria-describedby': 'provider-help', 'aria-invalid': true, 'aria-required': true});
  expect(ui.props).toMatchObject({id: 'provider', 'aria-labelledby': 'provider-heading', 'aria-describedby': 'provider-help', 'aria-invalid': true, 'aria-required': true});
});

it('keeps long lists, rich labels and long text in the existing selection panel', () => {
  const long = Array.from({length: 6}, (_, index) => ({value: `model-${index}`, label: `Model ${index}`}));
  expect(render({options: long}).props.items).toBe(long);
  const rich = [{value: 'codex', label: <span>Codex <small>本机</small></span>}];
  expect(render({options: rich}).props.items).toBe(rich);
  const descriptions = [{value: 'codex', label: 'Codex', description: 'Uses local credentials'}];
  expect(render({options: descriptions}).props.items).toBe(descriptions);
  const wide = [{value: 'workspace', label: '仅允许当前工作区内的文件写入'}];
  expect(render({options: wide}).props.items).toBe(wide);
});

it('keeps disabled and same-value safeguards for the longer selection panel', () => {
  const changed = vi.fn();
  const panel = render({value: 'codex', options: [...options, ...Array.from({length: 4}, (_, index) => ({value: `other-${index}`, label: `Other ${index}`, disabled: true}))], onChange: changed});
  panel.props.onValueChange('codex');
  panel.props.onValueChange('other-0');
  panel.props.onValueChange('missing');
  expect(changed).not.toHaveBeenCalled();
  panel.props.onValueChange('claude');
  expect(changed).toHaveBeenCalledExactlyOnceWith('claude');
});

it('keeps icons in short segments and in the dropdown used by an extended Provider list', () => {
  const getOptionIcon = (value: string) => <img src={`./${value}.svg`} alt=""/>;
  const compact = render({value: 'codex', getOptionIcon});
  expect(compact.props.role).toBe('radiogroup');
  expect(nodes(compact).filter(node => node.type === 'img').map(node => node.props.src)).toEqual(['./codex.svg', './claude.svg']);
  const extended = Array.from({length: 12}, (_, index) => ({value: `provider-${index}`, label: `Provider ${index}`}));
  const dropdown = render({value: 'provider-0', options: extended, getOptionIcon});
  expect(dropdown.props.items).toBe(extended);
  expect(nodes(dropdown).filter(node => node.type === 'img')).toHaveLength(13);
  expect(render({options: [...options, {value: 'openrouter', label: 'OpenRouter'}, {value: 'deepseek', label: 'DeepSeek'}], getOptionIcon}).props.items).toHaveLength(4);
});
it('can consistently present short lists as dropdowns with recommendation outside the selected label', () => {
  const recommended = [{value: 'none', label: '关闭思考', recommended: true}, {value: 'low', label: 'low'}];
  const ui = render({presentation: 'dropdown', value: 'none', options: recommended});
  expect(ui.props.items).toBe(recommended);
  expect(nodes(ui).filter(node => node.type === 'input')).toHaveLength(0);
  expect(nodes(ui).filter(node => node.props.className === 'ui-select-control__recommendation').map(node => node.props.children)).toEqual(['推荐']);
  expect(ui.props.items.find((option: {value: string}) => option.value === 'none').label).toBe('关闭思考');
});
