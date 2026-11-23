import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {richFixture} from './rich-fixture.mjs';

const detailPath = version => '/recipes/' + version.recipeId + '/versions/' + version.versionId;
const settle = async () => {await new Promise(resolve => setTimeout(resolve, 25)); for (let i = 0; i < 5; i++) await new Promise(setImmediate);};
async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'the real HTTP interaction must reach its expected visible state');
}
async function browser(t, fixture, path, identity = {}, options = {}) {
  const html = await fetch(fixture.host + path).then(response => response.text());
  const dom = new JSDOM(html, {url: fixture.publicOrigin + path, runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom, calls = [];
  if (options.continuationNonce) window.sessionStorage.setItem('vv-recipe-login-continuation', JSON.stringify({path, nonce:options.continuationNonce}));
  const state = {identity, loseClaim: false, ...options};
  window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
  Object.defineProperty(window, 'crypto', {value: webcrypto});
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, fixture.publicOrigin), headers = {...options.headers};
    if (state.identity.cookie) headers.cookie = state.identity.cookie;
    if (options.method && options.method !== 'GET') headers.origin = fixture.publicOrigin;
    calls.push({path: url.pathname, options});
    if (state.detailGate && /^\/api\/v2\/recipes\//.test(url.pathname)) {state.detailStarted?.(); await state.detailGate;}
    if (state.failDetail && /^\/api\/v2\/recipes\//.test(url.pathname)) return Response.json({error:{code:'unavailable'}}, {status:503});
    const response = await fetch(fixture.host + url.pathname + url.search, {...options, headers});
    if (state.loseClaim && options.method === 'POST') {
      state.loseClaim = false; await response.arrayBuffer(); throw new Error('Synthetic transport loss after real API commit');
    }
    return response;
  };
  const modules = new Map();
  async function load(path) {
    if (!modules.has(path)) modules.set(path, (async () => {
      const source = await fetch(fixture.host + path).then(response => {assert.equal(response.status, 200, path); return response.text();});
      const module = new SourceTextModule(source, {context: dom.getInternalVMContext(), identifier: path,
        importModuleDynamically: async specifier => {const loaded = await load(new URL(specifier, fixture.publicOrigin + path).pathname); if (loaded.status === 'linked') await loaded.evaluate(); return loaded;}});
      await module.link((specifier, parent) => load(new URL(specifier, fixture.publicOrigin + parent.identifier).pathname)); return module;
    })());
    return modules.get(path);
  }
  const app = await load(path === '/studio' ? '/studio.mjs' : '/app.mjs'); await app.evaluate(); await settle();
  const find = label => [...window.document.querySelectorAll('button')].find(button => button.textContent === label);
  async function click(label) {const button = find(label) ?? [...window.document.querySelectorAll('[aria-label="配方详细信息"] a')].find(a => a.textContent === label); assert.ok(button, label); button.click(); await settle();}
  async function submit(code) {
    const form = window.document.querySelector('dialog form'); assert.ok(form);
    const input = form.querySelector('input'); input.value = code; input.dispatchEvent(new window.Event('input', {bubbles: true}));
    form.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true})); await settle();
  }
  return {window, calls, state, find, click, submit, text: () => window.document.querySelector('main').textContent};
}

