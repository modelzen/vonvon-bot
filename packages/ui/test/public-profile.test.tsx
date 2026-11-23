// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {communityRequestSchema, type CommunityRequest, type CommunityResponses} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {PublicProfile} from '../src/accounts/PublicProfile';

const accountId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
let root: Root;
let requests: CommunityRequest[];
let handle: (request: CommunityRequest) => Promise<unknown>;
const shell = createDesktopFacades({receive: () => () => {}, invoke: async (_channel, raw) => {
  const request = communityRequestSchema.parse(raw);
  requests.push(request);
  return {ok: true, value: await handle(request)};
}}).shell.community!;
const draw = async (id = accountId) => {await act(async () => root.render(<PublicProfile key={id} accountId={id} shell={shell}/>));};
const button = (label: string) => [...document.querySelectorAll('button')].find(value => value.textContent === label)!;
async function fill(value: string) {
  const input = document.querySelector('input')!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true}));});
}
async function click(label: string) {await act(async () => button(label).click());}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')!); requests = [];
  handle = async request => ({authorId: request.accountId, displayName: request.type === 'saveProfile' ? request.displayName : '配方作者'});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
it('reads the server name, validates inline and saves only on explicit submission', async () => {
  await draw(); expect(requests).toEqual([{type: 'profile', accountId}]);
  expect(document.querySelector('input')!.value).toBe('配方作者');
  expect(button('保存署名').disabled).toBe(true);
  for (const name of [' ', 'a@b', 'a\u0001b', 'a'.repeat(61)]) {await fill(name); expect(button('保存署名').disabled).toBe(true);}
  await fill('  新署名  '); expect(requests).toHaveLength(1);
  await click('保存署名');
  expect(requests[1]).toMatchObject({type: 'saveProfile', accountId, displayName: '新署名'});
  expect(document.querySelector('input')!.value).toBe('新署名'); expect(document.body.textContent).toContain('公开署名已保存');
});
it('supports retry after read and save failures while retaining input', async () => {
  handle = async () => {throw new Error('offline');}; await draw();
  expect(document.body.textContent).toContain('暂时无法读取');
  handle = async () => ({authorId: accountId, displayName: '旧署名'}); await click('重试');
  await fill('保留的输入'); handle = async () => {throw new Error('offline');}; await click('保存署名');
  expect(document.querySelector('input')!.value).toBe('保留的输入'); expect(document.body.textContent).toContain('署名未能保存');
  handle = async () => ({authorId: accountId, displayName: '保留的输入'}); await click('保存署名');
  expect(document.body.textContent).toContain('公开署名已保存');
});
it('discards late reads after switching accounts', async () => {
  const old = deferred<CommunityResponses['profile']>();
  handle = request => request.accountId === accountId ? old.promise : Promise.resolve({authorId: otherId, displayName: '另一个作者'});
  await draw(); expect(document.body.textContent).toContain('正在读取'); await draw(otherId);
  await act(async () => old.resolve({authorId: accountId, displayName: '旧账号'}));
  expect(document.querySelector('input')!.value).toBe('另一个作者');
});
it('blocks duplicate saves and discards their completion after an account switch', async () => {
  await draw(); await fill('新署名'); const save = deferred<CommunityResponses['saveProfile']>();
  handle = request => request.type === 'saveProfile' ? save.promise : Promise.resolve({authorId: otherId, displayName: '另一署名'});
  await click('保存署名'); expect(button('保存中…').disabled).toBe(true); expect(document.querySelector('input')!.disabled).toBe(true);
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(requests.filter(request => request.type === 'saveProfile')).toHaveLength(1);
  await draw(otherId); await act(async () => save.resolve({authorId: accountId, displayName: '旧账号响应'}));
  expect(document.querySelector('input')!.value).toBe('另一署名');
  expect(document.body.textContent).not.toContain('公开署名已保存');
});
