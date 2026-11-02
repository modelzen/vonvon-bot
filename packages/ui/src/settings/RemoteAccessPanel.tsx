import {useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode} from 'react';
import {RefreshCw} from 'lucide-react';
import type {ClientRecord, DeviceReply, DeviceRequest, DeviceStatus} from '@vonvon/protocol';
import {useActiveDevice, useClient, type ActiveDevice} from '../client-context';
import {CopyText, TailscaleAdvice, useNow} from '../devices/device-bits';
import {copy, relativeTime} from '../devices/devices-presentation';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {settingAnchor} from '../search';
import {useDraft} from './DraftGuard';
import {
  addressRows, cascadeCount, CLIENT_KIND_LABEL, confirmedRequest, defaultPick, disableStep, enableErrorText, enableStep, hostOf, invitedByText,
  isRecent, kindLabel, LINK_EXPIRED, LINK_HELP, LINK_MOVED, LINK_SECTION, linkBlocked, linkCountdown, linkUsable, liveClients, NO_ADDRESS, PAIRED_SECTION, panelTitle, portHint, readErrorText,
  revokeConfirmText, riskFromReply, SECTION, SELF_TAG, selfText, stateText, type AddressRow, type ClientsReply, type Confirm, type Step,
} from './remote-access-presentation';
import './remote-access.css';

type Where = Pick<ActiveDevice, 'isRemote' | 'name'>;
/** `host`, `port`: the open address and port it was made on (Codex 审查 267-2、269-1). */
type Link = {text: string; expiresAt: number; host: string; port: number};
/** Why the last link is gone: it expired, or its address or port changed. */
type Gone = 'expired' | 'moved';
const codeOf = (error: unknown): string | undefined => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const validName = (name: string): boolean => name.trim().length >= 1 && name.trim().length <= 40;

/** A name typed and not saved is a draft, as the devices page's (Codex 审查 237-1). */
function NameForm({label, initial, onSave, onDone}: {label: string; initial: string; onSave: (name: string) => Promise<void>; onDone: () => void}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const save = async (): Promise<boolean> => {
    if (!validName(name)) { setError(copy.invalidName); return false; }
    try { await onSave(name.trim()); } catch (failure) { setError(messageOf(failure)); return false; }
    onDone();
    return true;
  };
  const latest = useRef({save, onDone});
  latest.current = {save, onDone};
  const draft = useMemo(() => ({title: label, save: () => latest.current.save(), discard: () => latest.current.onDone()}), [label]);
  useDraft(name.trim() !== initial, draft);
  return <form className="remote-rename" onSubmit={event => { event.preventDefault(); void save(); }}>
    <input aria-label={label} value={name} maxLength={60} onChange={event => { setName(event.target.value); setError(undefined); }}/>
    <Button size="sm" type="submit" variant="primary">保存</Button><Button size="sm" type="button" onClick={onDone}>取消</Button>
    {error && <span className="remote-error" role="alert">{error}</span>}
  </form>;
}

/**
 * devices-ui-3 4.4: 应用与启动 → 允许别的设备连接, of the device shown. Read when it opens, every 10 seconds while the page
 * is visible, and when the device says a client paired or was revoked. The link lives in this component only.
 */
