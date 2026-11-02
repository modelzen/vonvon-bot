import {useEffect, useReducer, useState} from 'react';
import {deviceAliasSchema, type AddDeviceResult, type DeviceRow, type DevicesState, type LinkPreview, type RouteFailure} from '@vonvon/protocol';
import {useDevicesState, useShellCapabilities} from '../client-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {copy, failureCopy, linkPreviewCopy, routeHints, routeKindLabel} from './devices-presentation';
import {CopyText, useNow} from './device-bits';

type OkPreview = Extract<LinkPreview, {ok: true}>;
type Base = {link: string; name: string; preview?: OkPreview};
export type AddDialogState =
  | Base & {stage: 'paste'; problem?: Extract<LinkPreview, {ok: false}>}
  | Base & {stage: 'confirm'; preview: OkPreview}
  | Base & {stage: 'adding'}
  | Base & {stage: 'failed'; code: string; attempts: RouteFailure[]}
  | {stage: 'done'; result: Exclude<AddDeviceResult, {kind: 'failed'}>};
export type AddDialogAction =
  | {type: 'input'; link: string}
  | {type: 'inspected'; link: string; preview: LinkPreview; defaultName?: string}
  | {type: 'name'; name: string}
  | {type: 'start'; name: string}
  | {type: 'result'; result: AddDeviceResult}
  | {type: 'reset'};
export const EMPTY_ADD_DIALOG: AddDialogState = {stage: 'paste', link: '', name: ''};

/** devices-ui-1b 4.6. The link lives only here: never in a context or a log, and gone with the dialog. */
export function addDialogReducer(state: AddDialogState, action: AddDialogAction): AddDialogState {
  switch (action.type) {
    case 'input': return {stage: 'paste', link: action.link, name: ''};
    case 'inspected':
      if (state.stage !== 'paste' || state.link !== action.link) return state;
      return action.preview.ok ? {stage: 'confirm', link: state.link, preview: action.preview, name: action.defaultName ?? action.preview.name}
        : {stage: 'paste', link: state.link, name: action.preview.name ?? '', problem: action.preview};
    case 'name': return state.stage === 'confirm' ? {...state, name: action.name} : state;
    case 'start': return state.stage === 'done' ? state : {stage: 'adding', link: state.link, name: action.name, ...(state.preview ? {preview: state.preview} : {})};
    case 'result':
      if (state.stage !== 'adding') return state;
      return action.result.kind === 'failed' ? {...state, stage: 'failed', code: action.result.code, attempts: action.result.attempts} : {stage: 'done', result: action.result};
    case 'reset': return EMPTY_ADD_DIALOG;
  }
}
const NEW_LINK_CODES = new Set(['link_used', 'link_expired', 'pairing_failed']);
const minutesLeft = (preview: OkPreview, now: number) => Math.max(0, Math.ceil((preview.expiresAt - now) / 60_000));
const progress = (adding: DevicesState['adding']) => !adding || adding.stage === 'connecting'
  ? `正在连接${adding?.route ? ` ${adding.route.host}:${adding.route.port}` : ''}…` : adding.stage === 'pairing' ? '正在配对…' : '正在核对版本…';