test('real PostgreSQL API and shipped Web modules browse projections without downloading recipe members', async t => {
  const fixture = await richFixture(t);
  const direct = await fixture.publish('direct'), coded = await fixture.publish('coded');
  const directPath = detailPath(direct), codedPath = detailPath(coded);
  const get = (path, headers) => fetch(fixture.host + path, {headers});
  const old = await get('/api/v1' + codedPath);
  assert.equal(old.status, 409); assert.equal((await old.json()).error.code, 'request_upgrade_required');
  const before = fixture.brokerReads.length;
  const introResponse = await get('/api/v2' + codedPath + '/preview'), intro = await introResponse.json();
  assert.equal(introResponse.status, 200); assert.equal(intro.format, 'rich-v2');
  assert.equal(intro.creator.displayName, '合成作者');
  assert.equal(intro.rich, undefined); assert.equal(intro.config, undefined);
  assert.equal(intro.preview, undefined);
  assert.equal(intro.manifest, undefined); assert.equal(intro.release, undefined);
  assert.doesNotMatch(JSON.stringify(intro), /objectId|manifest|release|access_token|refresh_token|StorageURL/);
  assert.equal(intro.logo, undefined); assert.equal(intro.hasDisplayLogo, true);
  assert.deepEqual(fixture.brokerReads.slice(before), []);
  assert.equal(introResponse.headers.get('cache-control'), 'no-store');
  const directResponse = await get('/api/v2' + directPath + '/preview'), preview = await directResponse.json();
  assert.equal(directResponse.status, 200);
  assert.equal(preview.rich, undefined); assert.equal(preview.config, undefined);
  assert.equal(preview.manifest, undefined); assert.equal(preview.release, undefined);
  assert.equal(preview.preview.skills[0].name, '样例技能');
  assert.equal(preview.preview.skills[0].description, '核对环境并整理所选内容。');
  assert.equal(preview.preview.ruleCount, 1); assert.equal(preview.preview.taskCount, 1);
  assert.ok(preview.preview.settings.some(setting => setting.field === 'presentation.voiceEnabled' && setting.value === true));
  assert.doesNotMatch(JSON.stringify(preview), /objectId|canonical|ENTRY_PRIVATE_BODY_SENTINEL|完整正文|工作规则正文|任务执行说明|核对本地环境/);
  assert.deepEqual(fixture.brokerReads.slice(before), []);
  assert.deepEqual(await get('/api/v2' + directPath).then(response => response.json()), preview);
  assert.deepEqual(fixture.brokerReads.slice(before), []);
  const logoResponse = await get('/media/versions/' + direct.versionId + '/logo.webp');
  assert.equal(logoResponse.status, 200);
  assert.equal(logoResponse.headers.get('content-type'), 'image/webp');
  assert.equal(logoResponse.headers.get('cache-control'), 'no-store');
  const logoBytes = Buffer.from(await logoResponse.arrayBuffer());
  assert.equal(logoBytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(logoBytes.subarray(8, 12).toString(), 'WEBP');
  assert.equal((await get('/media/versions/' + coded.versionId + '/logo.webp')).status, 200);
  const memberReadsBeforeBrowse = fixture.brokerReads.length;
  const anonymous = await browser(t, fixture, directPath);
  assert.match(anonymous.text(), /合成作者/);
  assert.match(anonymous.text(), /1\.0/); assert.match(anonymous.text(), /直接获取/);
  assert.equal(anonymous.window.document.querySelector('#overview h2').textContent, '概览');
  assert.equal(anonymous.window.document.querySelector('main strong').textContent, '公开说明');
  assert.equal(anonymous.window.document.querySelector('main img').src, fixture.publicOrigin + '/media/versions/' + direct.versionId + '/logo.webp');
  assert.deepEqual([...anonymous.window.document.querySelectorAll('[aria-label="配方详细信息"] a')].map(button=>button.textContent), ['概览','模型与权限','能力','沟通方式','任务']);
  assert.equal(anonymous.find('使用前准备'), undefined);
  assert.equal(anonymous.window.document.querySelector('.web-recipe-notes'), null);
  const expected = {'模型与权限': '推荐模型', '能力': '样例技能', '沟通方式': '智能会话', '任务': '1 项任务'};
  for (const [tab, text] of Object.entries(expected)) {await anonymous.click(tab); assert.match(anonymous.text(), new RegExp(text));}
  assert.match(anonymous.text(), /核对环境并整理所选内容/);
  assert.doesNotMatch(anonymous.text(), /ENTRY_PRIVATE_BODY_SENTINEL|完整正文|角色说明|工作规则正文|任务执行说明|核对本地环境/);
  assert.ok(anonymous.calls.filter(call => call.path.startsWith('/api/v2/recipes/')).every(call => call.path.endsWith('/preview')));
  assert.equal(fixture.brokerReads.length, memberReadsBeforeBrowse);
  assert.equal(anonymous.window.document.querySelector('main script, main img[src="x"]'), null);
  assert.equal(anonymous.window.document.querySelector('main').innerHTML.includes('<script>alert(1)</script>'), false);
  assert.equal(anonymous.find('发布'), undefined); assert.equal(anonymous.find('管理分享码'), undefined);
  await anonymous.click('复制链接');
  assert.equal(anonymous.window.document.querySelector('input[aria-label="手动复制"]').value, fixture.publicOrigin + directPath);
  const locked = await browser(t, fixture, codedPath);
  assert.equal(locked.find('能力'), undefined); assert.match(locked.text(), /获取此版本后/);
  assert.equal(locked.window.document.querySelector('.web-recipe-notes'), null);
  assert.doesNotMatch(locked.text(), /核对本地环境/);
  assert.equal(locked.calls.some(call => call.path.includes('/objects/')), false);
  await locked.click('获取配方'); assert.match(locked.window.document.querySelector('dialog').textContent, /GitHub/);
  const reader = await fixture.login('reader'), other = await fixture.login('other'), author = await fixture.login('author');
  const readerBrowser = await browser(t, fixture, codedPath, reader);
  await readerBrowser.click('获取配方');
  assert.equal(readerBrowser.calls.filter(call => call.options.method === 'POST').length, 0);
  await readerBrowser.submit('WRONG-CODE');
  await until(() => readerBrowser.window.document.querySelector('dialog').textContent.includes('核对后重试'));
  assert.match(readerBrowser.window.document.querySelector('dialog').textContent, /核对后重试/);
  readerBrowser.state.loseClaim = true;
  await readerBrowser.submit(coded.firstCode);
  await until(() => readerBrowser.window.document.querySelector('dialog').textContent.includes('暂未确认'));
  assert.match(readerBrowser.window.document.querySelector('dialog').textContent, /暂未确认/);
  await readerBrowser.submit(coded.firstCode);
  await until(() => readerBrowser.text().includes('已保存在当前账号'));
  assert.match(readerBrowser.text(), /已保存在当前账号/);
  const posts = readerBrowser.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 3);
  assert.notEqual(posts[0].options.headers['Idempotency-Key'], posts[1].options.headers['Idempotency-Key']);
  assert.equal(posts[1].options.headers['Idempotency-Key'], posts[2].options.headers['Idempotency-Key']);
  assert.equal(posts.every(call => call.path === '/api/v2/versions/' + coded.versionId + '/redeem'), true);
  await readerBrowser.click('能力'); assert.match(readerBrowser.text(), /核对环境并整理所选内容/);
  assert.doesNotMatch(readerBrowser.text(), /ENTRY_PRIVATE_BODY_SENTINEL|完整正文|工作规则正文|任务执行说明/);
  assert.ok(readerBrowser.calls.filter(call => call.path.startsWith('/api/v2/recipes/')).every(call => call.path.endsWith('/preview')));
  assert.equal(fixture.brokerReads.length, memberReadsBeforeBrowse);
  const otherDetail = await get('/api/v2' + codedPath, other).then(response => response.json());
  assert.equal(otherDetail.rich, undefined); assert.equal(otherDetail.preview, undefined); assert.equal(otherDetail.acquired, false);
  assert.equal((await get('/api/v2' + codedPath, {...other, 'X-Vonvon-Session': reader['X-Vonvon-Session']})).status, 409);
  const claimPath = '/api/v2/versions/' + direct.versionId + '/acquire';
  const postHeaders = {...other, origin: fixture.publicOrigin, 'content-type': 'application/json', 'idempotency-key': 'a2.' + direct.versionId};
  assert.equal((await fetch(fixture.host + claimPath, {method: 'POST', headers: {...postHeaders, origin: 'https://wrong.example'}, body: '{}'})).status, 403);
  assert.equal((await fetch(fixture.host + claimPath, {method: 'POST', headers: {...postHeaders, 'X-Vonvon-Session': reader['X-Vonvon-Session']}, body: '{}'})).status, 409);
  for (const path of ['/api/v2/objects/' + direct.versionId + '/members/0', '/api/v2/authoring/' + direct.versionId + '/register', '/api/v2/versions/' + direct.versionId + '/objects/' + direct.versionId]) assert.equal((await get(path, author)).status, 404);
  const publications = await get('/api/v2/me/publications', author).then(response => response.json());
  assert.ok(publications.items.some(item => item.versionId === coded.versionId));
  const studio = await browser(t, fixture, '/studio', author);
  assert.equal(studio.window.document.querySelector('main h1').textContent, '在 Bot 私聊中创作');
  assert.match(studio.text(), /已获取.*创作中.*已发布.*App/s);
  assert.equal(studio.window.document.querySelector('main form,main input,main textarea'), null);
  assert.deepEqual(studio.calls.map(call => call.path), ['/auth/session']);
  const authorDetail = await browser(t, fixture, codedPath, author);
  await authorDetail.click('能力'); assert.match(authorDetail.text(), /样例技能/);
  const directReader = await browser(t, fixture, directPath, other);
  await directReader.click('获取配方'); await until(() => directReader.text().includes('已保存在当前账号')); assert.match(directReader.text(), /已保存在当前账号/);
  const library = await get('/api/v2/me/recipes', other).then(response => response.json());
  assert.ok(library.items.some(item => item.versionId === direct.versionId));
  const legacyDraft = await fixture.request('/v1/drafts', {public: {name: '旧版配方', summary: '兼容', overview: '# 旧版', version: '1', access: 'direct'}, config: {role: '旧版角色'}}, {key: crypto.randomUUID()});
  const legacy = await fixture.request('/v1/drafts/' + legacyDraft.draftId + '/publish', {}, {key: crypto.randomUUID(), revision: 1});
  const legacyBrowser = await browser(t, fixture, detailPath(legacy));
  assert.match(legacyBrowser.text(), /旧版配方/);
  assert.doesNotMatch(legacyBrowser.text(), /旧版角色/);
  assert.ok(legacyBrowser.calls.some(call => call.path === '/api/v2' + detailPath(legacy) + '/preview'));
  assert.ok(!legacyBrowser.calls.some(call => call.path.startsWith('/api/v1/recipes/')));
  const packageRoot = await mkdtemp(join(tmpdir(), 'vv-web-package-'));
  t.after(() => rm(packageRoot, {recursive: true, force: true}));
  const packaged = join(packageRoot, 'services/recipe-web'), source = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(packaged, {recursive: true});
  for (const file of ['server.mjs', 'auth.mjs', 'native-auth.mjs', 'release-code-oauth.mjs', 'release-code-store.mjs', 'public', 'dist', 'node_modules']) await cp(join(source, file), join(packaged, file), {recursive: true});
  await mkdir(join(packageRoot, 'services/recipe-api/src'), {recursive: true});
  await cp(new URL('../../recipe-api/src/credential-shapes.mjs', import.meta.url), join(packageRoot, 'services/recipe-api/src/credential-shapes.mjs'));
  const {createRecipeWeb} = await import(pathToFileURL(join(packaged, 'server.mjs')));
  const server = createRecipeWeb({RECIPE_WEB_ORIGIN: fixture.publicOrigin, RECIPE_API_ORIGIN: fixture.apiHost, RECIPE_BROKER_ORIGIN: fixture.brokerHost});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
  const packageHost = 'http://127.0.0.1:' + server.address().port;
  for (const asset of [directPath, '/viewer.mjs', '/viewer.css', '/app.mjs', '/vendor/markdown-it.mjs']) assert.equal((await fetch(packageHost + asset)).status, 200, asset);
  assert.equal((await fetch(packageHost + '/api/v2' + directPath)).status, 200);
  console.log('PASS real HTTP: compact direct and entitled browse projections; no member downloads during view/acquisition; coded intro only; independent normalized Logo; retry/session/CSRF; legacy browse.');
});

