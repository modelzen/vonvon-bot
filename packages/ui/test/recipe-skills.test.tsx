// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {recipeRichContentSchema, type RecipeBrowsePreview} from '@vonvon/protocol';
import fixture from '../../protocol/test/fixtures/recipe-rich-v2.content.json';
import {RecipeBrowseConfiguration, RichConfiguration} from '../src/community/RichConfiguration';

const skillId = '70000000-0000-4000-8000-000000000001';
const fileId = '70000000-0000-4000-8000-000000000002';
const preview: RecipeBrowsePreview = {settings: [], ruleCount: 0, taskCount: 0, skills: [
  {itemId: skillId, name: 'feedback-setup', description: '检查依赖并完成初始化配置。'},
  {itemId: fileId, name: 'feedback-submit', description: '整理和提交问题反馈。'},
]};
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('shows skill names and descriptions as read-only rows and searches both without a detail view', async () => {
  await act(async () => root.render(<RecipeBrowseConfiguration preview={preview} section="能力"/>));
  expect(document.querySelectorAll('[aria-label="配方技能"] li')).toHaveLength(2);
  expect(document.querySelector('.recipe-skills')?.textContent).toContain('检查依赖并完成初始化配置。');
  expect(document.querySelector('.recipe-skills-count')?.textContent).toBe('2 项');
  expect(document.querySelector('.recipe-skills details, [role="dialog"]')).toBeNull();
  expect(document.querySelector('.setup-skill-info')).not.toBeNull();
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索技能"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '初始化');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  expect(document.querySelectorAll('[aria-label="配方技能"] li')).toHaveLength(1);
  expect(document.querySelector('.recipe-skills-count')?.textContent).toBe('1 / 2 项');
  expect(document.querySelector('.recipe-skills-list')?.textContent).toContain('feedback-setup');
  expect(document.querySelector('.recipe-skills-list')?.textContent).not.toContain('feedback-submit');
});

it('pins Setup skills and opens a purpose explanation without exposing skill details', async () => {
  await act(async () => root.render(<RecipeBrowseConfiguration preview={{...preview, skills: [
    preview.skills[1]!, {...preview.skills[0]!, name: 'MySETUPWizard'},
  ]}} section="能力"/>));
  expect([...document.querySelectorAll('.recipe-skills-name strong')].map(node => node.textContent)).toEqual(['MySETUPWizard', 'feedback-submit']);
  const info = document.querySelector<HTMLButtonElement>('[aria-label="了解 MySETUPWizard 的 Setup 用途"]')!;
  await act(async () => info.click());
  expect(document.querySelector('.setup-skill-popup')?.textContent).toContain('MCP、CLI');
  expect(document.querySelector('.setup-skill-popup')?.textContent).toContain('首次启动');
  expect(document.querySelector('details')).toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
  expect(document.querySelector('.setup-skill-popup')).toBeNull();
});

it('keeps full skill bodies and attachments out of the legacy rich-data fallback', async () => {
  const content = recipeRichContentSchema.parse({...fixture,
    skills: [{itemId: skillId, originId: skillId, name: 'feedback-setup', entryFileId: fileId, fileIds: [fileId]}],
    files: [{itemId: fileId, originId: fileId, name: 'SKILL.md', use: 'skillDescription',
      text: {kind: 'part', objectId: fileId}}],
  });
  await act(async () => root.render(<RichConfiguration section="能力" view={{content,
    texts: {[fileId]: '---\nname: feedback-setup\ndescription: 检查依赖并完成初始化配置。\n---\nPRIVATE_SKILL_BODY'},
  }}/>));
  expect(document.querySelector('.recipe-skills-list')?.textContent).toContain('feedback-setup');
  expect(document.querySelector('.recipe-skills-list')?.textContent).toContain('检查依赖并完成初始化配置。');
  expect(document.body.textContent).not.toMatch(/PRIVATE_SKILL_BODY|SKILL\.md|name:|description:/);
  expect(document.querySelector('details, [role="dialog"]')).toBeNull();
});

it('explains missing summaries and an empty recipe without adding detail actions', async () => {
  await act(async () => root.render(<RecipeBrowseConfiguration preview={{...preview,
    skills: [{itemId: skillId, name: 'custom-skill', description: ''}],
  }} section="能力"/>));
  expect(document.querySelector('.recipe-skills-row')?.textContent).toContain('作者暂未填写技能说明。');
  await act(async () => root.render(<RecipeBrowseConfiguration preview={{...preview, skills: []}} section="能力"/>));
  expect(document.body.textContent).toContain('未选择技能');
  expect(document.querySelector('[aria-label="搜索技能"]')).toBeNull();
});
