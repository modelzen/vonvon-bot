import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:http';
import {createRecipeWeb} from '../server.mjs';
import {draftAppUrl} from '../public/open-draft.mjs';
const draftId = '8d85af21-e80d-4665-a6b8-ccf162dc1923';
const fragment = '#' + draftId + '?revision=2';
async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('landing URL only opens an exact draft in its configured channel', () => {
  assert.equal(draftAppUrl(fragment, 'preview'), 'vonvon-preview://recipes/drafts/' + draftId + '?revision=2');
  assert.equal(draftAppUrl(fragment, 'stable'), 'vonvon://recipes/drafts/' + draftId + '?revision=2');
  for (const bad of ['', fragment + '&publish=true', fragment + '&revision=3', fragment + '#x', fragment + '\n',
    fragment.replace('revision=2', 'revision=0'), fragment.replace('revision=2', 'revision=02'),
    fragment.replace('revision=2', 'revision=9007199254740992'), fragment.replace('-', '%2d')]) {
    assert.equal(draftAppUrl(bad, 'preview'), undefined, bad);
  }
  assert.equal(draftAppUrl(fragment, 'https://untrusted.example'), undefined);
});

test('opening landing script prepares a user-click link without networking or automatic navigation', async () => {
  const source = (await readFile(new URL('../public/open-draft.mjs', import.meta.url), 'utf8')).replace('export function', 'function');
  const button = {hidden: true}, status = {};
  const location = {hash: fragment, search: ''};
  runInNewContext(source, {document: {
    documentElement: {dataset: {desktopChannel: 'preview'}},
    getElementById: id => id === 'open-app' ? button : status,
  }, location});
  assert.equal(button.href, 'vonvon-preview://recipes/drafts/' + draftId + '?revision=2');
  assert.equal(button.hidden, false);
  assert.deepEqual(location, {hash: fragment, search: ''});
  assert.match(status.textContent, /请点击按钮/);
});

test('static landing does not access accounts or API and refuses redirect/auth queries', async t => {
  const calls = [];
  const api = await listen(createServer((req, res) => {calls.push(req.url); res.end('{}');}), t);
  const base = await listen(createRecipeWeb({RECIPE_WEB_PORT: '49151', RECIPE_API_ORIGIN: api}), t);
  const response = await fetch(base + '/open/draft' + fragment);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  const html = await response.text();
  assert.match(html, /data-desktop-channel="preview"/);
  assert.match(html, /打开预览不会发布/);
  assert.ok(!html.includes(draftId));
  for (const path of ['/open-draft.mjs', '/open-draft.css']) assert.equal((await fetch(base + path)).status, 200);
  for (const query of ['?next=https://evil.example', '?token=secret', '?channel=stable', '?revision=2']) {
    assert.equal((await fetch(base + '/open/draft' + query)).status, 400);
  }
  assert.equal((await fetch(base + '/open/draft', {method: 'POST'})).status, 400);
  assert.deepEqual(calls, []);
});

test('stable channel is explicit trusted configuration and invalid configuration fails closed', async t => {
  const base = await listen(createRecipeWeb({RECIPE_DESKTOP_CHANNEL: 'stable'}), t);
  assert.match(await (await fetch(base + '/open/draft')).text(), /data-desktop-channel="stable"/);
  assert.throws(() => createRecipeWeb({RECIPE_DESKTOP_CHANNEL: 'untrusted'}), /RECIPE_DESKTOP_CHANNEL/);
});
