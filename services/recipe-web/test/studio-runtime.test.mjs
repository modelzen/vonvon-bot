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
    if (path === '/api/v2/me/account-profile') {assert.equal(options.headers['X-Vonvon-Session'],state.displaySession);return Response.json({authorId:'11111111-1111-4111-8111-111111111111',displayName:'当前创作者',revision:1});}
    if (path === '/api/v1/me/drafts' || path === '/api/v2/me/publications') return Response.json({items: []});
    throw Error('Unexpected studio request ' + path);
  };
  const location = {get pathname(){return window.location.pathname;}, get search(){return window.location.search;}, get href(){return window.location.href;}, get origin(){return window.location.origin;}, assigned:[], reloads:0, reload(){this.reloads++;}, assign(path){this.assigned.push(path);}};
  const run = new AsyncFunction('document', 'window', 'location', 'history', 'fetch', 'BroadcastChannel', source);
  await run(window.document, window, location, window.history, fetch, undefined);
  await settle();
  return {window, document: window.document, calls, state, location};
}

function assertGuide(document) {
  const main = document.querySelector('main');
  assert.equal(main.querySelectorAll('form,input,textarea,select,[contenteditable="true"]').length, 0, 'website studio must not expose manual authoring controls');
  assert.equal(main.querySelector('h1')?.textContent, '在 Bot 私聊中创作');
  assert.match(main.textContent, /Bot 私聊里说「把周报群的配置做成配方」/);
  assert.match(main.textContent, /App 点「创作配方」.*选好 Bot 和群聊/s);
  assert.match(main.textContent, /本地 App 的「我的配方 → 创作中」/);
  assert.match(main.textContent, /点「发布到社区」.*发布为新配方.*已有的配方发布新版本/s);
  assert.doesNotMatch(main.textContent, /按卡片选择|确认来源/);
  assert.match(main.textContent, /已获取.*创作中.*已发布.*App/s);
  assert.doesNotMatch(main.textContent, /新建文字草稿|保存草稿|在私聊中查看完整预览|准备新版|生成分享码/);
  assert.equal(document.querySelector('header .brand').textContent, 'Vonvon 灵感社区');
  assert.equal(document.querySelector('header .brand img').getAttribute('src'), '/community-logo.webp');
  assert.equal(document.querySelector('main form'),null);
}

for (const route of ['/studio', '/studio?draftId=old-draft', '/studio.html', '/studio.html?draftId=old-draft', '/studio?login=1', '/studio.html?login=1', '/studio.html?login=1&next=studio']) {
  test(`${route} returns account login to the canonical App guide`, async t => {
    const h = await runtime(t, {route});
    const assertReturn=()=>{
      const redirect=new URL(h.location.assigned.at(-1),'https://recipes.example');
      assert.equal(redirect.pathname,'/login');assert.equal(returnPath(redirect.searchParams.get('returnTo')),'/studio');
      assert.equal(redirect.searchParams.has('continuation'),false);assert.equal(h.document.querySelector('#modal form'),null);
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
    assert.deepEqual(h.calls.map(call => call.path), signedIn?['/auth/session','/api/v2/me/account-profile']:['/auth/session']);
    assert.equal(h.document.querySelector('#account').textContent, '登录');
    assert.equal(h.document.querySelector('#account').hidden, signedIn);
    if(signedIn)assert.match(h.document.querySelector('.account-menu summary').textContent,/当前创作者/);
    h.document.querySelector('#account').click();
    const form = h.document.querySelector('#modal form');
    if (signedIn) {
      assert.equal(h.location.assigned.length, 0); assert.equal(form, null);
      assert.equal(h.document.querySelector('.account-menu a[href^="/account#account="]').getAttribute('href'), '/account#account=11111111-1111-4111-8111-111111111111');
    } else {
      assert.equal(form,null);assert.equal(h.location.assigned.at(-1),'/login?returnTo=%2Fstudio');
    }
    assertGuide(h.document);
  });
}

for (const route of ['/studio?draftId=11111111-1111-4111-8111-111111111111', '/studio.html?id=old-draft']) for (const signedIn of [false, true]) {
  test(`${route} preserves the guide across ${signedIn ? 'logout' : 'login'} without opening an old draft`, async t => {
    const h = await runtime(t, {signedIn, route});
    assertGuide(h.document);
    assert.deepEqual(h.calls.map(call => call.path),signedIn?['/auth/session','/api/v2/me/account-profile']:['/auth/session']);
    h.document.querySelector('#account').click();
    assert.equal(h.document.querySelector('#modal').open,false);
    if (signedIn) assert.equal(h.location.assigned.length, 0);
    else assert.equal(h.location.assigned.at(-1), '/login?returnTo=%2Fstudio');
    h.state.signedIn = !signedIn; h.state.displaySession = signedIn ? null : 'new-author-session';
    h.window.dispatchEvent(new h.window.Event('focus'));
    await settle();
    assertGuide(h.document);
    assert.equal(h.calls.every(call => ['/auth/session','/api/v2/me/account-profile'].includes(call.path)), true);
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