export type StageActions = {
  input(link: string): void; rename(name: string): void; add(): void; cancel(): void; reset(): void; close(): void; switchTo(id: string): void;
};
/** What a stage shows: no effects, so tests render it directly. */
export function AddDeviceStage({state, now, adding, repairOf, actions}: {state: AddDialogState; now: number; adding?: DevicesState['adding']; repairOf?: DeviceRow; actions: StageActions}) {
  if (state.stage === 'done') {
    const name = `「${state.result.name}」`;
    return <div className="device-add">
      <p>{state.result.kind === 'added' ? `已添加${name}。` : `${name}已经在列表里了，已按新链接更新了它的地址。`}</p>
      <div className="device-actions">
        {state.result.kind === 'added' && <Button variant="primary" onClick={() => actions.switchTo(state.result.deviceId)}>切换到{name}</Button>}
        <Button onClick={actions.close}>完成</Button>
      </div>
    </div>;
  }
  if (state.stage === 'paste') {
    const problem = state.problem;
    return <div className="device-add">
      <label className="device-field"><span>连接链接</span>
        <textarea rows={3} value={state.link} onChange={event => actions.input(event.target.value)} spellCheck={false} autoComplete="off"/>
      </label>
      <p className="device-muted"><CopyText text={copy.pasteHelp}/></p>
      {problem && <p className="device-problem" role="alert"><CopyText text={linkPreviewCopy(problem.code, `「${problem.name ?? ''}」`)}/></p>}
      <div className="device-actions">
        {problem?.code === 'already_added' && problem.deviceId && <Button onClick={() => actions.switchTo(problem.deviceId!)}>切换到「{problem.name}」</Button>}
        <Button variant="primary" disabled>连接并添加</Button>
      </div>
    </div>;
  }
  const name = `「${state.name || state.preview?.name || ''}」`;
  if (state.stage === 'adding') return <div className="device-add">
    <p role="status">{progress(adding)}</p>
    <div className="device-actions"><Button onClick={actions.cancel}>取消</Button></div>
  </div>;
  const expired = state.preview ? minutesLeft(state.preview, now) === 0 : true;
  if (state.stage === 'failed') return <div className="device-add">
    <p className="device-problem" role="alert"><CopyText text={failureCopy(state.code, name)}/></p>
    {routeHints(state.attempts, name).map((hint, index) => <p key={index} className="device-hint"><CopyText text={hint}/></p>)}
    <div className="device-actions">
      {NEW_LINK_CODES.has(state.code) ? <Button variant="primary" onClick={actions.reset}>粘贴新链接</Button> : <>
        {state.preview && !expired && <Button variant="primary" onClick={actions.add}>再试一次</Button>}
        <Button onClick={actions.close}>关闭</Button>
      </>}
    </div>
  </div>;
  const {preview} = state;
  const valid = deviceAliasSchema.safeParse(state.name).success;
  return <div className="device-add">
    {repairOf && preview.deviceId !== repairOf.id && <InlineNotice title="不是同一台设备" tone="warning">这条链接是「{preview.name}」的，不是「{repairOf.name}」的。</InlineNotice>}
    <p>设备：{preview.name}</p>
    <ul className="device-routes">{preview.routes.map(route => <li key={`${route.host}:${route.port}`}>{routeKindLabel(route.kind)} {route.host}:{route.port}</li>)}</ul>
    <p className={expired ? 'device-problem' : 'device-muted'}>{expired ? linkPreviewCopy('link_expired', `「${preview.name}」`) : `还剩 ${minutesLeft(preview, now)} 分钟`}</p>
    <label className="device-field"><span>名字</span><input value={state.name} maxLength={60} onChange={event => actions.rename(event.target.value)}/></label>
    {!valid && <p className="device-problem" role="alert">{copy.invalidName}</p>}
    <div className="device-actions"><Button variant="primary" disabled={expired || !valid} onClick={actions.add}>连接并添加</Button></div>
  </div>;
}

export function AddDeviceDialog({onClose, onSwitch, repairOf}: {onClose: () => void; onSwitch: (id: string) => void; repairOf?: DeviceRow}) {
  const devices = useShellCapabilities()?.devices;
  const adding = useDevicesState()?.adding;
  const [state, dispatch] = useReducer(addDialogReducer, EMPTY_ADD_DIALOG);
  const [error, setError] = useState<string>();
  const now = useNow(state.stage === 'confirm' || state.stage === 'failed' ? 30_000 : undefined);
  const pasted = state.stage === 'paste' ? state.link : undefined;
  async function submit(link: string, chosen: string | undefined, display: string) {
    if (!devices) return;
    dispatch({type: 'start', name: display});
    setError(undefined);
    try { dispatch({type: 'result', result: await devices.add({link, ...(chosen ? {name: chosen.trim()} : {})})}); }
    catch (failure) { dispatch({type: 'result', result: {kind: 'failed', code: 'closed', attempts: []}}); setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  useEffect(() => {
    if (!devices || !pasted?.trim()) return;
    let live = true;
    const timer = window.setTimeout(() => void devices.inspect(pasted.trim()).then(preview => {
      if (!live) return;
      setError(undefined);
      const defaultName = preview.ok && repairOf?.id === preview.deviceId ? repairOf.name : undefined;
      dispatch({type: 'inspected', link: pasted, preview, ...(defaultName ? {defaultName} : {})});
      // Added before, at other addresses: the link only updates them, without using the invite.
      if (!preview.ok && preview.code === 'already_added' && preview.routesChanged) void submit(pasted.trim(), undefined, preview.name ?? '');
    }, failure => { if (live) setError(failure instanceof Error ? failure.message : String(failure)); }), 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [devices, pasted]);
  const close = () => {
    if (state.stage === 'adding') void devices?.cancelAdd().catch(() => {});
    dispatch({type: 'reset'});
    onClose();
  };
  const actions: StageActions = {
    input: link => dispatch({type: 'input', link}),
    rename: name => dispatch({type: 'name', name}),
    add: () => { if (state.stage !== 'done') void submit(state.link.trim(), state.name, state.name); },
    cancel: () => void devices?.cancelAdd().catch(() => {}),
    reset: () => dispatch({type: 'reset'}),
    close,
    switchTo: id => { close(); onSwitch(id); },
  };
  return <Dialog open title={repairOf ? `重新配对「${repairOf.name}」` : '添加设备'} onClose={close}>
    <AddDeviceStage state={state} now={now} adding={adding} repairOf={repairOf} actions={actions}/>
    {error && <p className="device-problem" role="alert">{error}</p>}
  </Dialog>;
}
