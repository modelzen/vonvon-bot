import {useState} from 'react';
import {Bot, CheckCircle2, CircleAlert, LoaderCircle} from 'lucide-react';
import {Button, StatusBadge} from '../reference/components/ui';
import './import.css';

// This is presentation data. The daemon's import protocol must supply and validate it.
export interface ImportPreview {
  readonly bots: readonly {
    readonly id: string;
    readonly name: string;
    readonly tenant: 'feishu' | 'lark';
    readonly groups: readonly {readonly id: string; readonly name: string}[];
    readonly sessions: readonly {readonly id: string; readonly groupId: string}[];
  }[];
}

export type ImportView =
  | {readonly kind: 'unavailable'}
  | {readonly kind: 'loading'}
  | {readonly kind: 'missing'}
  | {readonly kind: 'invalid'; readonly message: string}
  | {readonly kind: 'ready'; readonly preview: ImportPreview}
  | {readonly kind: 'running'; readonly preview: ImportPreview}
  | {readonly kind: 'failed'; readonly message: string}
  | {readonly kind: 'cancelled'}
  | {readonly kind: 'result'; readonly bots: readonly {readonly id: string; readonly name: string; readonly connected: boolean}[]; readonly bridgeDisabled: boolean};

export function importComplete(view: ImportView): boolean {
  return view.kind === 'result' && view.bridgeDisabled && view.bots.length > 0 && view.bots.every(bot => bot.connected);
}

export function ImportFirstRunStep({onOpen}: {onOpen: () => void}) {
  return <section className="bridge-import-first-run">
    <Bot size={20} aria-hidden="true" />
    <div><h3>从 feishu-codex-bridge 导入</h3><p>已有 Bridge 数据？先查看本机 Bot、群和会话，再决定是否导入。无需登录 Vonvon 账号。</p></div>
    <Button onClick={onOpen}>查看导入</Button>
  </section>;
}

export function ImportPage({view = {kind: 'unavailable'}, onInspect, onConfirm}: {
  view?: ImportView;
  onInspect?: () => void;
  onConfirm?: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const preview = view.kind === 'ready' || view.kind === 'running' ? view.preview : undefined;
  const canConfirm = view.kind === 'ready' && view.preview.bots.length > 0 && !!onConfirm;
  const complete = importComplete(view);

  return <main className="bridge-import-page">
    <header className="bridge-import-header"><p className="bridge-import-eyebrow">首次运行 · 本机数据</p><h1>导入 Bridge 数据</h1>
      <p>先只读检查旧数据。确认后才开始导入；导入期间会暂停旧服务，核验 Bot 连接后再关闭其开机自启。</p></header>

    {view.kind === 'unavailable' && <div className="bridge-import-notice" role="status"><CircleAlert size={18} aria-hidden="true" />导入服务尚未接入。当前不能读取或导入旧数据。</div>}
    {view.kind === 'loading' && <div className="bridge-import-notice" role="status"><LoaderCircle size={18} aria-hidden="true" />正在只读检查 Bridge 数据…</div>}
    {view.kind === 'missing' && <div className="bridge-import-notice" role="status">本机没有找到可导入的 Bridge 数据。</div>}
    {view.kind === 'invalid' && <div className="bridge-import-notice bridge-import-error" role="alert">预检失败：{view.message}</div>}
    {view.kind === 'failed' && <div className="bridge-import-notice bridge-import-error" role="alert">导入失败：{view.message}。请先核对旧服务恢复情况。</div>}
    {view.kind === 'cancelled' && <div className="bridge-import-notice" role="status">已取消导入。没有完成连接核验。</div>}

    {preview && <section className="bridge-import-content" aria-label="待导入数据">
      <div className="bridge-import-summary"><strong>{preview.bots.length} 个 Bot</strong><span>{preview.bots.reduce((count, bot) => count + bot.groups.length, 0)} 个群</span><span>{preview.bots.reduce((count, bot) => count + bot.sessions.length, 0)} 个会话</span></div>
      {preview.bots.length === 0 && <p role="status">预检没有找到可导入的 Bot。</p>}
      {preview.bots.map(bot => <article className="bridge-import-bot" key={bot.id}>
        <div className="bridge-import-bot-heading"><Bot size={18} aria-hidden="true" /><h2>{bot.name}</h2><StatusBadge tone="neutral">{bot.tenant === 'lark' ? 'Lark' : '飞书'}</StatusBadge></div>
        <div className="bridge-import-lists"><section><h3>群 · {bot.groups.length}</h3>{bot.groups.length ? <ul>{bot.groups.map(group => <li key={group.id}>{group.name}</li>)}</ul> : <p>无群</p>}</section>
          <section><h3>会话 · {bot.sessions.length}</h3>{bot.sessions.length ? <ul>{bot.sessions.map(session => <li key={session.id}>群 {bot.groups.find(group => group.id === session.groupId)?.name ?? session.groupId} · {session.id}</li>)}</ul> : <p>无会话</p>}</section></div>
      </article>)}
    </section>}

    {view.kind === 'running' && <div className="bridge-import-notice" role="status"><LoaderCircle size={18} aria-hidden="true" />正在导入并核验连接。请等待真实结果，暂不要关闭页面。</div>}
    {view.kind === 'result' && <section className="bridge-import-content" aria-label="导入结果">
      <div className={`bridge-import-notice ${complete ? 'bridge-import-success' : 'bridge-import-error'}`} role={complete ? 'status' : 'alert'}>
        {complete ? <CheckCircle2 size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
        {complete ? '所有 Bot 已连接，旧 Bridge 服务已关闭。' : '导入尚未完成全部连接和旧服务核验。'}
      </div>
      <ul className="bridge-import-results">{view.bots.map(bot => <li key={bot.id}><span>{bot.name}</span><StatusBadge tone={bot.connected ? 'success' : 'warning'}>{bot.connected ? '已连接' : '未连接'}</StatusBadge></li>)}</ul>
      {!view.bridgeDisabled && <p>旧 Bridge 服务关闭状态尚未核实。</p>}
    </section>}

    <div className="bridge-import-actions">
      {onInspect && view.kind !== 'running' && <Button onClick={onInspect} disabled={view.kind === 'loading'}>重新检查</Button>}
      <Button variant="primary" disabled={!canConfirm} onClick={() => setConfirmOpen(true)}>确认导入</Button>
    </div>
    {confirmOpen && canConfirm && <div className="bridge-import-dialog-backdrop" role="presentation"><section className="bridge-import-dialog" role="dialog" aria-modal="true" aria-labelledby="bridge-import-confirm-title">
      <h2 id="bridge-import-confirm-title">确认导入 {view.preview.bots.length} 个 Bot？</h2>
      <p>导入会暂停当前用户的 Bridge 服务，复制本机数据并检查每个 Bot 的连接。失败时由导入执行器恢复旧服务。</p>
      <div className="bridge-import-actions"><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button variant="primary" onClick={() => {setConfirmOpen(false); onConfirm?.();}}>开始导入</Button></div>
    </section></div>}
  </main>;
}
