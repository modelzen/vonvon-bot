import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRecipeWeb} from '../server.mjs';

test('browser detail and preview aliases read compact display data without any broker member request', async t => {
  const recipeId = '22222222-2222-4222-8222-222222222222', versionId = '33333333-3333-4333-8333-333333333333';
  const value = {recipeId, versionId, revision: 1, format: 'rich-v2', state: 'listed', owned: false, acquired: false,
    creator: {authorId: '11111111-1111-4111-8111-111111111111', displayName: '作者'}, hasDisplayLogo: true,
    public: {name: '轻量配方', summary: '简介', overview: '概览', version: '1', access: 'direct'},
    preview: {settings: [], skills: [{itemId: recipeId, name: '技能名', description: '公开说明'}], ruleCount: 3, taskCount: 0}};
  const calls = [], brokerCalls = [];
  async function start(server) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
    return 'http://127.0.0.1:' + server.address().port;
  }
  const api = await start(createServer((req, res) => {calls.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));}));
  const broker = await start(createServer((req, res) => {brokerCalls.push(req.url); res.writeHead(500); res.end();}));
  const web = await start(createRecipeWeb({RECIPE_API_ORIGIN: api, RECIPE_BROKER_ORIGIN: broker}));
  const path = `/v2/recipes/${recipeId}/versions/${versionId}`;
  for (const suffix of ['', '/preview']) {
    const response = await fetch(web + '/api' + path + suffix);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), value);
  }
  value.state = 'withdrawn'; value.acquired = true;
  assert.equal((await fetch(web + '/api' + path + '/preview')).status, 200);
  assert.deepEqual(calls, [path + '/preview', path + '/preview', path + '/preview']);
  assert.deepEqual(brokerCalls, []);
});
