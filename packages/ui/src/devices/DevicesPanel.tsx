import {useState} from 'react';
import {deviceAliasSchema, type DeviceRow} from '@vonvon/protocol';
import {useDevicesState, useShellCapabilities} from '../client-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {ConfirmDialog} from '../reference/components/ui/Dialog';
import {useDraftGuard} from '../settings/DraftGuard';
import {addBlockedReason, copy, registryNotices, removeCopy, rowView} from './devices-presentation';
import {CopyText, StatusDot, TailscaleAdvice, useNow} from './device-bits';
import {AddDeviceDialog} from './AddDeviceDialog';

const reportSwitchFailure = (error: unknown) => console.error('Device switch failed', error);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function RenameRow({row, onDone}: {row: DeviceRow; onDone: () => void}) {
  const devices = useShellCapabilities()?.devices;
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string>();
  const save = () => {
    if (!deviceAliasSchema.safeParse(name).success) { setError(copy.invalidName); return; }
    void devices?.rename(row.id, name.trim()).then(onDone, failure => setError(message(failure)));
  };
  return <form className="device-rename" onSubmit={event => { event.preventDefault(); save(); }}>
    <input aria-label="设备名字" value={name} maxLength={60} onChange={event => { setName(event.target.value); setError(undefined); }}/>
    <Button size="sm" type="submit" variant="primary">保存</Button><Button size="sm" type="button" onClick={onDone}>取消</Button>
    {error && <p className="device-problem" role="alert">{error}</p>}
  </form>;
}

/** devices-ui-1b 4.5: settings → 设备. */
export function DevicesPanel() {
  const state = useDevicesState();
  const devices = useShellCapabilities()?.devices;
  const {navigate} = useDraftGuard();
  const now = useNow(60_000);
  const [dialog, setDialog] = useState<{repairOf?: DeviceRow}>();
  const [renaming, setRenaming] = useState<string>();
  const [removing, setRemoving] = useState<{row: DeviceRow; pending?: boolean; error?: string}>();
  const [notice, setNotice] = useState<string>();
  if (!state || !devices) return null;
  const switchTo = (id: string) => navigate(() => void devices.switchTo(id).catch(reportSwitchFailure));
  const blocked = addBlockedReason(state);
  const remove = async (row: DeviceRow) => {
    setRemoving({row, pending: true});
    try {
      const result = await devices.remove(row.id);
      setRemoving(undefined);
      if (!result.revokedRemotely) setNotice(removeCopy.kept(`「${row.name}」`));
    } catch (error) { setRemoving({row, error: message(error)}); }
  };
  const localName = state.active.id === 'local' ? state.active.serverInfo?.deviceName : undefined;
  return <section className="devices-page" aria-label="设备">
    <header className="today-page-heading"><h1>设备</h1></header>
    <p className="device-muted">{copy.panelIntro}</p>
    {registryNotices(state).map(text => <InlineNotice key={text} title="设备列表" tone="warning">{text}</InlineNotice>)}
    {notice && <InlineNotice title="已删除" tone="info" actions={<Button size="sm" onClick={() => setNotice(undefined)}>知道了</Button>}><CopyText text={notice}/></InlineNotice>}
    <div className="device-actions">
      <Button variant="primary" disabled={Boolean(blocked)} onClick={() => setDialog({})}>添加设备</Button>
      {blocked && <span className="device-muted">{blocked}</span>}
    </div>
    <ul className="device-list">{state.devices.map(row => {
      const view = rowView(row, now, localName);
      const local = row.id === 'local';
      return <li key={row.id} className="device-row" data-device={local ? 'local' : 'remote'}>
        <StatusDot tone={view.tone}/>
        <div className="device-row__copy"><strong>{view.title}</strong><small>{[...view.detail, view.status].join(' · ')}</small></div>
        {renaming === row.id ? <RenameRow row={row} onDone={() => setRenaming(undefined)}/> : <div className="device-actions">
          {view.repair && <Button size="sm" onClick={() => setDialog({repairOf: row})}>重新配对</Button>}
          {!(local && row.current) && <Button size="sm" disabled={row.current && row.status === 'online'} onClick={() => switchTo(row.id)}>切换到</Button>}
          {!local && <Button size="sm" onClick={() => setRenaming(row.id)}>改名</Button>}
          {!local && <Button size="sm" variant="danger" onClick={() => setRemoving({row})}>删除</Button>}
        </div>}
      </li>;
    })}</ul>
    <TailscaleAdvice/>
    {dialog && <AddDeviceDialog repairOf={dialog.repairOf} onClose={() => setDialog(undefined)} onSwitch={switchTo}/>}
    {removing && <ConfirmDialog open tone="danger" confirmLabel="删除" pending={removing.pending} error={removing.error}
      title={removeCopy.title(`「${removing.row.name}」`)}
      description={removeCopy.body(`「${removing.row.name}」`, removing.row.current && removing.row.status === 'online')}
      onCancel={() => setRemoving(undefined)} onConfirm={() => void remove(removing.row)}><span/></ConfirmDialog>}
  </section>;
}
