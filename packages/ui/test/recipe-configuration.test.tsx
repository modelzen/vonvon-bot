// @vitest-environment jsdom
import {act, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {recipeRichContentSchema, type RecipeBrowseDetail, type RecipeRichSetting} from '@vonvon/protocol';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {RecipeConfiguration, RecipeMetadata, RecipeVersion} from '../src/community/RecipeContent';
import {RecipeBrowseConfiguration, RichConfiguration} from '../src/community/RichConfiguration';

const content = recipeRichContentSchema.parse(JSON.parse(readFileSync(resolve(process.cwd(), '../protocol/test/fixtures/recipe-rich-v2.content.json'), 'utf8')));
const emptyPreview: NonNullable<RecipeBrowseDetail['preview']> = {settings: [], skills: [], ruleCount: 0, taskCount: 0};
const identity = {itemId: '11111111-1111-4111-8111-111111111111', originId: '22222222-2222-4222-8222-222222222222'};
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
async function draw(node: ReactNode) {await act(async () => root.render(node));}
const labels = () => [...document.querySelectorAll('.recipe-configuration-fields > div > dt')].map(node => node.textContent);

it('keeps the role and skills without rendering rule headings or private rule text in abilities', async () => {
  const role = { ...identity, text: {kind: 'inline' as const, value: '整理笔记'} };
  const rule = { ...identity, purpose: 'work' as const, text: {kind: 'inline' as const, value: 'PRIVATE_RULE_SENTINEL'} };
  await draw(<RichConfiguration view={{content: {...content, role, rules: [rule]}, texts: {}}} section="能力"/>);
  expect([...document.querySelectorAll('h2')].map(node => node.textContent)).toEqual(['角色', '技能']);
  expect(document.body.textContent).toContain('整理笔记');
  expect(document.body.textContent).not.toContain('PRIVATE_RULE_SENTINEL');
  await draw(<RecipeConfiguration config={{role: '旧版角色'}} section="能力"/>);
  expect(document.body.textContent).toContain('旧版角色');
  expect(document.body.textContent).not.toContain('规则');
  await draw(<RecipeBrowseConfiguration preview={emptyPreview} section="能力"/>);
  expect(document.body.textContent).not.toContain('规则');
});

it.each(['模型与权限', '沟通方式'])('keeps the complete %s field structure for empty and populated previews', async section => {
  await draw(<RecipeBrowseConfiguration preview={emptyPreview} section={section}/>);
  const emptyLabels = labels();
  expect(emptyLabels.length).toBe(section === '模型与权限' ? 7 : 10);
  expect(document.querySelectorAll('.recipe-configuration-card')).toHaveLength(2);
  expect(document.body.textContent).toContain('沿用目标群设置');
  expect(document.querySelectorAll('.recipe-configuration-unset')).toHaveLength(emptyLabels.length);
  await draw(<RecipeBrowseConfiguration preview={{...emptyPreview, settings: content.settings}} section={section}/>);
  expect(labels()).toEqual(emptyLabels);
  expect(document.querySelectorAll('input, select, button')).toHaveLength(0);
});

it('distinguishes omitted settings from unspecified ones while keeping available values visible', async () => {
  const settings: RecipeRichSetting[] = [{...identity, field: 'presentation.voiceEnabled', value: false}];
  await draw(<RecipeBrowseConfiguration preview={{...emptyPreview, settings, omittedSettingCount: 3}} section="沟通方式"/>);
  expect(document.body.textContent).toContain('语音转文字关闭');
  expect(document.querySelectorAll('.recipe-configuration-unset')).toHaveLength(9);
  expect([...document.querySelectorAll('.recipe-configuration-unset')].every(node => node.textContent === '概览未提供')).toBe(true);
  expect(document.body.textContent).not.toContain('未指定');
  expect(document.body.textContent).toContain('此概览省略了 3 项配置');
  expect(document.body.textContent).toContain('未提供不代表未配置');
});

it('preserves literal model identifiers and explicit defaults, including false values', async () => {
  const settings: RecipeRichSetting[] = [
    {...identity, field: 'model.recommendation', value: {backend: 'codex', selection: {kind: 'explicit', model: 'default', effort: 'high'}}},
    {...identity, itemId: 'model-access', field: 'permission.codex.requirement', value: {sandbox: 'read-only', network: false}},
  ];
  await draw(<RecipeBrowseConfiguration preview={{...emptyPreview, settings}} section="模型与权限"/>);
  expect(document.body.textContent).toContain('模型default');
  expect(document.body.textContent).toContain('只读');
  expect(document.body.textContent).toContain('网络访问关闭');
  expect(document.body.textContent).toContain('权限变更仍需你确认');
  await draw(<RecipeBrowseConfiguration preview={{...emptyPreview, settings: [
    {...identity, field: 'presentation.completionTemplate', value: null},
    {...identity, itemId: 'card', field: 'presentation.cardDisplay', value: null},
  ]}} section="沟通方式"/>);
  expect(document.body.textContent).toContain('使用默认完成通知模板');
  expect(document.body.textContent).toContain('使用默认消息卡片');
});

it('renders meaningful zero-task and count-only states without suggesting tasks have been enabled', async () => {
  await draw(<RecipeBrowseConfiguration preview={emptyPreview} section="任务"/>);
  expect(document.querySelector('[aria-label="定时任务"]')).not.toBeNull();
  expect(document.body.textContent).toContain('未预设定时任务');
  expect(document.body.textContent).toContain('目标群已有任务');
  await draw(<RecipeBrowseConfiguration preview={{...emptyPreview, taskCount: 2}} section="任务"/>);
  expect(document.body.textContent).toContain('包含 2 项任务');
  expect(document.body.textContent).toContain('概览只展示任务数量');
  expect(document.body.textContent).toContain('保持暂停');
  expect(document.querySelector('button')).toBeNull();
});

it('shares empty-state structure with legacy configuration and complete rich task details', async () => {
  await draw(<RecipeConfiguration config={{role: '角色'}} section="模型与权限"/>);
  expect(labels()).toHaveLength(7);
  await draw(<RichConfiguration view={{content: {...content, tasks: []}, texts: {}}} section="任务"/>);
  expect(document.body.textContent).toContain('未预设定时任务');
  await draw(<RichConfiguration view={{content: {...content, tasks: [{...identity, name: '晨间检查', instruction: {kind: 'inline', value: '检查今日安排'}, spec: {kind: 'daily', time: '09:00'}, timeZone: {kind: 'recommended', iana: 'Asia/Shanghai'}, placement: 'newTopic'}]}, texts: {}}} section="任务"/>);
  expect(document.querySelector('.recipe-configuration-card h3')?.textContent).toBe('晨间检查');
  expect(document.body.textContent).toContain('每天 09:00 · Asia/Shanghai · 新话题');
  expect(document.body.textContent).toContain('检查今日安排');
  expect(document.body.textContent).toContain('安装后暂停');
});

it('shows only the exact published version and preserves draft wording', async () => {
  const version = '0.2.0-preview-with-a-very-long-build-identifier';
  await draw(<RecipeMetadata meta={{name: '配方', summary: '说明', version, access: 'direct'}} revision={2}/>);
  const value = document.querySelector('.recipe-version-value');
  expect(value?.textContent).toBe(version);
  expect(value?.getAttribute('title')).toBe(version);
  expect(value?.nextElementSibling).toBeNull();
  await draw(<RecipeVersion version={version} revision={4} draft/>);
  expect(document.body.textContent).toContain('草稿修订 4');
  expect(document.body.textContent).not.toContain('次发布');
});
