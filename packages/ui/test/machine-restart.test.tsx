import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {MachineReply, MachineRequestHandler} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {MachinePanel, runMachineRequest} from '../src/management/MachinePanel';

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});

const running: Extract<MachineReply, {type: 'status'}> = {
  type: 'status',
  service: {platformName: 'macOS', installed: false, running: false, servicePath: '', stdoutPath: '', stderrPath: ''},
  host: {ownership: 'owned', pid: 42},
  cli: {kind: 'ready', bin: '/usr/local/bin/vonvon', message: 'ready'},
};

it.each(['status', 'stopHost'] as const)('clears the stale owner when the initial %s request loses its connection, then accepts a fresh status after shell start', async operation => {
  let status: Extract<MachineReply, {type: 'status'}> | undefined;
  let reachable = true;
  let observed = running;
  const request = vi.fn<MachineRequestHandler>(async operation => {
    if (!reachable) throw new Error('Daemon connection lost');
    if (operation.type === 'status') {
      return observed;
    }
    throw new Error('Unexpected request');
  });
  const update = (next: typeof status) => { status = next; };
  await runMachineRequest(request, {type: 'status'}, update);
  expect(status?.host?.pid).toBe(42);
  reachable = false;
  let message = '';
  try { await runMachineRequest(request, {type: operation}, update); }
  catch (error) { message = error instanceof Error ? error.message : 'unknown'; }
  expect(status).toBeUndefined();
  expect(message).toBe('Daemon connection lost');
  expect(request).toHaveBeenNthCalledWith(2, {type: operation});
  expect(request).toHaveBeenCalledTimes(2);
  const startHost = vi.fn(async () => {
    reachable = true;
    observed = {...running, host: {ownership: 'owned', pid: 43}};
    return {type: 'done' as const, message: 'started'};
  });
  await startHost();
  await runMachineRequest(request, {type: 'status'}, update);
  expect(startHost).toHaveBeenCalledOnce();
  expect(status?.host?.pid).toBe(43);
});

it('clears the stale owner when stop replies but its following status request fails', async () => {
  let status: Extract<MachineReply, {type: 'status'}> | undefined = running;
  const request = vi.fn<MachineRequestHandler>(async operation => {
    if (operation.type === 'stopHost') return {type: 'done', message: 'stopping'};
    throw new Error('Daemon connection lost');
  });
  await expect(runMachineRequest(request, {type: 'stopHost'}, next => { status = next; }))
    .rejects.toThrow('Daemon connection lost');
  expect(status).toBeUndefined();
  expect(request).toHaveBeenNthCalledWith(1, {type: 'stopHost'});
  expect(request).toHaveBeenNthCalledWith(2, {type: 'status'});
});

it('offers start only when a desktop shell supplies the capability', () => {
  const request: MachineRequestHandler = async () => running;
  const render = (startHost?: () => Promise<MachineReply>) => renderToStaticMarkup(
    <ClientProvider client={client} shell={startHost ? {startHost} : undefined}>
      <MachinePanel request={request} agents={[{id: 'cli_selected', name: 'Selected'}]} />
    </ClientProvider>,
  );
  const startButton = (html: string) => html.match(/<button[^>]*><span>启动 daemon<\/span><\/button>/)?.[0];
  expect(startButton(render())).toContain('disabled');
  const unknown = render(async () => ({type: 'done', message: 'started'}));
  expect(startButton(unknown)).not.toContain('disabled');
  expect(unknown).toContain('状态未知');
  expect(unknown).not.toContain('已停止');
});

it('leaves installing and uninstalling the service to the 登录电脑时启动 switch', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}><MachinePanel request={async () => running} agents={[]} macos /></ClientProvider>);
  expect(html).toContain('开启「登录电脑时启动」后，退出 App 仍可运行 Bot。');
  for (const gone of ['安装并启动', '卸载后台服务']) expect(html).not.toContain(gone);
  expect(html).toContain('停止服务');
});

it('explains background service behavior without terminal instructions', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}><MachinePanel request={async () => running} agents={[]} /></ClientProvider>);
  expect(html).toContain('后台服务可在应用退出后继续运行 Bot。');
  expect(html).not.toContain('登录电脑时启动');
});
