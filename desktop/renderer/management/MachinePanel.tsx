import {useEffect, useRef, useState} from 'react';
import {Button} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import type {MachineRequest, MachineRequestHandler, MachineReply} from '../../shared/machine';
import '../settings/settings.css';
import {settingAnchor, type SearchReveal} from '../search';

export function MachinePanel({request, agents, reveal}: {request: MachineRequestHandler; agents: ReadonlyArray<{id: string; name: string}>; reveal?: SearchReveal}) {
  const advanced = useRef<HTMLDetailsElement>(null);
  useEffect(() => {if (reveal === 'machine-advanced' && advanced.current) advanced.current.open = true;}, [reveal]);
  const [status, setStatus] = useState<Extract<MachineReply, {type: 'status'}>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [bot, setBot] = useState('');
  const [confirm, setConfirm] = useState<MachineRequest>();
  const refresh = async () => {
    const reply = await request({type: 'status'});
    if (reply.type === 'status') setStatus(reply);
  };
  useEffect(() => { void refresh().catch(error => setMessage(String(error))); }, [request]);
  const run = async (operation: MachineRequest) => {
    setBusy(true);
    try {
      const reply = await request(operation);
      if (reply.type === 'done') setMessage(reply.message);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const service = status?.service;
  const serviceDisabled = (action: 'install' | 'start' | 'stop' | 'uninstall') =>
    !status || (action === 'install'
      ? status.service.installed || status.host?.ownership === 'attached'
      : action === 'start'
        ? !status.service.installed || status.service.running || status.host?.ownership === 'attached'
        : !status.service.installed);

  return <>
    <SettingsGroup id={settingAnchor('命令行工具')} label="命令行工具" footer="安装后请打开新的终端，输入 vonvon-bot。兼容命令 vonvon-bridge 和 feishu-codex-bridge 也可用。">
      <SettingsRow title="vonvon-bot" description={status?.cli.kind==='error'?status.cli.message:status?.cli.bin??'正在检查…'}
        value={status?.cli.kind==='ready'?'已安装':'需要修复'}
        trailing={<Button size="sm" disabled={busy} onClick={() => void run({type:'repairCli'})}>修复命令行工具</Button>} />
    </SettingsGroup>
    <SettingsGroup id={settingAnchor('Bridge 运行')} label="Bridge 运行" action={<Button size="sm" disabled={busy} onClick={() => void run({type: 'status'})}>刷新状态</Button>}>
      <SettingsRow title="运行方式"
        description={status?.host?.ownership === 'attached' ? '当前由外部服务管理。' : 'Bridge 负责接收飞书消息并运行 Bot。'}
        value={!status ? '正在读取…' : status.host ? (status.host.ownership === 'owned' ? '桌面管理' : '外部服务') : '已停止'} />
      <SettingsRow title="Bridge 服务" description="停止服务可能中断正在进行的 Bot 任务。"
        trailing={<span className="settings-inline-actions">
          <Button size="sm" disabled={busy || !!status?.host} onClick={() => void run({type: 'startHost'})}>启动 Bridge</Button>
          <Button size="sm" disabled={busy || status?.host?.ownership !== 'owned'} onClick={() => setConfirm({type: 'stopHost'})}>停止 Bridge</Button>
        </span>} />
      {status?.temporaryAgent && <SettingsRow title="临时运行 Bot" description="默认 Bot 选择未改变。" value={status.temporaryAgent} />}
    </SettingsGroup>

    <SettingsGroup id={settingAnchor('后台服务')} label="后台服务" footer="后台服务在桌面退出后仍运行。桌面应用的登录启动是另一项设置。">
      <SettingsRow title="系统服务" description={service?.platformName ?? '正在读取服务状态…'}
        value={service ? `${service.installed ? '已安装' : '未安装'} · ${service.running ? '运行中' : '已停止'}` : undefined} />
      <SettingsRow title="安装并启动" description="让 Bridge 在桌面应用关闭后继续运行。"
        trailing={<Button size="sm" disabled={busy || serviceDisabled('install')} onClick={() => setConfirm({type: 'service', action: 'install'})}>安装并启动后台服务</Button>} />
      <SettingsRow title="服务运行" description="已安装的服务可单独启动或停止。"
        trailing={<span className="settings-inline-actions">
          <Button size="sm" disabled={busy || serviceDisabled('start')} onClick={() => setConfirm({type: 'service', action: 'start'})}>启动已安装服务</Button>
          <Button size="sm" disabled={busy || serviceDisabled('stop')} onClick={() => setConfirm({type: 'service', action: 'stop'})}>停止后台服务并关闭自启</Button>
        </span>} />
      <SettingsRow title="卸载后台服务" description="移除系统服务及其自动启动设置。"
        trailing={<Button size="sm" disabled={busy || serviceDisabled('uninstall')} onClick={() => setConfirm({type: 'service', action: 'uninstall'})}>卸载后台服务</Button>} />
      <details ref={advanced} className="settings-disclosure">
        <summary>高级</summary>
        <SettingsRow title="仅运行指定 Bot" description="临时运行前需停止当前 Bridge。此操作不会修改默认启用列表。"
          trailing={<span className="settings-inline-actions">
            <select aria-label="临时运行的 Bot" value={bot} onChange={event => setBot(event.target.value)} disabled={busy}>
              <option value="">选择 Bot</option>
              {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
            <Button size="sm" disabled={busy || !bot || !!status?.host} onClick={() => void run({type: 'startHost', bot})}>仅运行此 Bot</Button>
          </span>} />
        <SettingsRow title="进程 PID" value={status?.host?.pid ?? service?.pid ?? '无'} />
        <SettingsRow title="上次退出码" value={service?.lastExit ?? '无记录'} />
        <SettingsRow title="服务定义" value={service?.servicePath ?? '未读取'} />
        <SettingsRow title="标准输出" value={service?.stdoutPath ?? '未读取'} />
        <SettingsRow title="错误日志" value={service?.stderrPath ?? '未读取'} />
      </details>
    </SettingsGroup>
    <Dialog open={!!confirm} title="确认更改 Bridge 运行方式" onClose={() => setConfirm(undefined)} footer={<>
      <Button onClick={() => setConfirm(undefined)}>取消</Button>
      <Button variant="danger" onClick={() => { const operation = confirm; setConfirm(undefined); if (operation) void run(operation); }}>确认操作</Button>
    </>}><p>此操作可能停止正在进行的所有 Bot 任务。安装或启动后台服务后，Bridge 会在桌面退出后继续运行。</p></Dialog>
    {message && <p className="settings-operation-message" role="status">{message}</p>}
  </>;
}
