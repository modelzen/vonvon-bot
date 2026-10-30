import {RefreshCw} from 'lucide-react';
import {useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {decisionApiProviderLabel, formatTime, keyProblem, type SecretService} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, IconButton, FormField, InlineNotice, StatusBadge, type StatusTone} from '../reference/components/ui';
import {ConfirmDialog, Dialog} from '../reference/components/ui/Dialog';
import {
  MEANWHILE, OLD_DAEMON, errorText, keyDiagnosis, keyFlows, keyStatus, removalCopy, rereads, resultCopy, secretsReader, testTone, testedText,
  unreadNotes, useCount, useName, useNote, type FillFlow, type KeyFlows, type RowState, type SecretsRead, type SecretsView,
} from './secretsModel';
import {DecisionProviderSettings} from './DecisionProviderSettings';
import {decisionKeySection, decisionProviderSection, settingAnchor} from '../search';
import './secrets.css';

/** Reads the list on entering a page and on coming back to the window: nothing in the snapshot changes when a key does
 * (v1-plan s23g 做法（实现时定下的）). */
export function useSecrets() {
  const client = useClient();
  const [read, setRead] = useState<SecretsRead>({kind: 'loading'});
  const reader = useMemo(() => secretsReader(request => client.admin(request), setRead), [client]);
  useEffect(() => {
    void reader.read();
    let last = Date.now();
    const again = () => {
      const now = Date.now();
      if (!rereads(document.visibilityState === 'hidden', now, last)) return;
      last = now;
      void reader.read();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); reader.stop(); };
  }, [reader]);
  return {read, reader};
}

const pill = (text: string, tone: StatusTone) => <StatusBadge tone={tone} variant="pill">{text}</StatusBadge>;

