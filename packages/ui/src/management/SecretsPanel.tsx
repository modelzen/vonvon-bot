import {Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {KeyRound} from 'lucide-react';
import {formatTime, keyProblem, type SecretService} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, FormField, InlineNotice, PageHeader, StatusBadge, type StatusTone} from '../reference/components/ui';
import {ConfirmDialog, Dialog} from '../reference/components/ui/Dialog';
import {settingAnchor} from '../search';
import {
  MEANWHILE, OLD_DAEMON, choice, errorText, keyDiagnosis, keyFlows, keyStatus, removalCopy, rereads, resultCopy, secretsReader, testTone, testedText,
  unreadNotes, useCount, useName, useNote, type FillFlow, type KeyFlows, type RowState, type SecretsRead, type SecretsView,
} from './secretsModel';
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
  const purpose = `决策模型 ${service.models.map(model => model.displayName).join('、') || service.displayName} 用它判断回不回。`;
  const meanwhile = service.inUse.length || view.botsUnreadable || view.unreadBots
    ? `${service.status === 'invalid' ? '重新填' : '填'}之前，选了它的 Bot 和飞书群${MEANWHILE}。` : '';
  const line = row.busy === 'saving' ? <StatusBadge tone="neutral">正在存…</StatusBadge>
    : row.tested ? <StatusBadge tone={testTone(row.tested.outcome)}>{`${formatTime(row.tested.at)} ${testedText(row.tested)}`}</StatusBadge> : null;
  const tested = <span className="secrets-tested" role="status">{line}</span>;
  let description: ReactNode;
  let actions: ReactNode;
  switch (service.status) {
    case 'set':
      description = <>{purpose}{tested}</>;
      actions = <>
        <Button size="sm" loading={row.busy === 'testing'} disabled={busy} onClick={onTest}>试一次</Button>
        <Button size="sm" disabled={busy} onClick={onReplace}>换 key</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>删除</Button>
      </>;
      break;
    case 'missing':
      description = <>{purpose}{meanwhile}{tested}</>;
      actions = <Button size="sm" variant="primary" disabled={busy} onClick={onFill}>填 key</Button>;
      break;
    case 'invalid':
      description = <>存着的 key 有空格或看不见的字符，判断时当没填。重新填一次整串 key。{meanwhile}{tested}</>;
      actions = <>
        <Button size="sm" variant="primary" disabled={busy} onClick={onFill}>重新填</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>删除</Button>
      </>;
      break;
    case 'unreadable':
      // the command line does not ask for a key then, and neither does this page: a save hits the same error
      description = <>{service.problem ?? '密钥库读不了'}（<code>{service.code ?? 'UNKNOWN'}</code>）。读得了之前看不出填没填，也填不进去；选了它的 Bot 和飞书群{MEANWHILE}。原话在 daemon 日志的 <code>secrets.unreadable</code>。{tested}</>;
      actions = <Button size="sm" variant="ghost" disabled={busy} onClick={onOpenLogs}>去看日志</Button>;
      break;
  }
  return <SettingsRow className={keyRowClass(service.keyId)} title={`${service.displayName} 的 key`} description={description}
    trailing={<span className="setup-step-trailing">{pill(status.text, status.tone)}{actions}</span>}/>;
}
/** No wrapper around a row: the group's separators go between sibling rows. */
const keyRowClass = (keyId: string) => `secrets-key-row--${keyId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const notesOf = (notes: string[]) => notes.map(note => <span className="secrets-note" key={note}>{note}</span>);

export function UsesRow({service, view}: {service: SecretService; view: SecretsView}) {
  const notes = unreadNotes(view);
  const description = service.inUse.length
    ? <>
      <ul className="secrets-uses">{service.inUse.map(use => <li key={`${use.agentId}-${use.groupId ?? ''}`}>
        <b>{useName(use)}</b> <span className="secrets-uses__note">· {useNote(use, service)}</span>
      </li>)}</ul>
      {notesOf(notes)}
    </>
    : notes.length ? notesOf(notes) : `现在没有 Bot 或飞书群选它。判断模型选了 ${choice(service)} 才用这个 key。`;
  // the count stays by the title however long the list (多角度审查 B4)
  return <SettingsRow className="secrets-uses-row" title="谁在用" description={description}
    trailing={view.botsUnreadable ? pill('Bot 清单读不了', 'warning') : service.inUse.length ? <StatusBadge>{useCount(service.inUse)}</StatusBadge> : undefined}/>;
}

const fillDescription = (flow: FillFlow) => flow.replacing
  ? `整串重填，${flow.was ? `现在的 ••••${flow.was} 会被换掉` : '现在存的那串会被换掉'}。存在本机，只有 daemon 读它，页面上只显示末四位。`
  : '存在本机，只有 daemon 读它，页面上只显示末四位。填完马上试一次能不能用。';

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
  const title = `${flow.replacing ? '换' : '填'} ${service.displayName} 的 key`;
  const progress = (text: string) => <div className="secrets-dialog-progress" role="status">{text}</div>;
  const tail = flow.last4 ? `（末四位 ${flow.last4}）` : '';
  let content: ReactNode;
  let footer: ReactNode;
  if (flow.step === 'input') {
    content = <FormField htmlFor={id} label={`${service.displayName} 的 key`} error={problem}
      description={`在 ${service.displayName} 的控制台里生成；一串可见的英文字符，不能有空格或换行。`}>
      <div className="secrets-key-field">
        <input id={id} ref={input} type={shown ? 'text' : 'password'} placeholder="粘贴整串 key"
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-1p-ignore="" data-lpignore="true"
          aria-describedby={`${id}-description${problem ? ` ${id}-error` : ''}`} aria-invalid={problem ? true : undefined}
          onInput={event => { setReady(Boolean(event.currentTarget.value.trim())); setProblem(undefined); }} onKeyDown={keyDown}/>
        <Button aria-pressed={shown} onClick={() => setShown(value => !value)}>{shown ? '隐藏' : '显示'}</Button>
      </div>
    </FormField>;
    footer = <><Button onClick={close}>取消</Button><Button variant="primary" disabled={!ready} onClick={submit}>保存并试一次</Button></>;
  } else if (flow.step === 'saving' || flow.step === 'testing' || !flow.result) {
    // both can be closed: the result lands in the key's row (owner 没看稿子，按推荐：v1-plan 第 5 节)
    content = progress(flow.step === 'saving' ? '正在存…' : `已存下${tail}，正在试一次…`);
    // a retest keeps the last result until the new one lands
    footer = <><Button onClick={close}>关闭</Button><Button variant="primary" loading>{flow.result ? '再试一次' : '保存并试一次'}</Button></>;
  } else {
    const copy = resultCopy(flow.result, service.displayName, flow.last4);
    content = <InlineNotice tone={copy.tone} title={copy.title}>{copy.body}</InlineNotice>;
    footer = copy.footer === 'replace' ? <><Button onClick={close}>先这样</Button><Button ref={main} variant="primary" onClick={onAgain}>换一个</Button></>
      : copy.footer === 'retry' ? <><Button onClick={close}>完成</Button><Button ref={main} variant="primary" onClick={onRetest}>再试一次</Button></>
        : copy.footer === 'again' ? <><Button onClick={close}>取消</Button><Button ref={main} variant="primary" onClick={onAgain}>再试一次</Button></>
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
  return <ConfirmDialog open={Boolean(removal && copy)} title={service ? `删 ${service.displayName} 的 key？` : ''} description={copy?.description ?? ''}
    tone="danger" confirmLabel="删除" pending={removal?.pending} onCancel={onCancel} onConfirm={onConfirm}>
    {copy && <div className="secrets-dialog">
      {copy.lead && <p>{copy.lead}</p>}
      {copy.active.length > 0 && list(copy.active)}
      {copy.notSmartNote && <p className="secrets-dialog-note">{copy.notSmartNote}</p>}
      {/* the note above already says they are not 智能群, so each line leaves it out */}
      {copy.notSmart.length > 0 && list(copy.notSmart.map(use => ({...use, notSmart: undefined})))}
      {copy.notes.map(note => <p className="secrets-dialog-note" key={note}>{note}</p>)}
      {removal?.error && <InlineNotice tone="danger" title="没做成">{`没删：${removal.error}。key 还在。`}</InlineNotice>}
    </div>}
  </ConfirmDialog>;
}

/**
 * 密钥 (product.md 3.1 第 9 条): the services that take a key, one machine-wide key each. Filling in is a save and a
 * 试一次; the page shows only whether a key is in and its last four. A dialog can close while its requests run, and
 * their result lands in the key's row; focus then goes back to the row, to its first button that can be pressed.
 */
export function SecretsPanel({onOpenLogs, onOpenApplication}: {onOpenLogs: () => void; onOpenApplication: () => void}) {
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

  const header = <PageHeader icon={KeyRound} title="密钥" description="要 key 的服务，整台机器一份，所有 Bot 共用。"
    actions={<Button size="sm" loading={reloading} disabled={read.kind === 'loading'} onClick={() => void reload()}>重新读取</Button>}/>;
  const fillService = fill && view?.services.find(service => service.keyId === fill.keyId);
  const removeService = removal && view?.services.find(service => service.keyId === removal.keyId);
  let body: ReactNode;
  if (read.kind === 'old') {
    body = <InlineNotice tone="warning" title="daemon 比网页旧" actions={<Button size="sm" variant="ghost" onClick={onOpenApplication}>去应用与启动</Button>}>
      重启 daemon 后再开这一页。
    </InlineNotice>;
  } else if (read.kind === 'failed') {
    body = <InlineNotice tone="danger" title="没读到密钥">{read.problem}</InlineNotice>;
  } else {
    const services = view?.services;
    body = <>
      {read.kind === 'ready' && read.problem && <InlineNotice tone="warning" title="没读到最新的">{`${read.problem}。下面是上一次读到的。`}</InlineNotice>}
      <SettingsGroup label="决策模型" id={settingAnchor('决策模型')}
        footer={<>Codex 和 Claude 用本机自己的登录，vonvon 不存它们的 key。终端里也能管：<code>vonvon secrets list</code>{(services ?? []).map(service => <span key={service.keyId}>、<code>vonvon secrets set {service.keyId}</code>（按提示粘贴，不回显）、<code>vonvon secrets remove {service.keyId}</code></span>)}。</>}>
        {!view ? <SettingsRow title="正在读取…"/>
          : !view.services.length ? <SettingsRow title="这个版本没有要 key 的服务"/>
            : view.services.map(service => <Fragment key={service.keyId}>
              <KeyRow service={service} view={view} row={rows[service.keyId] ?? {}}
                onFill={() => flows.open(service.keyId, false)} onReplace={() => flows.open(service.keyId, true, service.last4)}
                onRemove={() => setRemoval({keyId: service.keyId, pending: false})} onTest={() => void flows.test(service.keyId)} onOpenLogs={onOpenLogs}/>
              <UsesRow service={service} view={view}/>
            </Fragment>)}
      </SettingsGroup>
    </>;
  }
  return <div className="page-stack secrets-page" ref={page}>
    {header}
    {body}
    <FillKeyDialog flow={fillService ? fill : undefined} service={fillService} onClose={flows.close}
      onSubmit={value => void flows.save(value)} onAgain={flows.again} onRetest={() => void flows.retest()}/>
    <RemoveKeyDialog removal={removeService ? removal : undefined} service={removeService} view={view}
      onCancel={() => { if (removal) flows.refocusTo(removal.keyId); setRemoval(undefined); }} onConfirm={() => void remove()}/>
  </div>;
}

/** The 决策模型的 key row of 这台电脑 on the 状态与诊断 page: one per service, always there (s23g2). */
export function KeyDiagnosticsRows({read, onOpenSecrets, onShowLog}: {read: SecretsRead; onOpenSecrets: () => void; onShowLog: () => void}) {
  const title = '决策模型的 key';
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
