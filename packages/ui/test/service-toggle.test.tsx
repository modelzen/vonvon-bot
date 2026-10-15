import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConnectionError, RpcError} from '@vonvon/client/browser';
import type {ApplicationService, DesktopSnapshot, MachineReply, MachineRequest} from '@vonvon/protocol';
import {LoginServiceRow, skipService, toggleService} from '../src/setup/service-toggle';

const machine = (reply: (request: MachineRequest) => Promise<MachineReply> = async request => ({type: 'done', message: `did ${request.type}`})) => ({machine: vi.fn(reply)});

it('turns the service on from the web page through the daemon, clearing the skip first', async () => {
  const client = machine(async request => ({type: 'done', message: request.type === 'service' ? '正在打开登录时启动，页面会断开几秒。' : '已取消跳过。'}));
  await expect(toggleService(true, client, undefined)).resolves.toBe('正在打开登录时启动，页面会断开几秒。');
  expect(client.machine.mock.calls.map(([request]) => request)).toEqual([{type: 'setServiceSkipped', skipped: false}, {type: 'service', action: 'install'}]);
  const off = machine();
  await toggleService(false, off, {});
  expect(off.machine.mock.calls.map(([request]) => request)).toEqual([{type: 'setServiceSkipped', skipped: true}, {type: 'service', action: 'uninstall'}]);
});

it('takes a dropped connection as the handover and passes a refusal on', async () => {
  const dropped = machine(async request => { if (request.type === 'service') throw new ConnectionError(new Error('socket closed')); return {type: 'done', message: ''}; });
  await expect(toggleService(false, dropped, undefined)).resolves.toBe('正在关闭登录时启动，页面会断开几秒。');
  const busy = machine(async request => { if (request.type === 'service') throw new RpcError('busy', '另一个后台服务操作正在进行，等它结束再试。'); return {type: 'done', message: ''}; });
  await expect(toggleService(true, busy, undefined)).rejects.toThrow('另一个后台服务操作正在进行');
});

it('lets the desktop shell run the helper when it has one', async () => {
  const client = machine();
  const setLoginItem = vi.fn(async () => {});
  await expect(toggleService(true, client, {setLoginItem})).resolves.toBe('已打开登录时启动。');
  await expect(toggleService(false, client, {setLoginItem})).resolves.toBe('已关闭登录时启动。bot 改成单独启动的 daemon，这样崩溃后不会自动重启。');
  expect(setLoginItem.mock.calls).toEqual([[true], [false]]);
  expect(client.machine.mock.calls.map(([request]) => request)).toEqual([{type: 'setServiceSkipped', skipped: false}, {type: 'setServiceSkipped', skipped: true}]);
});

it('skips by remembering the choice only', async () => {
  const client = machine();
  await expect(skipService(client)).resolves.toBe('已跳过。bot 跑在分离的 daemon 里，这样崩溃后不会自动重启。');
  expect(client.machine.mock.calls.map(([request]) => request)).toEqual([{type: 'setServiceSkipped', skipped: true}]);
});

const application = (fields: Partial<DesktopSnapshot['application']> = {}, service?: Partial<ApplicationService>): DesktopSnapshot['application'] =>
  ({platform: 'macos', version: '1', loginItem: false, dataPath: '/tmp', service: service && {state: 'not-installed', skipped: false, ...service}, ...fields});
const row = (value: DesktopSnapshot['application'], busy = false) => renderToStaticMarkup(<LoginServiceRow application={value} busy={busy} onToggle={() => {}}/>);
const switchTag = (html: string) => html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? '';

it('shows the switch on macOS only, with the state it cannot change', () => {
  expect(row(application({platform: 'unsupported'}, {}))).toBe('');
  expect(row(application({platform: 'windows'}, {}))).toBe('');
  const ready = row(application({}, {}));
  expect(ready).toContain('登录电脑时启动');
  expect(ready).not.toContain('桌面版提供');
  expect(switchTag(ready)).not.toContain('disabled');
  expect(switchTag(row(application({}, {}), true))).toContain('disabled');
  // No manager read yet, an action running, or an install that cannot work.
  expect(switchTag(row(application()))).toContain('disabled');
  const opening = row(application({}, {action: {action: 'install', phase: 'running', startedAt: 1}}));
  expect(opening).toContain('正在打开…');
  expect(switchTag(opening)).toContain('disabled');
  const blocked = row(application({}, {blocked: 'development'}));
  expect(blocked).toContain('开发版不能装');
  expect(switchTag(blocked)).toContain('disabled');
  // Turned off in System Settings: shown off and still clickable.
  const off = row(application({loginItem: false}, {state: 'disabled'}));
  expect(off).toContain('已在系统设置里关掉');
  expect(switchTag(off)).not.toContain('disabled');
  expect(switchTag(off)).not.toContain('checked');
  expect(switchTag(row(application({loginItem: true}, {state: 'detached'})))).toContain('checked');
  const failed = row(application({}, {action: {action: 'install', phase: 'done', ok: false, reason: 'busy', startedAt: Date.now(), finishedAt: Date.now()}}));
  expect(failed).toContain('另一个后台服务操作正在进行，等它结束再试。');
});
