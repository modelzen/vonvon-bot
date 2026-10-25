import {useEffect, useRef, useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {Button, IconButton} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import type {MachineRequest, MachineRequestHandler, MachineReply, ServiceState} from '@vonvon/protocol';
import '../settings/settings.css';
import {settingAnchor, type SearchReveal} from '../search';
import {useShellCapabilities} from '../client-context';

type MachineStatus = Extract<MachineReply, {type: 'status'}>;
/** The s07 states as `vonvon service status` tells them apart. */
const SERVICE_STATE_TEXT: Record<ServiceState, string> = {
  'not-installed': '未安装', running: '运行中', stopped: '已停止', disabled: '系统设置已关闭', detached: '独立运行', conflict: '需要处理', unknown: '状态未知',
};

export async function runMachineRequest(request: MachineRequestHandler, operation: MachineRequest, update: (status: MachineStatus | undefined) => void): Promise<MachineReply> {
  try {
    const reply = await request(operation);
    const status = operation.type === 'status' ? reply : await request({type: 'status'});
    if (status.type !== 'status') throw new Error('无法读取 daemon 状态');
    update(status);
    return reply;
  } catch (error) {
    update(undefined);
    throw error;
  }
}

export function MachinePanel({request, agents, reveal, macos = false}: {request: MachineRequestHandler; agents: ReadonlyArray<{id: string; name: string}>; reveal?: SearchReveal; macos?: boolean}) {
  const shell = useShellCapabilities();
  const advanced = useRef<HTMLDetailsElement>(null);
  useEffect(() => {if (reveal === 'machine-advanced' && advanced.current) advanced.current.open = true;}, [reveal]);
  const [status, setStatus] = useState<MachineStatus>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [bot, setBot] = useState('');
  const [confirm, setConfirm] = useState<MachineRequest>();
  const refresh = () => runMachineRequest(request, {type: 'status'}, setStatus);
  useEffect(() => { void refresh().catch(error => setMessage(String(error))); }, [request]);
  const run = async (operation: MachineRequest) => {
    setBusy(true);
    try {
      const reply = await runMachineRequest(request, operation, setStatus);
      if (reply.type === 'done') setMessage(reply.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const runShell = async (operation: () => Promise<MachineReply>) => {
    setBusy(true);
    try {
      const reply = await operation();
      if (reply.type === 'done') setMessage(reply.message);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const service = status?.service;
  const serviceStartDisabled = !status || !status.service.installed || status.service.running || status.host?.ownership === 'attached';

  return <>
    <SettingsGroup id={settingAnchor('daemon 运行')} label="daemon 运行" action={<IconButton size="sm" variant="ghost" label="刷新状态" title="刷新后台运行状态" disabled={busy} onClick={() => void run({type: 'status'})}><RefreshCw size={15} strokeWidth={1.7}/></IconButton>}>
      <SettingsRow title="运行方式"
        description={status?.host?.ownership === 'attached' ? '当前由外部服务管理。' : '接收飞书消息并运行 Bot。'}
        value={!status ? '状态未知' : status.host ? (status.host.ownership === 'owned' ? '桌面管理' : '外部服务') : '已停止'} />
      <SettingsRow title="daemon 服务" description={!shell?.startHost ? '启动功能由桌面版提供。停止服务可能中断正在进行的 Bot 任务。' : '停止服务可能中断正在进行的 Bot 任务。'}
        trailing={<span className="settings-inline-actions">
          <Button size="sm" disabled={busy || !!status?.host || !shell?.startHost} onClick={() => {if (shell?.startHost) void runShell(shell.startHost);}}>启动 daemon</Button>
          <Button size="sm" disabled={busy || status?.host?.ownership !== 'owned'} onClick={() => setConfirm({type: 'stopHost'})}>停止 daemon</Button>
        </span>} />
      {status?.temporaryAgent && <SettingsRow title="临时运行 Bot" description="默认 Bot 选择未改变。" value={status.temporaryAgent} />}
    </SettingsGroup>

    <SettingsGroup id={settingAnchor('后台服务')} label="后台服务" footer={macos ? '开启「登录电脑时启动」后，退出 App 仍可运行 Bot。' : '后台服务可在应用退出后继续运行 Bot。'}>
      <SettingsRow title="系统服务" description={service ? service.platformName : '正在读取服务状态…'}
        value={service && (service.state ? SERVICE_STATE_TEXT[service.state] : `${service.installed ? '已安装' : '未安装'} · ${service.running ? '运行中' : '已停止'}`)} />
      <SettingsRow title="服务运行" description={!shell?.service ? '请在桌面版中启动服务。' : '启动已安装的后台服务。'}
        trailing={<span className="settings-inline-actions">
          <Button size="sm" disabled={busy || !shell?.service || serviceStartDisabled} onClick={() => setConfirm({type: 'service', action: 'start'})}>启动服务</Button>
        </span>} />
      <details ref={advanced} className="settings-disclosure">
        <summary>高级</summary>
        <SettingsRow title="仅运行指定 Bot" description={!shell?.startHost ? '请在桌面版中选择要临时运行的 Bot。' : '临时运行前需停止当前 daemon。此操作不会修改默认启用列表。'}
          trailing={<span className="settings-inline-actions">
            <select aria-label="临时运行的 Bot" value={bot} onChange={event => setBot(event.target.value)} disabled={busy}>
              <option value="">选择 Bot</option>
              {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
            <Button size="sm" disabled={busy || !bot || !!status?.host || !shell?.startHost} onClick={() => {const startHost = shell?.startHost; if (startHost) void runShell(() => startHost(bot));}}>仅运行此 Bot</Button>
          </span>} />
        <SettingsRow title="进程 PID" value={status?.host?.pid ?? service?.pid ?? '无'} />
        <SettingsRow title="上次退出" value={service?.lastExit ?? '无记录'} />
        <SettingsRow title="服务定义" value={service?.servicePath ?? '未读取'} />
        <SettingsRow title="标准输出" value={service?.stdoutPath ?? '未读取'} />
        <SettingsRow title="错误日志" value={service?.stderrPath ?? '未读取'} />
      </details>
    </SettingsGroup>
    <Dialog open={!!confirm} title="确认更改 daemon 运行方式" onClose={() => setConfirm(undefined)} footer={<>
      <Button onClick={() => setConfirm(undefined)}>取消</Button>
      <Button variant="danger" onClick={() => { const operation = confirm; const service = shell?.service; setConfirm(undefined); if (operation?.type === 'service' && service) void runShell(() => service(operation.action)); else if (operation && operation.type !== 'service') void run(operation); }}>确认操作</Button>
    </>}><p>此操作可能停止正在进行的所有 Bot 任务。启动后台服务后，daemon 会在桌面退出后继续运行。</p></Dialog>
    {message && <p className="settings-operation-message" role="status">{message}</p>}
  </>;
}