export function RemoteAccessPanel() {
  const client = useClient();
  const where = useActiveDevice();
  const [status, setStatus] = useState<DeviceStatus>();
  const [clients, setClients] = useState<ClientsReply>();
  const [readError, setReadError] = useState<string>();
  const [picked, setPicked] = useState<string>();
  const [link, setLink] = useState<Link>();
  const [gone, setGone] = useState<Gone>();
  const [confirm, setConfirm] = useState<Confirm>();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{text: string; error?: boolean}>();
  const [renaming, setRenaming] = useState<string>();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The device object is built again on every devices state; the reads only need its words.
  const whereRef = useRef(where);
  whereRef.current = where;
  const readClients = useCallback(async () => {
    const reply = await client.device({type: 'clients'});
    if (alive.current && reply.kind === 'clients') setClients(reply);
  }, [client]);
  const read = useCallback(async (refresh = false) => {
    try {
      const [reply] = await Promise.all([client.device(refresh ? {type: 'status', refresh} : {type: 'status'}), readClients()]);
      if (!alive.current) return;
      if (reply.kind === 'deviceStatus') setStatus(reply.status);
      setReadError(undefined);
    } catch (error) { if (alive.current) setReadError(readErrorText(codeOf(error), messageOf(error), whereRef.current)); }
  }, [client, readClients]);
  useEffect(() => {
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void read(); }, 10_000);
    const visible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', visible);
    const off = client.onDevice(() => { void readClients().catch(() => undefined); });
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); off(); };
  }, [client, read, readClients]);
  const rows = useMemo(() => status ? addressRows(status) : [], [status]);
  useEffect(() => { if (!picked || !rows.some(row => row.host === picked)) setPicked(defaultPick(rows)); }, [rows, picked]);
  const now = useNow(link ? 1_000 : 60_000);
  useEffect(() => { if (link && now >= link.expiresAt) { setLink(undefined); setGone('expired'); } }, [link, now]);
  // A link made on an address that was replaced, closed or moved to another port cannot connect, whoever changed it.
  const port = status?.remote.port;
  useEffect(() => { if (link && !linkUsable(link, rows, port)) { setLink(undefined); setGone('moved'); } }, [link, rows, port]);

  async function send(request: DeviceRequest): Promise<DeviceReply | undefined> {
    setBusy(true);
    setNotice(undefined);
    try {
      const reply = await client.device(request);
      if (!alive.current) return undefined;
      if (reply.kind === 'deviceStatus') setStatus(reply.status);
      if (reply.kind === 'clients') setClients(reply);
      if (reply.kind === 'device') setStatus(current => current && {...current, device: reply.device});
      return reply;
    } catch (error) {
      if (!alive.current) return undefined;
      const code = codeOf(error) ?? '';
      if (request.type === 'enable' && code === 'confirm_required') { setTicked(false); setConfirm({kind: 'risk', host: request.host, text: riskFromReply(messageOf(error))}); }
      else setNotice({text: request.type === 'enable' ? enableErrorText(code, messageOf(error)) : messageOf(error), error: true});
      return undefined;
    } finally { if (alive.current) setBusy(false); }
  }
  async function act(step: Step) {
    if ('confirm' in step) { setTicked(false); setConfirm(step.confirm); return; }
    const reply = await send(step.request);
    if (!reply) return;
    if (step.request.type === 'enable') setNotice({text: `已开启 ${step.request.host}。`});
    if (step.request.type === 'disable') setNotice({text: '已关闭远程连接，别的设备暂时连不上了。'});
    if (reply.kind === 'revoked') { setNotice({text: `已撤销 ${reply.revoked.length} 台。`}); void read(); }
  }
  async function pair() {
    const open = rows.find(row => row.enabled);
    if (linkBlocked(rows) || !open || port === undefined) return;
    setGone(undefined);
    const reply = await send({type: 'pair'});
    if (reply?.kind === 'pairingLink') setLink({text: reply.link, expiresAt: reply.expiresAt, host: open.host, port});
  }
  const rename = async (request: DeviceRequest) => {
    const reply = await client.device(request);
    if (reply.kind === 'device') setStatus(current => current && {...current, device: reply.device});
    if (reply.kind === 'clients') setClients(reply);
  };
  const confirmed = confirm ? confirmedRequest(confirm, ticked) : undefined;
  return <RemoteAccessView where={where} status={status} clients={clients} rows={rows} picked={picked} link={link} gone={gone} now={now}
    busy={busy} notice={notice} readError={readError} renaming={renaming}
    onPick={setPicked} onRefresh={() => void read(true)}
    onEnable={() => picked && void act(enableStep(rows, picked, where, status?.clients.total ?? 0))}
    onDisable={row => void act(disableStep(row, where))}
    onReconfirm={row => void act({request: {type: 'enable', host: row.host}})}
    onPair={() => void pair()}
    onCopy={() => void navigator.clipboard.writeText(link?.text ?? '').then(() => setNotice({text: '已复制。'}), () => setNotice({text: '没能复制，请选中链接手动复制。', error: true}))}
    onRename={setRenaming}
    renameForm={target => <NameForm label={target === 'device' ? '设备名字' : '名字'} initial={target === 'device' ? status?.device.name ?? '' : clients?.clients.find(each => each.id === target)?.name ?? ''}
      onSave={name => rename(target === 'device' ? {type: 'rename', name} : {type: 'renameClient', clientId: target, name})} onDone={() => setRenaming(undefined)}/>}
    onRevoke={record => { setTicked(false); setConfirm({kind: 'revoke', clientId: record.id, name: record.name, downstream: cascadeCount(clients?.clients ?? [], record.id)}); }}
    dialog={confirm && <ConfirmPanel confirm={confirm} ticked={ticked} busy={busy} onTick={setTicked} onCancel={() => setConfirm(undefined)}
      onConfirm={() => { if (!confirmed) return; setConfirm(undefined); void act({request: confirmed}); }} ready={Boolean(confirmed)}/>}/>;
}

