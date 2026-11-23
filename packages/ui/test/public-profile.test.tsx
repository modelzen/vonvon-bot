// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {communityFailureMessages, communityRequestSchema, type CommunityRequest, type CommunityResponses} from '@vonvon/protocol';
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
  handle = async request => ({authorId: request.accountId, displayName: request.type === 'saveProfile' ? request.displayName : '已保存昵称'});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
it('reads the server name, validates inline and saves only on explicit submission', async () => {
  await draw(); expect(requests).toEqual([{type: 'profile', accountId}]);
  expect(document.querySelector('input')!.value).toBe('已保存昵称');
  expect(button('保存资料').disabled).toBe(true);
  for (const name of [' ', 'a@b', 'a\u0001b', 'a'.repeat(61)]) {await fill(name); expect(button('保存资料').disabled).toBe(true);}
  await fill('  新署名  '); expect(requests).toHaveLength(1);
  await click('保存资料');
  expect(requests[1]).toMatchObject({type: 'saveProfile', accountId, displayName: '新署名'});
  expect(document.querySelector('input')!.value).toBe('新署名'); expect(document.body.textContent).toContain('个人资料已保存');
});
it('supports retry after read and save failures while retaining input', async () => {
  handle = async () => {throw new Error('offline');}; await draw();
  expect(document.body.textContent).toContain('暂时无法读取');
  handle = async () => ({authorId: accountId, displayName: '旧署名'}); await click('重试');
  await fill('保留的输入'); handle = async () => {throw new Error('offline');}; await click('保存资料');
  expect(document.querySelector('input')!.value).toBe('保留的输入'); expect(document.body.textContent).toContain('保存结果尚未确认');
  handle = async () => ({authorId: accountId, displayName: '保留的输入'}); await click('保存资料');
  expect(document.body.textContent).toContain('个人资料已保存');
});

it('explains a definite invalid avatar rejection without suggesting the cloud may have saved it', async () => {
  await draw(); await fill('保留的昵称');
  handle = async () => {throw new Error(communityFailureMessages.invalid_logo);};
  await click('保存资料');
  expect(document.body.textContent).toContain('2048 × 2048');
  expect(document.body.textContent).toContain('头像未通过校验');
  expect(document.body.textContent).not.toContain('保存结果尚未确认');
  expect(document.querySelector('input')!.value).toBe('保留的昵称');
  expect(requests.map(value => value.type)).toEqual(['profile', 'saveProfile']);
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
  await click('保存资料'); expect(button('保存中…').disabled).toBe(true); expect(document.querySelector('input')!.disabled).toBe(true);
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(requests.filter(request => request.type === 'saveProfile')).toHaveLength(1);
  await draw(otherId); await act(async () => save.resolve({authorId: accountId, displayName: '旧账号响应'}));
  expect(document.querySelector('input')!.value).toBe('另一署名');
  expect(document.body.textContent).not.toContain('个人资料已保存');
});

it('reconciles a committed save whose response was lost and permits reverting it', async () => {
  let cloud = '旧署名';
  handle = async request => {
    if (request.type === 'saveProfile') {cloud = request.displayName; throw new Error('response lost');}
    return {authorId: accountId, displayName: cloud};
  };
  await draw(); await fill('想撤回的署名'); await click('保存资料');
  expect(cloud).toBe('想撤回的署名');
  expect(requests.map(request => request.type)).toEqual(['profile', 'saveProfile', 'profile']);
  expect(document.body.textContent).toContain('当前读到的云端昵称');
  expect(document.body.textContent).toContain('保存结果尚未确认');
  expect(button('重新读取').disabled).toBe(false);
  expect(button('保存资料').disabled).toBe(false);
  await fill('旧署名'); expect(button('保存资料').disabled).toBe(false);
  await click('保存资料'); expect(cloud).toBe('旧署名');
});
it('allows explicit overwrite of an uncertain remote value and read-only retry', async () => {
  let cloud = '旧署名', offline = false;
  handle = async request => {
    if (request.type === 'saveProfile') {cloud = request.displayName; offline = true; throw new Error('response lost');}
    if (offline) throw new Error('offline');
    return {authorId: accountId, displayName: cloud};
  };
  await draw(); await fill('新署名'); await click('保存资料');
  expect(document.body.textContent).toContain('保存结果尚未确认');
  await click('重新读取');
  expect(document.body.textContent).toContain('暂时无法读取云端资料');
  expect(document.body.textContent).toContain('保存结果尚未确认');
  expect(document.querySelector('input')!.value).toBe('新署名');
  expect(button('重新读取').disabled).toBe(false);
  await fill('旧署名'); expect(button('保存资料').disabled).toBe(false);
  await click('保存资料'); expect(cloud).toBe('旧署名');
  expect(requests.filter(request => request.type === 'saveProfile')).toHaveLength(2);
  offline = false; await click('重新读取');
  expect(document.body.textContent).toContain('保存结果尚未确认');
  expect(button('保存资料').disabled).toBe(false);
  expect(document.querySelector('input')!.value).toBe('旧署名');
  expect(requests.filter(request => request.type === 'saveProfile')).toHaveLength(2);
});
it('discards late reconciliation after switching accounts', async () => {
  const check = deferred<CommunityResponses['profile']>();
  await draw(); await fill('旧账号提交');
  handle = request => request.type === 'saveProfile' ? Promise.reject(new Error('lost')) : request.accountId === accountId ? check.promise : Promise.resolve({authorId: otherId, displayName: '另一署名'});
  await click('保存资料'); await draw(otherId);
  await act(async () => check.resolve({authorId: accountId, displayName: '迟到署名'}));
  expect(document.querySelector('input')!.value).toBe('另一署名');
  expect(document.body.textContent).not.toContain('已重新核对');
});

