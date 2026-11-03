import {useMemo, useRef, useState} from 'react';
import {ArrowRightLeft, Pencil, Trash2} from 'lucide-react';
import {deviceAliasSchema, type DeviceRow} from '@vonvon/protocol';
import {useDevicesState, useShellCapabilities} from '../client-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {ConfirmDialog} from '../reference/components/ui/Dialog';
import {useDraft, useDraftGuard} from '../settings/DraftGuard';
import {addBlockedReason, copy, registryNotices, removeCopy, rowView} from './devices-presentation';
import {CopyText, DeviceTile, platformIcon, RowMenu, StatusPill, TailscaleAdvice, useNow, type RowMenuItem} from './device-bits';
import {AddDeviceDialog} from './AddDeviceDialog';

const reportSwitchFailure = (error: unknown) => console.error('Device switch failed', error);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A name typed and not saved is a draft: switching devices or leaving the page asks first (Codex 审查 237-1). */
export function RenameRow({row, onDone}: {row: DeviceRow; onDone: () => void}) {
  const devices = useShellCapabilities()?.devices;
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string>();
  const save = async (): Promise<boolean> => {
    if (!deviceAliasSchema.safeParse(name).success) { setError(copy.invalidName); return false; }
    try { await devices?.rename(row.id, name.trim()); }
    catch (failure) { setError(message(failure)); return false; }
    onDone();
    return true;
  };
  const latest = useRef({save, onDone});
  latest.current = {save, onDone};
  const draft = useMemo(() => ({title: '设备名字', save: () => latest.current.save(), discard: () => latest.current.onDone()}), []);
  useDraft(name.trim() !== row.name, draft);
  return <form className="device-rename" onSubmit={event => { event.preventDefault(); void save(); }}>
    <input aria-label="设备名字" value={name} maxLength={60} autoFocus onChange={event => { setName(event.target.value); setError(undefined); }}/>
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
    <header className="today-page-heading today-page-heading--actions"><div><h1>设备</h1></div>
      <Button disabled={Boolean(blocked)} title={blocked} onClick={() => setDialog({})}>添加设备</Button>
    </header>
    <p className="device-page-intro">{copy.panelIntro}</p>
    {registryNotices(state).map(text => <InlineNotice key={text} title="设备列表" tone="warning">{text}</InlineNotice>)}
    {notice && <InlineNotice title="已删除" tone="info" actions={<Button size="sm" onClick={() => setNotice(undefined)}>知道了</Button>}><CopyText text={notice}/></InlineNotice>}
    <ul className="device-list">{state.devices.map(row => {
      const view = rowView(row, now, localName);
      const local = row.id === 'local';
      // As before: this computer while shown has no 切换到, nor does a device shown and online (it was greyed out); one
      // shown and not online keeps it, to connect again.
      const canSwitch = !(local && row.current) && !(row.current && row.status === 'online');
      const menu: RowMenuItem[][] = local ? [] : [
        [...view.repair && canSwitch ? [{label: '切换到', icon: ArrowRightLeft, onSelect: () => switchTo(row.id)}] : [],
          {label: '改名', icon: Pencil, onSelect: () => setRenaming(row.id)}],
        [{label: '删除', icon: Trash2, danger: true, onSelect: () => setRemoving({row})}],
      ];
      return <li className="device-row" key={row.id} data-device={local ? 'local' : 'remote'} data-current={row.current || undefined}>
        <DeviceTile icon={platformIcon(row.platform)}/>
        {renaming === row.id ? <RenameRow row={row} onDone={() => setRenaming(undefined)}/> : <>
          <div className="device-row__copy">
            <span className="device-row__title"><strong>{view.title}</strong>{row.current && <span className="device-tag">当前</span>}<StatusPill tone={view.tone}>{view.status}</StatusPill></span>
            {view.detail.length > 0 && <small>{view.detail.join(' · ')}</small>}
          </div>
          <div className="device-row__actions">
            {view.repair ? <Button size="sm" onClick={() => setDialog({repairOf: row})}>重新配对</Button>
              : canSwitch && <Button size="sm" onClick={() => switchTo(row.id)}>切换到</Button>}
            {!local && <RowMenu label={`「${row.name}」的更多操作`} groups={menu}/>}
          </div>
        </>}
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