export function KeyRow({service, view, row, onFill, onReplace, onRemove, onTest, onOpenLogs}: {
  service: SecretService; view: SecretsView; row: RowState;
  onFill: () => void; onReplace: () => void; onRemove: () => void; onTest: () => void; onOpenLogs: () => void;
}) {
  const status = keyStatus(service);
  const busy = Boolean(row.busy);
  const purpose = service.status === 'set' ? '' : '添加后即可使用 Jev 智能判断。';
  const meanwhile = service.inUse.length || view.botsUnreadable || view.unreadBots
    ? `${service.status === 'invalid' ? '重新填' : '填'}之前，选了它的 Bot 和飞书群${MEANWHILE}。` : '';
  const line = row.busy === 'saving' ? <StatusBadge tone="neutral">正在保存…</StatusBadge>
    : row.tested ? <StatusBadge tone={testTone(row.tested.outcome)}>{`${formatTime(row.tested.at)} ${testedText(row.tested)}`}</StatusBadge> : null;
  const tested = <span className="secrets-tested" role="status">{line}</span>;
  let description: ReactNode;
  let actions: ReactNode;
  switch (service.status) {
    case 'set':
      description = <>{purpose}{tested}</>;
      actions = <>
        <Button size="sm" loading={row.busy === 'testing'} disabled={busy} onClick={onTest}>验证</Button>
        <Button size="sm" disabled={busy} onClick={onReplace}>更换</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>删除</Button>
      </>;
      break;
    case 'missing':
      description = <>{purpose}{meanwhile}{tested}</>;
      actions = <Button size="sm" variant="primary" disabled={busy} onClick={onFill}>添加密钥</Button>;
      break;
    case 'invalid':
      description = <>密钥包含空格或不可见字符，无法使用。请重新添加。{meanwhile}{tested}</>;
      actions = <>
        <Button size="sm" variant="primary" disabled={busy} onClick={onFill}>重新添加</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>删除</Button>
      </>;
      break;
    case 'unreadable':
      // the command line does not ask for a key then, and neither does this page: a save hits the same error
      description = <>{service.problem ?? '密钥库读不了'}（<code>{service.code ?? 'UNKNOWN'}</code>）。暂时无法读取或保存；使用它的 Bot 和群聊{MEANWHILE}。详见日志 <code>secrets.unreadable</code>。{tested}</>;
      actions = <Button size="sm" variant="ghost" disabled={busy} onClick={onOpenLogs}>查看日志</Button>;
      break;
  }
  return <SettingsRow className={keyRowClass(service.keyId)} title="API 密钥" description={service.status === 'set' && !line ? undefined : description}
    trailing={<span className="setup-step-trailing">{pill(status.text, status.tone)}{actions}</span>}/>;
}
/** No wrapper around a row: the group's separators go between sibling rows. */
const keyRowClass = (keyId: string) => `secrets-key-row--${keyId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const notesOf = (notes: string[]) => notes.map(note => <span className="secrets-note" key={note}>{note}</span>);

export function UsesRow({service, view}: {service: SecretService; view: SecretsView}) {
  const notes = unreadNotes(view);
  if (!service.inUse.length && !notes.length) return null;
  const description = service.inUse.length
    ? <>
      <ul className="secrets-uses">{service.inUse.map(use => <li key={`${use.agentId}-${use.groupId ?? ''}`}>
        <b>{useName(use)}</b> <span className="secrets-uses__note">· {useNote(use, service)}</span>
      </li>)}</ul>
      {notesOf(notes)}
    </>
    : notesOf(notes);
  // the count stays by the title however long the list (多角度审查 B4)
  return <details className="decision-uses-disclosure" data-search-title="使用范围" open={notes.length ? true : undefined}>
    <summary><span>使用范围</span><span className="decision-uses-count">{view.botsUnreadable ? 'Bot 清单读不了' : useCount(service.inUse)}<span aria-hidden="true" className="decision-uses-chevron">›</span></span></summary>
    <div className="decision-uses-content">{description}</div>
  </details>;
}

const fillDescription = (flow: FillFlow) => flow.replacing
  ? `将替换${flow.was ? `末四位为 ${flow.was} 的密钥` : '当前密钥'}。密钥仅保存在本机。`
  : '密钥仅保存在本机，保存后自动验证。';

/** Enter submits the key, except while an input method is still composing. */
export const submitsOnKey = (key: string, composing: boolean): boolean => key === 'Enter' && !composing;

/**
 * The field is uncontrolled (s23g2 做法): the key is read from it only on submit, cleared on submit and on close, and
 * never lands in a `value` attribute. No `<form>`: Enter is handled on the field. The Dialog gives focus once when it
 * opens, so each step change moves it here: to the field, to the dialog while a request runs, to the main button of
 * a result. While it saves and tries, the panel keeps the field's height and the header, and the pressed button stays
 * where it was, spinning: the second click of a double-click lands on it, not on 关闭 or the backdrop (多角度审查 B2).
 */
export function FillKeyDialog({flow, service, onClose, onSubmit, onAgain, onRetest}: {
  flow: FillFlow | undefined; service: SecretService | undefined;
  onClose: () => void; onSubmit: (value: string) => void; onAgain: () => void; onRetest: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [hold, setHold] = useState<number>();
  const step = flow?.step;
  useEffect(() => {
    setReady(false); setShown(false); setProblem(undefined);
    if (step === 'input') input.current?.focus();
    else if (step === 'result') main.current?.focus();
    else if (step) body.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  }, [flow?.id, step]);
  if (!flow || !service) return <Dialog open={false} title="" onClose={onClose}>{null}</Dialog>;
  function close() {
    if (input.current) input.current.value = '';
    onClose();
  }
  function submit() {
    const value = input.current?.value.trim() ?? '';
    if (!value) return;
    const wrong = keyProblem(value);
    // what was typed stays, so it can be fixed
    if (wrong) { setProblem(wrong); input.current?.focus(); return; }
    if (input.current) input.current.value = '';
    setHold(body.current?.offsetHeight);
    onSubmit(value);
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!submitsOnKey(event.key, event.nativeEvent.isComposing)) return;
    event.preventDefault();
    submit();
  }
  const title = `${flow.replacing ? '更换' : '添加'} ${service.provider === 'typesafe' ? 'Jev' : service.displayName} 密钥`;
  const progress = (text: string) => <div className="secrets-dialog-progress" role="status">{text}</div>;
  const tail = flow.last4 ? `（末四位 ${flow.last4}）` : '';
  let content: ReactNode;
  let footer: ReactNode;
  if (flow.step === 'input') {
    content = <FormField htmlFor={id} label="API 密钥" error={problem}
      description={`从 ${service.displayName} 控制台复制完整密钥。`}>
      <div className="secrets-key-field">
        <input id={id} ref={input} type={shown ? 'text' : 'password'} placeholder="粘贴密钥"
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-1p-ignore="" data-lpignore="true"
          aria-describedby={`${id}-description${problem ? ` ${id}-error` : ''}`} aria-invalid={problem ? true : undefined}
          onInput={event => { setReady(Boolean(event.currentTarget.value.trim())); setProblem(undefined); }} onKeyDown={keyDown}/>
        <Button aria-pressed={shown} onClick={() => setShown(value => !value)}>{shown ? '隐藏' : '显示'}</Button>
      </div>
    </FormField>;
    footer = <><Button onClick={close}>取消</Button><Button variant="primary" disabled={!ready} onClick={submit}>保存并验证</Button></>;
  } else if (flow.step === 'saving' || flow.step === 'testing' || !flow.result) {
    // both can be closed: the result lands in the key's row (owner 没看稿子，按推荐：v1-plan 第 5 节)
    content = progress(flow.step === 'saving' ? '正在保存…' : `已保存${tail}，正在验证…`);
    // a retest keeps the last result until the new one lands
    footer = <><Button onClick={close}>关闭</Button><Button variant="primary" loading>{flow.result ? '重新验证' : '保存并验证'}</Button></>;
  } else {
    const copy = resultCopy(flow.result, service.displayName, flow.last4);
    content = <InlineNotice tone={copy.tone} title={copy.title}>{copy.body}</InlineNotice>;
    footer = copy.footer === 'replace' ? <><Button onClick={close}>关闭</Button><Button ref={main} variant="primary" onClick={onAgain}>更换密钥</Button></>
      : copy.footer === 'retry' ? <><Button onClick={close}>完成</Button><Button ref={main} variant="primary" onClick={onRetest}>重新验证</Button></>
        : copy.footer === 'again' ? <><Button onClick={close}>取消</Button><Button ref={main} variant="primary" onClick={onAgain}>重试</Button></>
          : <Button ref={main} variant="primary" onClick={close}>完成</Button>;
  }
  // one ref for the Dialog: a new one would rerun its opening effect and bounce the focus
  const held = hold !== undefined && flow.step !== 'input';
  return <Dialog open title={title} onClose={close} initialFocusRef={input}
    description={flow.step !== 'result' ? fillDescription(flow) : undefined} footer={footer}>
    <div className={`secrets-dialog${held && flow.step !== 'result' ? ' secrets-dialog--held' : ''}`} style={held ? {minHeight: hold} : undefined} ref={body}>{content}</div>
  </Dialog>;
}

export type Removal = {keyId: string; pending: boolean; error?: string};

/** Who chose it, before it goes; the list scrolls (s23g2 做法). Not closable while the removal runs. */
export function RemoveKeyDialog({removal, service, view, onCancel, onConfirm}: {
  removal: Removal | undefined; service: SecretService | undefined; view: SecretsView | undefined; onCancel: () => void; onConfirm: () => void;
}) {
  const copy = service && view ? removalCopy(service, view) : undefined;
  const list = (uses: SecretService['inUse']) => <div className="secrets-dialog-list"><ul className="secrets-uses">{uses.map(use =>
    <li key={`${use.agentId}-${use.groupId ?? ''}`}><b>{useName(use)}</b> <span className="secrets-uses__note">· {useNote(use, service!)}</span></li>)}</ul></div>;
  return <ConfirmDialog open={Boolean(removal && copy)} title={service ? `删除 ${service.displayName} 密钥？` : ''} description={copy?.description ?? ''}
    tone="danger" confirmLabel="删除" pending={removal?.pending} onCancel={onCancel} onConfirm={onConfirm}>
    {copy && <div className="secrets-dialog">
      {copy.lead && <p>{copy.lead}</p>}
      {copy.active.length > 0 && list(copy.active)}
      {copy.notSmartNote && <p className="secrets-dialog-note">{copy.notSmartNote}</p>}
      {/* the note above already says they are not 智能群, so each line leaves it out */}
      {copy.notSmart.length > 0 && list(copy.notSmart.map(use => ({...use, notSmart: undefined})))}
      {copy.notes.map(note => <p className="secrets-dialog-note" key={note}>{note}</p>)}
      {removal?.error && <InlineNotice tone="danger" title="删除失败">{`${removal.error}。密钥仍保留。`}</InlineNotice>}
    </div>}
  </ConfirmDialog>;
}

/**
 * 密钥 (product.md 3.1 第 9 条): the services that take a key, one machine-wide key each. Filling in is a save and a
 * 试一次; the page shows only whether a key is in and its last four. A dialog can close while its requests run, and
 * their result lands in the key's row; focus then goes back to the row, to its first button that can be pressed.
 */
export function SecretsPanel({onOpenLogs, onOpenApplication, onOpenProviders}: {onOpenLogs: () => void; onOpenApplication: () => void; onOpenProviders?: () => void}) {
  const client = useClient();
  const {read, reader} = useSecrets();
  const [{rows, fill}, setFlows] = useState<KeyFlows>({rows: {}});
  const flows = useMemo(() => keyFlows(request => client.admin(request), reader.change, setFlows), [client, reader]);
  const [removal, setRemoval] = useState<Removal>();
  const [reloading, setReloading] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const view = read.kind === 'ready' ? read.view : undefined;
  useEffect(() => { if (view) flows.listed(view.services); }, [flows, view]);

  // After a dialog: back to its row once the row has a button to take it; the opener may be gone (填 key became 换 key)
  useEffect(() => {
    const keyId = flows.current().refocus;
    if (!keyId) return;
    const timer = window.setTimeout(() => {
      if (flows.current().refocus !== keyId) return;
      const active = document.activeElement;
      if (active && active !== document.body && page.current?.contains(active)) { flows.refocused(keyId); return; }
      if (active && active !== document.body && !active.closest('.ui-dialog')) { flows.refocused(keyId); return; }
      const target = page.current?.querySelector<HTMLElement>(`.${keyRowClass(keyId)} button:not([disabled])`);
      if (target) { flows.refocused(keyId); target.focus({preventScroll: true}); }
    }, 0);
    return () => window.clearTimeout(timer);
  });

  async function remove() {
    const target = removal;
    if (!target) return;
    setRemoval({...target, pending: true, error: undefined});
    let error: string | undefined;
    try {
      const reply = await reader.change({type: 'removeSecret', keyId: target.keyId});
      if (reply.kind !== 'secrets') error = reply.kind === 'refused' ? reply.message : 'daemon 回的不是密钥的列表';
    } catch (failure) {
      error = errorText(failure);
    }
    if (error) { setRemoval(current => current && {...current, pending: false, error}); return; }
    flows.removed(target.keyId);
    setRemoval(undefined);
  }
  async function reload() {
    setReloading(true);
    flows.forget();
    try { await reader.read(); } finally { setReloading(false); }
  }

  const keyRefresh = <IconButton size="sm" variant="ghost" label="重新读取" title="重新读取密钥状态" loading={reloading} disabled={read.kind === 'loading'} onClick={() => void reload()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>;
  const header = <div className="environment-lead today-page-heading"><h1>决策模型</h1></div>;
  const fillService = fill && view?.services.find(service => service.keyId === fill.keyId);
  const removeService = removal && view?.services.find(service => service.keyId === removal.keyId);
  let body: ReactNode;
  if (read.kind === 'old') {
    body = <InlineNotice tone="warning" title="需要更新后台服务" actions={<Button size="sm" variant="ghost" onClick={onOpenApplication}>去应用与启动</Button>}>
      重启 daemon 后再开这一页。
    </InlineNotice>;
  } else if (read.kind === 'failed') {
    body = <InlineNotice tone="danger" title="密钥读取失败">{read.problem}</InlineNotice>;
  } else {
    body = <>
      {read.kind === 'ready' && read.problem && <InlineNotice tone="warning" title="未能刷新密钥">{`${read.problem}。保留上次读取的内容。`}</InlineNotice>}
      <div className="decision-key-content">
        {!view ? <SettingsRow title="正在读取…"/>
          : !view.services.length ? <SettingsRow title="暂无需要密钥的服务"/>
            : view.services.map(service => <div key={service.keyId} className="decision-service-key" id={settingAnchor(decisionKeySection(service.provider))}>
              <h3 className="decision-service-key-title">{decisionApiProviderLabel(service.provider)}</h3>
              <KeyRow service={service} view={view} row={rows[service.keyId] ?? {}}
                onFill={() => flows.open(service.keyId, false)} onReplace={() => flows.open(service.keyId, true, service.last4)}
                onRemove={() => setRemoval({keyId: service.keyId, pending: false})} onTest={() => void flows.test(service.keyId)} onOpenLogs={onOpenLogs}/>
              <UsesRow service={service} view={view}/>
            </div>)}
      </div>
    </>;
  }
  return <div className="page-stack secrets-page" ref={page}>
    {header}
    <DecisionProviderSettings services={view?.services} onOpenProviders={onOpenProviders} onManageKey={(provider = 'typesafe') => {
      const service = view?.services.find(item => item.provider === provider);
      if (service && (service.status === 'missing' || service.status === 'invalid')) {flows.open(service.keyId, false); return;}
      const target = provider === 'custom' ? document.getElementById(settingAnchor(decisionProviderSection('custom')))
        : page.current?.querySelector<HTMLElement>(service ? `.${keyRowClass(service.keyId)}` : '.decision-key-content');
      target?.scrollIntoView({block: 'center', behavior: 'smooth'});
      target?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])')?.focus({preventScroll: true});
    }} keyContent={body} keyAction={keyRefresh}/>
    <FillKeyDialog flow={fillService ? fill : undefined} service={fillService} onClose={flows.close}
      onSubmit={value => void flows.save(value)} onAgain={flows.again} onRetest={() => void flows.retest()}/>
    <RemoveKeyDialog removal={removeService ? removal : undefined} service={removeService} view={view}
      onCancel={() => { if (removal) flows.refocusTo(removal.keyId); setRemoval(undefined); }} onConfirm={() => void remove()}/>
  </div>;
}

/** The 决策模型的 key row of 这台电脑 on the 状态与诊断 page: one per service, always there (s23g2). */
export function KeyDiagnosticsRows({read, onOpenSecrets, onShowLog}: {read: SecretsRead; onOpenSecrets: () => void; onShowLog: () => void}) {
  const title = '决策模型密钥';
  const trailing = (status: string, tone: StatusTone, action?: ReactNode) => <span className="setup-step-trailing">{pill(status, tone)}{action}</span>;
  if (read.kind === 'loading') return <SettingsRow title={title} trailing={trailing('检查中', 'neutral')}/>;
  if (read.kind === 'old') return <SettingsRow title={title} description={`${OLD_DAEMON}。`} trailing={trailing('看不到', 'neutral')}/>;
  if (read.kind === 'failed') return <SettingsRow title={title} description={read.problem} trailing={trailing('读取失败', 'warning')}/>;
  // a reread that failed keeps the last list: say so, as the 密钥 page does (多角度审查 R-F1)
  const stale = read.problem ? `没读到最新的（${read.problem}），这是上一次读到的。` : '';
  return <>{read.view.services.map(service => {
    const row = keyDiagnosis(service, read.view);
    const action = row.action && <Button size="sm" variant="ghost" onClick={row.action.to === 'logs' ? onShowLog : onOpenSecrets}>{row.action.label}</Button>;
    return <SettingsRow key={service.keyId} title={title} description={`${stale}${row.description}`}
      trailing={trailing(row.status, stale && row.tone !== 'danger' ? 'warning' : row.tone, action)}/>;
  })}</>;
}