it('keeps recovery available when a lost save commits after the follow-up read', async () => {
  let cloud = '旧署名';
  let commit = () => {};
  handle = async request => {
    if (request.type === 'saveProfile') {
      commit = () => {cloud = request.displayName;};
      throw new Error('connection closed after request was accepted');
    }
    return {authorId: accountId, displayName: cloud};
  };
  await draw(); await fill('想撤回的署名'); await click('保存资料');
  expect(cloud).toBe('旧署名');
  expect(document.body.textContent).toContain('当前读到的云端昵称为「旧署名」');
  commit();
  await fill('旧署名');
  expect(button('保存资料').disabled).toBe(false);
  expect(button('重新读取').disabled).toBe(false);
  await click('重新读取');
  expect(document.body.textContent).toContain('当前读到的云端昵称为「想撤回的署名」');
  expect(document.body.textContent).toContain('保存结果尚未确认');
  expect(document.querySelector('input')!.value).toBe('旧署名');
  handle = async request => {
    if (request.type === 'saveProfile') cloud = request.displayName;
    return {authorId: accountId, displayName: cloud};
  };
  await click('保存资料');
  expect(cloud).toBe('旧署名');
  expect(document.body.textContent).toContain('个人资料已保存');
  expect(document.body.textContent).not.toContain('保存结果尚未确认');
  expect(button('保存资料').disabled).toBe(true);
  expect(requests.map(request => request.type)).toEqual(['profile', 'saveProfile', 'profile', 'profile', 'saveProfile']);
});

it('edits the existing account nickname without a separate author identity', async () => {
  handle = async request => ({authorId: accountId, displayName: request.type === 'saveProfile' ? request.displayName : '账号昵称', revision: request.type === 'saveProfile' ? 2 : 1});
  const identity = {kind: 'signedIn', accountId, displayName: '账号昵称', provider: 'github', persistence: 'secure'} as const;
  await act(async () => root.render(<PublicProfile accountId={accountId} shell={shell} identity={identity}/>));
  expect(document.querySelector('input')!.value).toBe('账号昵称');
  expect(document.body.textContent).toContain('修改昵称后，App 和你所有配方上的昵称会一起更新');
  expect(document.body.textContent).not.toContain('公开昵称');
  expect(document.body.textContent).not.toContain('作者署名');
  expect(document.body.textContent).not.toContain('建议昵称');
  expect(requests).toEqual([{type: 'profile', accountId}]);
  expect(button('保存资料').disabled).toBe(true);
  await fill('新的账号昵称'); await click('保存资料');
  expect(requests[1]).toMatchObject({type: 'saveProfile', accountId, displayName: '新的账号昵称', revision: 1});
  expect(button('保存资料').disabled).toBe(true);
});
it('previews a selected raster and saves its bytes only on explicit confirmation', async () => {
  handle = async request => ({authorId: accountId, displayName: request.type === 'saveProfile' ? request.displayName : '旧昵称', revision: request.type === 'saveProfile' ? 2 : 1});
  await draw();
  const file = new File(['raster bytes'], 'avatar.png', {type: 'image/png'});
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', {value: [file], configurable: true});
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(requests).toHaveLength(1);
  expect(document.querySelector('.account-profile-avatar-edit img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  await click('保存资料');
  expect(requests[1]).toMatchObject({type: 'saveProfile', displayName: '旧昵称', revision: 1, avatar: {kind: 'replace', base64: btoa('raster bytes')}});
});
it('preserves an unsubmitted avatar while reporting invalid image choices', async () => {
  await draw();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', {value: [new File(['<svg/>'], 'avatar.svg', {type: 'image/svg+xml'})], configurable: true});
    input.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(document.body.textContent).toContain('请选择不超过 2 MiB');
  expect(requests).toHaveLength(1);
});