test('the App guide preserves a legacy PostgreSQL draft while owner Web BFF editing and publication remain compatible',async t=>{
  const fixture=await richFixture(t);
  const original={public:{name:'旧稿兼容验证',summary:'私人草稿',overview:'公开介绍保持原样',version:'1.0',access:'coded'},config:{role:'PRIVATE_ROLE_KEEP',setup:{steps:[{kind:'tool',title:'',instructions:'',required:true}]}}};
  const draft=await fixture.request('/v1/drafts',original,{key:crypto.randomUUID()});
  const rejected=await fetch(fixture.apiHost+'/v1/drafts/'+draft.draftId+'/publish',{method:'POST',headers:{authorization:'Bearer '+fixture.tokens.author,'content-type':'application/json','idempotency-key':crypto.randomUUID(),'if-match':'"1"'},body:'{}'});
  assert.equal(rejected.ok,false);assert.equal((await rejected.json()).error.code,'incomplete_setup');
  const author=await fixture.login('author'),studio=await browser(t,fixture,'/studio',author);
  assert.equal(studio.window.document.querySelector('main h1').textContent,'在 Bot 私聊中创作');
  assert.equal(studio.window.document.querySelector('main form,main input,main textarea'),null);
  assert.deepEqual(studio.calls.map(call=>call.path),['/auth/session']);
  const before=await fixture.request('/v1/drafts/'+draft.draftId);
  assert.deepEqual(before.config.setup,original.config.setup);
  assert.equal(before.revision,1);
  const writeHeaders={...author,origin:fixture.publicOrigin,'content-type':'application/json'};
  const saveResponse=await fetch(fixture.host+'/api/v1/drafts/'+draft.draftId,{method:'PATCH',headers:{...writeHeaders,'idempotency-key':crypto.randomUUID(),'if-match':'"1"'},body:JSON.stringify({public:original.public,config:{role:original.config.role}})});
  const saved=await saveResponse.json();assert.equal(saveResponse.status,200,JSON.stringify(saved.error));
  assert.equal(saved.draftId,draft.draftId);assert.equal(saved.revision,2);
  assert.deepEqual(saved.config,{role:'PRIVATE_ROLE_KEEP'});assert.equal(saved.public.overview,original.public.overview);
  const publishResponse=await fetch(fixture.host+'/api/v1/drafts/'+draft.draftId+'/publish',{method:'POST',headers:{...writeHeaders,'idempotency-key':crypto.randomUUID(),'if-match':'"2"'},body:'{}'});
  const version=await publishResponse.json();assert.equal(publishResponse.status,200,JSON.stringify(version.error));
  const published=await fixture.request('/v1'+detailPath(version));
  assert.deepEqual(published.config,{role:'PRIVATE_ROLE_KEEP'});assert.equal(published.public.overview,original.public.overview);
});

