import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import {JSDOM} from 'jsdom';

const source = await readFile(new URL('../dist/viewer.mjs', import.meta.url), 'utf8');
const bundle = await transform(source, {format: 'iife', globalName: 'RecipeViewer'});
const recipeId = '11111111-1111-4111-8111-111111111111', versionId = '22222222-2222-4222-8222-222222222222';
const path = '/recipes/' + recipeId + '/versions/' + versionId;
const content = JSON.parse(await readFile(new URL('../../../packages/protocol/test/fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8'));
const recipe = {recipeId, versionId, revision: 2, format: 'rich-v2', owned: false, acquired: false,
  creator: {authorId: '33333333-3333-4333-8333-333333333333', displayName: '同一位作者'},
  public: {name: '工作助手', summary: '整理日常工作', overview: '# 配方介绍\n**作者的说明** <script>alert(1)</script>', version: '1.2', access: 'direct'},
  rich: {content: {...content, role: {...content.role, text: {kind: 'inline', value: '同一份角色正文'}},
    setup: [{itemId: 'note', title: '使用说明', instructions: '核对自己的环境', check: '检查完成'}]}, texts: {}, canonical: ''},
};
const settle = async () => {await new Promise(resolve => setTimeout(resolve, 25));};
async function runtime(t, detail = recipe, {origin = 'catalog', clipboard} = {}) {
  const dom = new JSDOM('<main></main>', {url: 'https://recipes.example' + path + '?from=library', runScripts: 'outside-only'});
  const {window} = dom, claims = [], copied = [];
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  if (clipboard) Object.defineProperty(window.navigator, 'clipboard', {value: {writeText: async value => copied.push(value)}});
  window.eval(bundle.code);
  window.RecipeViewer.renderRecipe(window.document.querySelector('main'), detail, button => claims.push(button), origin);
  t.after(() => window.close());
  return {window, document: window.document, claims, copied,
    click: async label => {
      const button = [...window.document.querySelectorAll('button')].find(node => node.textContent === label);
      assert.ok(button, label); button.click(); await settle(); return button;
    }};
}

test('the shipped website renders the same rich data as a readable document with section links', async t => {
  const h = await runtime(t);
  assert.equal(h.document.querySelector('h1').textContent, recipe.public.name);
  assert.match(h.document.querySelector('main').textContent, /同一位作者/);
  assert.match(h.document.querySelector('main').textContent, /1\.2/);
  assert.match(h.document.querySelector('.web-recipe-facts').textContent, /第 2 次发布/);
  assert.equal(h.document.querySelector('.web-recipe-layout').firstElementChild.tagName, 'ASIDE');
  assert.match(h.document.querySelector('#abilities').textContent, /同一份角色正文/);
  const links = [...h.document.querySelectorAll('[aria-label="配方详细信息"] a')];
  assert.deepEqual(links.map(a => a.textContent), ['概览', '模型与权限', '能力', '沟通方式', '任务']);
  for (const a of links) assert.ok(h.document.querySelector(a.getAttribute('href')), a.textContent);
  assert.equal(h.document.querySelector('[aria-label="配方详细信息"] button'), null);
  assert.equal(h.document.querySelector('script, .community-detail-layout, .today-back'), null);
  assert.equal(h.document.querySelector('.web-recipe-notes').open, false);
  assert.match(h.document.querySelector('.web-recipe-notes').textContent, /核对自己的环境/);
  const button = await h.click('获取配方');
  assert.deepEqual(h.claims, [button]);
});

test('a coded overview keeps private configuration and preparation content out of the website', async t => {
  const {rich, ...intro} = recipe;
  const h = await runtime(t, {...intro, public: {...recipe.public, access: 'coded'}});
  assert.equal(h.document.querySelectorAll('[aria-label="配方详细信息"] a').length, 1);
  assert.equal(h.document.querySelector('#models, #abilities, #communication, #tasks, .web-recipe-notes'), null);
  assert.doesNotMatch(h.document.querySelector('main').textContent, /同一份角色正文|核对自己的环境/);
  assert.match(h.document.querySelector('.web-locked').textContent, /获取此版本后/);
  assert.equal(h.claims.length, 0);
});

test('browsing renders lightweight settings and skill summaries without complete skill or rule content', async t => {
  const {rich, ...intro} = recipe;
  const identity = {itemId: '70000000-0000-4000-8000-000000000001', originId: '80000000-0000-4000-8000-000000000001'};
  const h = await runtime(t, {...intro, acquired: true, preview: {
    settings: [{...identity, field: 'presentation.voiceEnabled', value: true}],
    skills: [{itemId: versionId, name: '项目准备', description: '核对环境并准备项目。'}], ruleCount: 2, taskCount: 1,
  }});
  assert.equal(h.document.querySelectorAll('[aria-label="配方详细信息"] a').length, 5);
  assert.match(h.document.querySelector('#abilities').textContent, /项目准备/);
  assert.match(h.document.querySelector('#abilities').textContent, /核对环境并准备项目/);
  assert.match(h.document.querySelector('#abilities').textContent, /2 条规则/);
  assert.match(h.document.querySelector('#communication').textContent, /语音回复.*开启/);
  assert.match(h.document.querySelector('#tasks').textContent, /1 项任务/);
  assert.doesNotMatch(h.document.querySelector('main').textContent, /同一份角色正文|核对自己的环境/);
  assert.equal(h.document.querySelector('#abilities details, .web-recipe-notes'), null);
  assert.equal(h.claims.length, 0);
});

test('a saved version awaiting its display projection does not ask the user to acquire it again', async t => {
  const {rich, ...intro} = recipe;
  const h = await runtime(t, {...intro, acquired: true, previewUnavailable: true});
  assert.match(h.document.querySelector('.web-locked').textContent, /配置概览暂不可用/);
  assert.doesNotMatch(h.document.querySelector('.web-locked').textContent, /获取此版本后/);
  assert.equal(h.document.querySelectorAll('[aria-label="配方详细信息"] a').length, 1);
});

test('saved entries show account entitlement and copy the canonical version URL without navigation state', async t => {
  const h = await runtime(t, {...recipe, acquired: true}, {origin: 'library', clipboard: true});
  assert.equal(h.document.querySelector('.web-breadcrumb a').getAttribute('href'), '/library');
  assert.match(h.document.querySelector('.web-saved').textContent, /已获取/);
  assert.equal([...h.document.querySelectorAll('button')].some(button => button.textContent === '获取配方'), false);
  await h.click('复制链接');
  assert.deepEqual(h.copied, ['https://recipes.example' + path]);
  assert.equal(h.claims.length, 0);
});

test('copy remains usable without clipboard access', async t => {
  const h = await runtime(t);
  await h.click('复制链接');
  const fallback = h.document.querySelector('input[aria-label="手动复制"]');
  assert.equal(fallback.value, 'https://recipes.example' + path);
  fallback.focus();
  assert.equal(fallback.selectionStart, 0);
  assert.equal(fallback.selectionEnd, fallback.value.length);
});

test('community and creation pages connect visitors to the same official website and documentation', async t => {
  for (const name of ['index.html', 'studio.html']) {
    const dom = new JSDOM(await readFile(new URL('../public/' + name, import.meta.url), 'utf8'));
    t.after(() => dom.window.close());
    const nav = dom.window.document.querySelector('header nav');
    for (const href of ['https://vonvon.cc/', 'https://vonvon.cc/docs/', 'https://vonvon.cc/get/', '/']) assert.ok(nav.querySelector('a[href="' + href + '"]'), href);
    assert.ok(dom.window.document.querySelector('footer a[href="/studio"]'));
    assert.equal(nav.querySelector('a[href="/library"]'), null);
  }
});