/** The four confirmations; a risk one can be sent only once 我了解风险 is ticked (`ready`). */
export function ConfirmPanel({confirm, ticked, busy, ready, onTick, onCancel, onConfirm}: {confirm: Confirm; ticked: boolean; busy: boolean; ready: boolean; onTick: (ticked: boolean) => void; onCancel: () => void; onConfirm: () => void}) {
  const id = useId();
  const box = (label: string) => <label className="remote-tick" htmlFor={id}><input id={id} type="checkbox" checked={ticked} onChange={event => onTick(event.target.checked)}/>{label}</label>;
  const revoke = confirm.kind === 'revoke';
  const title = revoke ? `撤销「${confirm.name}」` : {risk: '这个地址有风险', switch: '换一个地址', disable: '关闭远程连接'}[confirm.kind];
  const label = revoke ? '撤销' : {risk: '开启', switch: '换成这个地址', disable: '关闭'}[confirm.kind];
  return <Dialog open size="sm" title={title} onClose={busy ? undefined : onCancel}
    footer={<><Button disabled={busy} onClick={onCancel}>取消</Button>
      <Button variant={confirm.kind === 'risk' ? 'primary' : 'danger'} disabled={!ready} loading={busy} onClick={onConfirm}>{label}</Button></>}>
    <p className="remote-dialog-text">{revoke ? revokeConfirmText(confirm.name) : confirm.text}</p>
    {confirm.kind === 'risk' && <>{confirm.also && <p className="remote-dialog-text">{confirm.also}</p>}{box('我了解风险')}</>}
    {revoke && confirm.downstream > 0 && box(`同时撤销它带进来的 ${confirm.downstream} 台`)}
  </Dialog>;
}

