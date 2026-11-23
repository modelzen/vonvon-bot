import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';

const recipe = {recipeId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222', revision: 1,
  public: {name: '会议纪要', summary: '保留会议决定', overview: '', version: '1.2', access: 'coded'}, owned: false, acquired: false};
const path = '/recipes/' + recipe.recipeId + '/versions/' + recipe.versionId;
const source = (await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8')).replace("import {setupList} from './setup.mjs';", "const setupList=()=>document.createElement('div');");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runtime(t, route, returnedRecipe = recipe) {
  const dom = new JSDOM('<main id="main"></main><dialog id="modal"></dialog><button id="account"></button><div id="feedback"></div>', {url: 'https://recipes.example' + route});
  const {window} = dom, calls = [], copied = [];
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const fetch = async (url, options = {}) => {
    calls.push({url, options});
    if (url === '/auth/session') return Response.json({signedIn: true, displaySession: 'test-session', providers: []});
    if (url === '/api/v2/me/recipe-groups?scope=all') {
      assert.equal(options.headers['X-Vonvon-Session'], 'test-session');
      return Response.json({items: [{...returnedRecipe, owned: true, acquired: false, state: 'listed', versionCount: 1}], nextCursor: null});
    }
    if (url === '/api/v2' + path + '/preview') return Response.json(returnedRecipe);
    throw Error('Unexpected request ' + url);
  };
  const run = new AsyncFunction('document', 'window', 'location', 'history', 'navigator', 'crypto', 'fetch', 'BroadcastChannel', 'setTimeout', 'clearTimeout', source);
  await run(window.document, window, window.location, window.history, {clipboard: {writeText: async value => copied.push(value)}}, webcrypto, fetch, undefined,
    (fn, ms) => {const timer = setTimeout(fn, ms); timer.unref(); return timer;}, clearTimeout);
  t.after(() => window.close());
  const settle = async () => {for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise(setImmediate);};
  return {document: window.document, calls, copied, settle};
}

test('library cards describe an owned entry without asking for another code and carry a bounded return destination', async t => {
  const h = await runtime(t, '/library');
  const card = h.document.querySelector('.card');
  assert.ok(card);
  assert.doesNotMatch(card.textContent, /需分享码/);
  assert.equal(card.querySelector('.card-main').getAttribute('href'), path + '?from=library-all');
  const back = h.document.querySelector('a[aria-label="浏览社区"]');
  assert.equal(back.getAttribute('href'), '/');
  assert.ok(back.querySelector('svg[aria-hidden="true"]'));
});

test('catalog-shaped summaries load their public version logo and preserve a readable fallback', async t => {
  const h = await runtime(t, '/library', {...recipe, hasDisplayLogo: true});
  const mark = h.document.querySelector('.card img');
  assert.equal(mark.getAttribute('src'), '/media/versions/' + recipe.versionId + '/logo.webp');
  mark.dispatchEvent(new h.document.defaultView.Event('error'));
  assert.equal(h.document.querySelector('.card .card-mark').textContent, '会');
  assert.equal(h.document.querySelector('.card img'), null);
});

test('a website library detail preserves its exact version and return destination without copy actions', async t => {
  const h = await runtime(t, path + '?from=library', {...recipe, acquired:true});
  assert.equal(h.document.querySelector('a[aria-label="返回我的配方"]').getAttribute('href'), '/library?state=acquired');
  assert.equal(h.document.defaultView.location.pathname,path);
  assert.equal(h.calls.some(call=>call.url==='/api/v2'+path+'/preview'),true);
  assert.equal([...h.document.querySelectorAll('button')].some(button=>/复制|copy/i.test(button.textContent)),false);
  assert.equal(h.document.querySelector('input[aria-label="手动复制"]'),null);
  assert.deepEqual(h.copied,[]);
  assert.equal(h.calls.some(call=>call.options.method==='POST'),false);
});

test('external return values never become a back destination', async t => {
  const h = await runtime(t, path + '?from=https%3A%2F%2Fother.example');
  assert.equal(h.document.querySelector('a[aria-label="返回 Bot 配方"]').getAttribute('href'), '/');
  assert.equal(h.document.querySelector('a[href^="https://other.example"]'), null);
});

test('a legacy creator detail returns to the published state in My recipes', async t => {
  const h = await runtime(t, path + '?from=creator');
  assert.equal(h.document.querySelector('a[aria-label="返回我的配方"]').getAttribute('href'), '/library?state=published');
});

test('code confirmation identifies the exact recipe and version before any redemption', async t => {
  const h = await runtime(t, path);
  [...h.document.querySelectorAll('button')].find(button => button.textContent === '获取配方').click();
  await h.settle();
  const dialog = h.document.querySelector('dialog[open]');
  assert.match(dialog.textContent, /会议纪要/);
  assert.match(dialog.textContent, /版本 1\.2/);
  assert.equal(dialog.querySelector('input[aria-label="分享码"]').placeholder, '作者提供的分享码');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('legacy preparation text stays readable as ordinary overview notes without a preparation interface', async t => {
  const h = await runtime(t, path, {...recipe, acquired: true, config: {role: '角色', setup: {steps: [{kind: 'tool', title: '旧版说明', instructions: '旧版工具配置说明', required: true, check: '核对文档'}]}}});
  const notes = h.document.querySelector('details.additional-notes');
  assert.ok(notes);
  assert.equal(notes.open, false);
  assert.match(notes.textContent, /旧版工具配置说明/);
  assert.match(notes.textContent, /核对文档/);
  assert.equal(notes.querySelector('button,input'), null);
  assert.doesNotMatch(h.document.querySelector('main').textContent, /使用前准备/);
});