test('OAuth continuation resumes shipped rich-v2 direct and coded confirmation without acquiring', async t => {
  const fixture = await richFixture(t);
  for (const access of ['direct', 'coded']) {
    const version = await fixture.publish(access), path = detailPath(version);
    const start = await fetch(fixture.host + '/auth/start', {method:'POST', redirect:'manual', headers:{origin:fixture.publicOrigin}, body:new URLSearchParams({provider:'github', returnTo:path, continuation:'acquire', continuationNonce:'a'.repeat(64)})});
    const flowCookie = start.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const finish = await fetch(fixture.host + '/auth/callback?code=reader', {redirect:'manual', headers:{cookie:flowCookie}});
    assert.equal(finish.headers.get('location'), path);
    const identity = {cookie:finish.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')};
    // Another tab's ordinary status query must not swallow the pending continuation.
    const peek = await fetch(fixture.host + '/auth/session', {headers:identity}).then(r => r.json());
    assert.equal(peek.continuation, path);
    identity['X-Vonvon-Session'] = peek.displaySession;
    const consume = (returnTo, headers = identity) => fetch(fixture.host + '/auth/continuation', {method:'POST', headers:{origin:fixture.publicOrigin, ...headers}, body:new URLSearchParams({returnTo, continuationNonce:'a'.repeat(64)})});
    assert.equal((await consume(path, {...identity, origin:'https://other.example'})).status, 403);
    assert.equal((await consume(path, {...identity, 'X-Vonvon-Session':'stale'})).status, 409);
    assert.deepEqual(await consume('/library').then(r => r.json()), {consumed:false});
    const failed = await browser(t, fixture, path, identity, {failDetail:true, continuationNonce:'a'.repeat(64)});
    assert.match(failed.text(), /暂时无法打开/);
    assert.equal(failed.calls.some(c => c.path === '/auth/continuation'), false);
    const pending = await fetch(fixture.host + '/auth/session', {headers:identity}).then(r => r.json());
    assert.equal(pending.continuation, path);
    let release, started;
    const detailGate = new Promise(resolve => {release = resolve;});
    const detailStarted = new Promise(resolve => {started = resolve;});
    const initiatingTab = browser(t, fixture, path, identity, {continuationNonce:'a'.repeat(64), detailGate, detailStarted:started});
    await detailStarted;
    const otherTab = await browser(t, fixture, path, identity);
    assert.equal(otherTab.window.document.querySelector('dialog').open, false);
    assert.equal(otherTab.calls.some(c => c.path === '/auth/continuation'), false);
    assert.equal((await fetch(fixture.host + '/auth/session', {headers:identity}).then(r => r.json())).continuation, path);
    release();
    const page = await initiatingTab;
    assert.equal(page.window.document.querySelector('dialog').open, true);
    assert.equal(page.window.sessionStorage.getItem('vv-recipe-login-continuation'), null);
    assert.match(page.window.document.querySelector('dialog').textContent, access === 'coded' ? /输入分享码/ : /确认获取配方/);
    assert.equal(page.calls.filter(c => /\/(redeem|acquire)$/.test(c.path)).length, 0);
    const second = await browser(t, fixture, path, identity);
    assert.equal(second.window.document.querySelector('dialog').open, false);
    const refreshed = await browser(t, fixture, path, identity);
    assert.equal(refreshed.window.document.querySelector('dialog').open, false);
  }
});
