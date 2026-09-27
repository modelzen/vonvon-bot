import {useState} from 'react';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {useDraftGuard} from '../settings/DraftGuard';
import type {MachineReply, MachineRequest, MachineRequestHandler, DesktopUpdate} from '../../shared/machine';
import '../settings/settings.css';
import {settingAnchor} from '../search';

export function UpdatePanel({request, attached}: {request: MachineRequestHandler; attached: boolean}) {
  const {navigate} = useDraftGuard();
  const [desktop, setDesktop] = useState<DesktopUpdate>();
  const [core, setCore] = useState<Extract<MachineReply, {type: 'coreUpdate'}>>();
  const [desktopMessage, setDesktopMessage] = useState('');
  const [coreMessage, setCoreMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (operation: MachineRequest, channel: 'desktop' | 'core') => {
    setBusy(true);
    const report = channel === 'desktop' ? setDesktopMessage : setCoreMessage;
    try {
      const reply = await request(operation);
      if (reply.type === 'desktopUpdate') setDesktop(reply.update);
      if (reply.type === 'coreUpdate') setCore(reply);
      if (reply.type === 'done') report(reply.message);
      if (reply.type === 'coreUpdateStatus')
        report(reply.status
          ? `${({installing: '正在安装', restarting: '正在重启', done: '更新完成', error: '更新失败'})[reply.status.phase]} ${reply.status.message ?? ''} ${reply.status.from ?? ''} → ${reply.status.to ?? ''}`
          : '尚无更新记录');
    } catch (error) {
      report(error instanceof Error ? error.message : '更新失败');
    } finally {
      setBusy(false);
    }
  };
  const desktopState = desktop?.state === 'available' ? '有可用更新'
    : desktop?.state === 'downloaded' ? '已下载，可安装'
      : desktop?.state === 'current' ? '已是最新版本'
        : desktop?.state === 'unavailable' ? '更新源不可用' : '尚未检查';
  return <>
    <SettingsGroup id={settingAnchor('软件更新')} label="软件更新" footer="桌面更新包含内置 Core。检查更新不会安装软件。">
      <SettingsRow title="桌面版" value={desktop?.current ?? '尚未检查'} />
      <SettingsRow title="更新状态" description={desktop?.message} value={desktopState} />
      {desktop?.latest && <SettingsRow title="可用版本" value={desktop.latest} />}
      <SettingsRow title="检查更新" trailing={<Button size="sm" disabled={busy} onClick={() => void run({type: 'checkDesktopUpdate'}, 'desktop')}>检查桌面更新</Button>} />
      {(desktop?.state === 'available' || desktop?.state === 'downloaded') && <SettingsRow
        title={desktop.state === 'downloaded' ? '安装更新' : '下载更新'}
        trailing={<Button size="sm" disabled={busy} onClick={() => {
          if (desktop.state === 'downloaded') navigate(() => void run({type: 'installDesktopUpdate'}, 'desktop'));
          else void run({type: 'installDesktopUpdate'}, 'desktop');
        }}>{desktop.state === 'downloaded' ? '安装并重启' : '下载更新'}</Button>} />}
      <SettingsRow title="发布说明" trailing={<Button size="sm" disabled={busy} onClick={() => void run({type: 'openReleases'}, 'desktop')}>查看发布说明</Button>} />
      {desktopMessage && <p className="settings-operation-message" role="status">{desktopMessage}</p>}
    </SettingsGroup>
    <SettingsGroup id={settingAnchor('外部 Core / CLI')} label="外部 Core / CLI" footer={attached ? '更新外部 Core 不会更改桌面版本。' : '内置 Core 随桌面更新，无需单独安装。'}>
      <SettingsRow title="Core 来源" value={core ? (core.distribution.kind === 'global-npm' ? '全局 npm 安装' : '当前 Core 不由全局 npm 管理') : '尚未检查'} />
      {core && <SettingsRow title="当前版本" value={core.current} />}
      {core && <SettingsRow title="可用版本" value={core.latest ?? '更新源不可用'} />}
      <SettingsRow title="检查 Core 更新" trailing={<Button size="sm" disabled={busy} onClick={() => void run({type: 'checkCoreUpdate'}, 'core')}>检查 Core 更新</Button>} />
      <SettingsRow title="更新外部 Core" trailing={<Button size="sm" disabled={busy || !attached || core?.distribution.kind !== 'global-npm' || !core?.hasUpdate} onClick={() => void run({type: 'applyCoreUpdate'}, 'core')}>更新外部 Core</Button>} />
      <SettingsRow title="更新进度" trailing={<Button size="sm" disabled={busy || !attached} onClick={() => void run({type: 'coreUpdateStatus'}, 'core')}>查看 Core 更新进度</Button>} />
      {coreMessage && <p className="settings-operation-message" role="status">{coreMessage}</p>}
    </SettingsGroup>
  </>;
}
