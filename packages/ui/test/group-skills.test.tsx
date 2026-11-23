// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {ProjectSettingsView} from '@vonvon/protocol';
import {SkillsList} from '../src/settings/GroupSkills';

const skills: NonNullable<ProjectSettingsView['skills']> = [
  {name: 'feedback', description: '整理并提交问题反馈', path: 'project:feedback', source: 'workspace', enabled: true},
  {name: 'global-setup', description: '全局环境配置', path: 'user:setup', source: 'user', enabled: true},
  {name: 'feedback-setup', description: '检查依赖，首次启动', path: 'project:setup', source: 'workspace', enabled: true},
  {name: 'feedback', description: '来自全局的同名技能', path: 'user:feedback', source: 'user', enabled: true},
  {name: 'system-tool', description: 'Provider 内置技能', path: 'provider:tool', source: 'provider', enabled: false},
];
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
const group = (source: string) => document.querySelector<HTMLDetailsElement>(`details[data-source="${source}"]`)!;
const search = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索技能"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
};
const render = async (props: Partial<Parameters<typeof SkillsList>[0]> = {}) => act(async () => root.render(
  <SkillsList skills={skills} disabledPaths={[]} disabled={false} onToggle={() => {}} refresh={async () => {}} {...props}/>,
));

it('opens project skills first with Setup at the top, and folds global and Provider skills independently', async () => {
  await render();
  expect([...document.querySelectorAll('details')].map(node => node.dataset.source)).toEqual(['workspace', 'user', 'provider']);
  expect(group('workspace').open).toBe(true);
  expect(group('user').open).toBe(false);
  expect(group('provider').open).toBe(false);
  expect([...group('workspace').querySelectorAll('.gd-skill-detail strong')].map(node => node.textContent)).toEqual(['feedback-setup', 'feedback']);
  expect(group('workspace').querySelector('summary')?.textContent).toContain('2 项 · 2 已启用');
  expect(group('workspace').querySelector('[aria-label="了解 feedback-setup 的 Setup 用途"]')).not.toBeNull();
  await act(async () => {group('user').open = true; group('user').dispatchEvent(new Event('toggle'));});
  expect(group('user').open).toBe(true);
  expect(group('provider').open).toBe(false);
  await act(async () => {group('workspace').open = false; group('workspace').dispatchEvent(new Event('toggle'));});
  expect(group('workspace').open).toBe(false);
});

it('searches across folded groups, shows each source, and restores disclosure choices after search', async () => {
  await render();
  await search('feedback');
  expect(group('workspace').open).toBe(true);
  expect(group('user').open).toBe(true);
  expect(document.querySelector('[data-source="provider"]')).toBeNull();
  expect(group('user').querySelector('summary')?.textContent).toContain('1 / 2 项');
  expect(document.querySelectorAll('.gd-skill-row')).toHaveLength(3);
  await search('首次启动');
  expect(document.querySelectorAll('.gd-skill-row')).toHaveLength(1);
  await search('no-such-skill');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('没有匹配的技能');
  await search('');
  expect(group('workspace').open).toBe(true);
  expect(group('user').open).toBe(false);
});

it('changes the exact skill path, preserves same-name skills in other sources and reflects saved disabled state', async () => {
  const toggle = vi.fn();
  function SavedSkills() {
    const [disabledPaths, setDisabledPaths] = useState<string[]>([]);
    return <SkillsList skills={skills} disabledPaths={disabledPaths} disabled={false} refresh={async () => {}}
      onToggle={(path, enabled) => {toggle(path, enabled); setDisabledPaths(previous => enabled ? previous.filter(value => value !== path) : [...previous, path]);}}/>;
  }
  await act(async () => root.render(<SavedSkills/>));
  const input = group('workspace').querySelector<HTMLInputElement>('[aria-label="使用 feedback"]')!;
  await act(async () => input.click());
  expect(toggle).toHaveBeenLastCalledWith('project:feedback', false);
  expect(input.checked).toBe(false);
  expect(group('user').querySelector<HTMLInputElement>('[aria-label="使用 feedback"]')?.checked).toBe(true);
  expect(group('workspace').querySelector('summary')?.textContent).toContain('2 项 · 1 已启用');
  await act(async () => input.click());
  expect(toggle).toHaveBeenLastCalledWith('project:feedback', true);
  expect(input.checked).toBe(true);
  expect(group('provider').querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
});

it('makes missing project skills explicit and refreshes from the existing provider action', async () => {
  const refresh = vi.fn(async () => {});
  await render({skills: skills.filter(skill => skill.source !== 'workspace'), refresh});
  expect(group('workspace').textContent).toContain('配方安装的技能会显示在这里');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="重新读取"]')!.click());
  expect(refresh).toHaveBeenCalledOnce();
});

it('identifies an installed recipe skill without exposing its internal selector as a file location', async () => {
  await render({skills: [{...skills[0]!, path: 'recipe:installation:item'}]});
  await act(async () => group('workspace').querySelector<HTMLButtonElement>('.gd-skill-detail')!.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('配方安装 · 项目技能');
  expect(dialog?.textContent).toContain('由本群配方管理');
  expect(dialog?.textContent).not.toContain('recipe:installation:item');
});
