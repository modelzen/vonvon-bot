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

it('shows every recipe skill directly without an extra disclosure or search', async () => {
  await act(async () => root.render(<RecipeBrowseConfiguration preview={preview} section="能力"/>));
  expect(document.querySelectorAll('[aria-label="配方技能"] li')).toHaveLength(2);
  expect(document.querySelector('.recipe-skills')?.textContent).toContain('检查依赖并完成初始化配置。');
  expect(document.querySelector('input[type="search"], [aria-label="搜索技能"]')).toBeNull();
  expect(document.querySelector('.recipe-skills-heading')).toBeNull();
  expect(document.querySelector('.recipe-skills details, [role="dialog"]')).toBeNull();
  expect(document.querySelector('.recipe-skills-name .setup-skill-badge')?.textContent).toBe('Setup');
  expect(document.querySelector('.recipe-skills-list')?.textContent).toContain('feedback-setup');
  expect(document.querySelector('.recipe-skills-list')?.textContent).toContain('feedback-submit');
});

it('pins Setup skills and opens a purpose explanation without exposing skill details', async () => {
  await act(async () => root.render(<RecipeBrowseConfiguration preview={{...preview, skills: [
    preview.skills[1]!, {...preview.skills[0]!, name: 'MySETUPWizard'},
  ]}} section="能力"/>));
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.recipe-skills-row > button')];
  expect(buttons.map(node => node.getAttribute('aria-label'))).toEqual(['MySETUPWizard', 'feedback-submit']);
  expect(buttons[0]?.querySelector('.recipe-skills-name .setup-skill-badge')?.textContent).toBe('Setup');
  expect(buttons[1]?.querySelector('.setup-skill-badge')).toBeNull();
  const dialog = document.querySelector('dialog')!;
  const showModal = vi.fn();
  dialog.showModal = showModal;
  for (const target of ['.recipe-skills-name strong', '.setup-skill-badge', '.recipe-skills-description', 'svg']) {
    await act(async () => buttons[0]!.querySelector(target)!.dispatchEvent(new MouseEvent('click', {bubbles: true})));
    expect(dialog.getAttribute('aria-label')).toBe('MySETUPWizard');
    expect(dialog.textContent).toContain('首次启动');
  }
  await act(async () => buttons[1]!.click());
  expect(showModal).toHaveBeenCalledTimes(5);
  expect(dialog.getAttribute('aria-label')).toBe('feedback-submit');
  expect(dialog.textContent).not.toContain('Setup 用途');
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