type ViewProps = {
  where: Where; status?: DeviceStatus; clients?: ClientsReply; rows: AddressRow[]; picked?: string; link?: Pick<Link, 'text' | 'expiresAt'>; gone?: Gone; now: number;
  busy: boolean; notice?: {text: string; error?: boolean}; readError?: string; renaming?: string; dialog?: ReactNode;
  onPick: (host: string) => void; onRefresh: () => void; onEnable: () => void; onDisable: (row: AddressRow) => void; onReconfirm: (row: AddressRow) => void;
  onPair: () => void; onCopy: () => void; onRename: (target: string) => void; renameForm: (target: string) => ReactNode; onRevoke: (client: ClientRecord) => void;
};
/** No effects: tests give it the state. */
export function RemoteAccessView(props: ViewProps) {
  const {where, status, clients, rows, picked, link, busy} = props;
  const radio = useId();
  if (!status) return <SettingsGroup label={panelTitle(where)} id={settingAnchor(SECTION)}>
    <SettingsRow title={props.readError ?? '正在读取…'}/>
  </SettingsGroup>;
  const open = rows.find(row => row.enabled);
  const switching = open && picked && picked !== open.host;
  const blocked = linkBlocked(rows);
  const live = clients ? liveClients(clients) : [];
  return <div className="remote-access">
    <SettingsGroup label={panelTitle(where)} id={settingAnchor(SECTION)}
      action={<IconButton label="刷新" size="sm" variant="ghost" disabled={busy} onClick={props.onRefresh}><RefreshCw size={14}/></IconButton>}
      footer={<CopyText text={portHint(where)}/>}>
      <SettingsRow title="设备名字" description={props.renaming === 'device' ? props.renameForm('device') : '别的设备配对时看到的名字。'}
        value={props.renaming === 'device' ? undefined : status.device.name} trailing={props.renaming === 'device' ? undefined : <Button size="sm" disabled={busy} onClick={() => props.onRename('device')}>改名</Button>}/>
      <div className="remote-address-block" data-search-title="地址">
        <div className="remote-address-head"><strong>别的设备用哪个地址连过来</strong><span>只能开一个。只有配对过的设备能连上，内容加密。</span></div>
        {rows.length ? <div className="remote-address-list" role="radiogroup" aria-label="地址">
          {rows.map(row => <label key={row.host} className="remote-address" data-enabled={row.enabled || undefined}>
            <input type="radio" name={radio} value={row.host} checked={picked === row.host} disabled={busy} onChange={() => props.onPick(row.host)}/>
            <span className="remote-address__copy"><strong>{kindLabel(row)}</strong><span>{row.host}{row.iface ? ` · ${row.iface}` : ''}</span></span>
            {row.enabled && <span className="remote-address__state" data-state={row.state}>{stateText(row)}</span>}
            {row.current && <span className="remote-tag">你正通过它连着</span>}
          </label>)}
        </div> : <p className="remote-address-empty">{NO_ADDRESS}</p>}
        <div className="remote-address-actions">
          {!open && <Button size="sm" variant="primary" disabled={busy || !picked} onClick={props.onEnable}>开启</Button>}
          {switching && <Button size="sm" variant="primary" disabled={busy} onClick={props.onEnable}>换成这个地址</Button>}
          {open?.state === 'needs-confirmation' && <Button size="sm" disabled={busy} onClick={() => props.onReconfirm(open)}>确认并重新开启</Button>}
          {open && <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onDisable(open)}>关闭远程连接</Button>}
          {switching && <span>换了以后 {open.host} 不再接受连接，已配对的设备要粘一次新链接。</span>}
        </div>
      </div>
      <SettingsRow title="端口" value={String(status.remote.port)}/>
    </SettingsGroup>
    {!rows.some(row => row.kind === 'tailscale') && <TailscaleAdvice/>}
    <SettingsGroup label={LINK_SECTION} id={settingAnchor(LINK_SECTION)} footer={LINK_HELP}>
      {link ? <div className="remote-link">
        <input readOnly aria-label="连接链接" value={link.text} onFocus={event => event.currentTarget.select()} onClick={event => event.currentTarget.select()}/>
        <div className="remote-link__actions">
          <Button size="sm" variant="primary" onClick={props.onCopy}>复制</Button>
          <span>{linkCountdown(link.expiresAt, props.now)}</span>
          <Button size="sm" variant="ghost" disabled={busy || Boolean(blocked)} onClick={props.onPair}>再生成一个</Button>
        </div>
      </div> : <SettingsRow title="连接链接" description={blocked ?? (props.gone === 'moved' ? LINK_MOVED : props.gone === 'expired' ? LINK_EXPIRED : '生成后 10 分钟内有效。')}
        trailing={<Button size="sm" disabled={busy || Boolean(blocked)} onClick={props.onPair}>生成连接链接</Button>}/>}
    </SettingsGroup>
    <SettingsGroup label={PAIRED_SECTION} id={settingAnchor(PAIRED_SECTION)}>
      {live.length ? live.map(record => {
        const self = record.id === clients?.self;
        const editing = props.renaming === record.id;
        return <SettingsRow key={record.id} className="remote-client"
          title={<>{record.name}{isRecent(record, props.now) && <span className="remote-tag" data-tone="new">新</span>}{self && <span className="remote-tag">{SELF_TAG}</span>}</>}
          description={editing ? props.renameForm(record.id) : <>
            {CLIENT_KIND_LABEL[record.clientKind] ?? record.clientKind} · 上次连接 {relativeTime(record.lastSeenAt, props.now)}，来自 {hostOf(record.lastAddress)} · {invitedByText(record, clients?.clients ?? [], where)}
            {self && <><br/>{selfText(where)}</>}
          </>}
          trailing={editing ? undefined : <>
            <Button size="sm" disabled={busy} onClick={() => props.onRename(record.id)}>改名</Button>
            {!self && <Button size="sm" variant="danger" disabled={busy} onClick={() => props.onRevoke(record)}>撤销</Button>}
          </>}/>;
      }) : <SettingsRow title="还没有别的设备连过来。"/>}
    </SettingsGroup>
    {props.notice && <InlineNotice title={props.notice.error ? '没办成' : '好了'} tone={props.notice.error ? 'danger' : 'success'}><CopyText text={props.notice.text}/></InlineNotice>}
    {props.readError && <InlineNotice title="没读到最新状态" tone="warning">{props.readError}</InlineNotice>}
    {props.dialog}
  </div>;
}
