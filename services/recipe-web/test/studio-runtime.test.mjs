import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {returnPath} from '../auth.mjs';

const html = await readFile(new URL('../public/studio.html', import.meta.url), 'utf8');
const studio = await readFile(new URL('../public/studio.mjs', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = studio.replace("import './app.mjs';", app);
const settle = async () => {for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise(setImmediate);};

async function runtime(t, {signedIn = false, route = '/studio', sessionFails = false} = {}) {
  const dom = new JSDOM(html, {url: 'https://recipes.example' + route, pretendToBeVisual: true});
  t.after(() => dom.window.close());
  const {window} = dom, calls = [], state = {signedIn, displaySession: signedIn ? 'author-session' : null};
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const fetch = async (path, options = {}) => {
    calls.push({path, options});
    if (path === '/auth/session') {
      if (sessionFails) throw Error('Synthetic session outage');
      return Response.json({...state, providers: ['github']});
    }
    if (path === '/api/v1/me/drafts' || path === '/api/v2/me/publications') return Response.json({items: []});
    throw Error('Unexpected studio request ' + path);
  };
  const location = {pathname: window.location.pathname, search: window.location.search, href: window.location.href, reloads: 0, reload() {this.reloads++;}};
  const run = new AsyncFunction('document', 'window', 'location', 'history', 'fetch', 'BroadcastChannel', source);
  await run(window.document, window, location, window.history, fetch, undefined);
  await settle();
  return {window, document: window.document, calls, state, location};
}

function assertGuide(document) {
  const main = document.querySelector('main');
  assert.equal(main.querySelectorAll('form,input,textarea,select,[contenteditable="true"]').length, 0, 'website studio must not expose manual authoring controls');
  assert.equal(main.querySelector('h1')?.textContent, '在 Bot 私聊中创作');
  assert.match(main.textContent, /社区.*我的配方.*创作配方/s);
  assert.match(main.textContent, /Bot.*已有群聊/s);
  assert.match(main.textContent, /飞书私聊/);
  assert.match(main.textContent, /App 查看完整预览.*App 确认发布.*飞书卡片上直接确认发布/s);
  assert.match(main.textContent, /已获取.*创作中.*已发布.*App/s);
  assert.doesNotMatch(main.textContent, /新建文字草稿|保存草稿|在私聊中查看完整预览|准备新版|生成分享码/);
  assert.equal(document.querySelector('a[href="/"]')?.textContent.includes('Vonvon Bot'), true);
  assert.equal(document.querySelector('#library-link')?.getAttribute('href'), '/library');
}

for (const route of ['/studio', '/studio?draftId=old-draft', '/studio.html', '/studio.html?draftId=old-draft', '/studio?login=1', '/studio.html?login=1', '/studio.html?login=1&next=studio']) {
  test(`${route} returns account login to the canonical App guide`, async t => {
    const h = await runtime(t, {route});
    const assertReturn = () => {
      const form = h.document.querySelector('#modal form');
      assert.equal(form.getAttribute('action'), '/auth/start');
      const next = form.querySelector('[name="returnTo"]').value;
      assert.equal(returnPath(next), '/studio', 'the real auth return path must keep visitors on the App guide');
      assert.equal(form.querySelector('[name="continuation"]'), null);
    };
    if (route.includes('login=1')) assertReturn();
    h.document.querySelector('#account').click();
    assertReturn();
    assertGuide(h.document);
    assert.deepEqual(h.calls.map(call => call.path), ['/auth/session']);
  });
}

test('the static App guide offers the official desktop download page as a secondary text link', t => {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const download = dom.window.document.querySelector('main a[href="https://vonvon.cc/get/"]');
  assert.ok(download, 'visitors without the App need a real official download link');
  assert.match(download.textContent, /官网.*下载/);
  assert.equal(download.classList.contains('button'), false);
  assertGuide(dom.window.document);
});

for (const signedIn of [false, true]) {
  test(`studio is an App guide for ${signedIn ? 'signed-in authors' : 'anonymous visitors'} and installs no creator actions`, async t => {
    const h = await runtime(t, {signedIn});
    assertGuide(h.document);
    assert.deepEqual(h.calls.map(call => call.path), ['/auth/session']);
    assert.equal(h.document.querySelector('#account').textContent, signedIn ? '账号' : '登录');
    h.document.querySelector('#account').click();
    const form = h.document.querySelector('#modal form');
    assert.equal(form.getAttribute('action'), signedIn ? '/auth/logout' : '/auth/start');
    assert.equal(form.getAttribute('method'), 'post');
    if (!signedIn) assert.equal(form.querySelector('[name="returnTo"]').value, '/studio');
    assertGuide(h.document);
  });
}

for (const route of ['/studio?draftId=11111111-1111-4111-8111-111111111111', '/studio.html?id=old-draft']) for (const signedIn of [false, true]) {
  test(`${route} preserves the guide across ${signedIn ? 'logout' : 'login'} without opening an old draft`, async t => {
    const h = await runtime(t, {signedIn, route});
    assertGuide(h.document);
    assert.deepEqual(h.calls.map(call => call.path), ['/auth/session']);
    h.document.querySelector('#account').click();
    assert.equal(h.document.querySelector('#modal').open, true);
    h.state.signedIn = !signedIn; h.state.displaySession = signedIn ? null : 'new-author-session';
    h.window.dispatchEvent(new h.window.Event('focus'));
    await settle();
    assertGuide(h.document);
    assert.equal(h.calls.every(call => call.path === '/auth/session'), true);
    assert.equal(h.location.reloads, 1);
    assert.equal(h.document.querySelector('#modal').open, false);
  });
}

test('the App instructions are readable before JavaScript and during a session outage', async t => {
  const staticPage = new JSDOM(html);
  t.after(() => staticPage.window.close());
  assertGuide(staticPage.window.document);
  const h = await runtime(t, {sessionFails: true});
  assertGuide(h.document);
  assert.deepEqual(h.calls.map(call => call.path), ['/auth/session']);
});
