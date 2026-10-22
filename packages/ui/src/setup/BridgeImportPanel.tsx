import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowRight, Check, Download, LoaderCircle} from 'lucide-react';
import type {BridgeImportReply, BridgeImportStep, BridgeImportView, BridgePreflight, DesktopSnapshot, MachineRequestHandler} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {Button, InlineNotice, StatusBadge} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import './bridge-import.css';

type ImportAction = 'detect' | 'preflight' | 'start' | 'status' | 'rollback';
const finished = new Set<BridgeImportStep>(['done', 'rolled-back', 'rollback-failed', 'refused']);
export const bridgeImportInProgress = (view: BridgeImportView | null | undefined) => Boolean(view && !finished.has(view.step));
export const canStartBridgeImport = (preflight: BridgePreflight | null | undefined, accepted: boolean, busy: boolean) => Boolean(preflight?.canImport && preflight.bots.length && accepted && !busy);

/** Confirmation belongs to the start request, never to a detection or a retry of a read. */
export async function requestBridgeImport(request: MachineRequestHandler, action: ImportAction): Promise<BridgeImportReply> {
  const reply = await request(action === 'start'
    ? {type: 'bridgeImport', action, acceptedChanges: true}
    : {type: 'bridgeImport', action});
  if (reply.type !== 'bridgeImport') throw new Error('导入状态没有返回，请重新检测。');
  return reply;
}

const stepCopy: Record<BridgeImportStep, string> = {
  checking: '再次确认迁移条件', stopping: '停止旧 Bridge', locking: '保护旧 Bot 数据',
  staging: '复制并转换数据', codex: '确认 Codex 可用', hooks: '处理旧审批 Hook',
  moving: '保存导入结果', starting: '连接飞书 Bot', finishing: '完成迁移记录',
  done: '导入完成', 'rolling-back': '正在回滚', 'rolled-back': '已回滚',
  'rollback-failed': '回滚尚未完成', refused: '暂时无法导入',
};
const phases: {label: string; steps: BridgeImportStep[]}[] = [
  {label: '检查与暂停', steps: ['checking', 'stopping', 'locking']},
  {label: '迁移数据', steps: ['staging', 'codex', 'hooks', 'moving']},
  {label: '连接 Bot', steps: ['starting']},
  {label: '完成', steps: ['finishing', 'done']},
];
const secretCopy: Record<BridgePreflight['bots'][number]['secret'], string> = {
  decryptable: '可以解密', plaintext: '可以读取', missing: '缺少凭据', invalid: '凭据格式异常',
  'cannot-decrypt': '无法解密，请在旧 Bridge 重新扫码', 'external-reference': '使用外部凭据，需要处理', unknown: '尚未确认',
};
const runningCopy: Record<BridgePreflight['service'], string> = {running: '正在运行', stopped: '已停止', unknown: '尚未确认'};
const fileCopy = {present: '已找到', missing: '未找到', invalid: '格式异常', unknown: '尚未确认'};
const hookCopy = {installed: '已安装，迁移时移除', absent: '未安装', 'needs-repair': '需要处理', unknown: '尚未确认'};

/** Detection failures describe a check, not evidence that a Bridge installation exists. */
export function bridgeImportEntry(reply: BridgeImportReply | undefined, issue?: string, showUnavailable = false): {
  title: string; detail: string; label: string; action: 'detect' | 'preflight' | 'status'; detected: boolean;
} | null {
  if (bridgeImportInProgress(reply?.view)) return {title: '正在从 Bridge 导入', detail: stepCopy[reply!.view!.step], label: '查看进度', action: 'status', detected: true};
  if (reply?.view?.step === 'rollback-failed') return {title: 'Bridge 导入需要恢复', detail: reply.view.error?.message ?? '部分恢复尚未完成，请查看导入记录。', label: '查看恢复进度', action: 'status', detected: true};
  if (reply?.view?.step === 'done' || reply?.detection?.kind === 'imported') return {title: '已从 Bridge 导入', detail: '原有 Bot 已迁移到 Vonvon，可查看导入回执。', label: '查看导入结果', action: 'status', detected: true};
  if (reply?.view?.step === 'rolled-back') return {title: 'Bridge 导入已撤回', detail: '原有数据已保留。处理问题后可以重新检查。', label: '查看导入记录', action: 'status', detected: true};
  if (reply?.view?.step === 'refused') return {title: 'Bridge 导入尚未开始', detail: reply.view.error?.message ?? '预检未通过，请处理问题后重试。', label: '重新检查', action: 'preflight', detected: true};
  if (issue) return {title: 'Bridge 检测未完成', detail: issue, label: '重新检测', action: 'detect', detected: false};
  switch (reply?.detection?.kind) {
    case 'found': return {title: '从 Bridge 导入', detail: '检测到 Feishu Codex Bridge，可导入原有 Bot、群聊和设置。', label: '查看导入', action: 'preflight', detected: true};
    case 'upgrade-required': return {title: 'Bridge 目录需要升级', detail: reply.detection.message, label: '重新检测', action: 'detect', detected: true};
    case 'invalid': return {title: '无法确认 Bridge 数据', detail: reply.detection.message, label: '重新检测', action: 'detect', detected: false};
    case 'not-found': return showUnavailable ? {title: '从 Bridge 导入', detail: '尚未在 ~/.feishu-codex-bridge 找到旧数据。若刚恢复旧目录，可以重新检测。', label: '重新检测', action: 'detect', detected: false} : null;
    case 'unsupported-platform': return null;
    default: return showUnavailable ? {title: '从 Bridge 导入', detail: '已有 Feishu Codex Bridge？可检查这台 Mac 上的旧数据。', label: '检测旧数据', action: 'detect', detected: false} : null;
  }
}

export function BridgeImportPanel({ready, busy, platform, onDetected, showUnavailable = false}: {
  ready: boolean; busy: boolean; platform: DesktopSnapshot['application']['platform'];
  onDetected?: (found: boolean) => void;
  showUnavailable?: boolean;
}) {
  const client = useClient();
  const [reply, setReply] = useState<BridgeImportReply>();
  const [operation, setOperation] = useState<ImportAction>();
  const [issue, setIssue] = useState<string>();
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const progress = bridgeImportInProgress(reply?.view);
  const entry = bridgeImportEntry(reply, issue, showUnavailable);
  const found = entry?.detected ?? false;

  useEffect(() => {onDetected?.(found);}, [found, onDetected]);

  const read = useCallback(async (action: ImportAction) => {
    const mine = ++sequence.current;
    if (action !== 'status') setOperation(action);
    setIssue(undefined);
    try {
      const next = await requestBridgeImport(request => client.machine(request), action);
      if (mounted.current && sequence.current === mine) setReply(next);
    } catch (error) {
      if (mounted.current && sequence.current === mine) setIssue(error instanceof Error ? error.message : '读取导入状态失败，请重试。');
    } finally {
      if (mounted.current && sequence.current === mine) setOperation(undefined);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; sequence.current += 1;};
  }, []);
  useEffect(() => {
    if (ready && platform === 'macos') void read('detect');
  }, [ready, platform, read]);
  useEffect(() => {
    if (!ready || !progress) return;
    const timer = window.setTimeout(() => {void read('status');}, 1200);
    return () => window.clearTimeout(timer);
  }, [ready, progress, reply, issue, read]);

  if (platform !== 'macos') return null;
  if (!entry) return null;
  const working = busy || !ready || Boolean(operation) || progress;
  const completed = reply?.view?.step === 'done' || reply?.detection?.kind === 'imported';
  function inspect() {
    setAccepted(false);
    if (entry!.action !== 'detect') setOpen(true);
    void read(entry!.action);
  }
  const retryAction = reply?.detection?.kind === 'invalid' || reply?.detection?.kind === 'upgrade-required' ? 'detect' : 'preflight';
  function recheck() {setAccepted(false); void read(retryAction);}
  return <>
    <section className="bridge-import-card" aria-label="Bridge 导入">
      <span className="bridge-import-card__icon"><Download size={20} aria-hidden="true"/></span>
      <div className="bridge-import-card__copy"><h2>{entry.title}</h2><p>{entry.detail}</p></div>
      <Button size="sm" variant={completed || !found ? 'secondary' : 'primary'} loading={operation === 'detect'} disabled={busy || !ready || Boolean(operation)} onClick={inspect} icon={<ArrowRight size={14} aria-hidden="true"/>}>{entry.label}</Button>
    </section>
    <Dialog open={open} title="从 Bridge 导入" description="一次导入全部 Bot，沿用原来的飞书应用。" size="md"
      onClose={working ? undefined : () => setOpen(false)} dismissible={!working}
      footer={completed || (reply?.view && (progress || reply.view.step === 'rollback-failed')) ? <>
        {!working && <Button onClick={() => setOpen(false)}>{completed ? '完成' : '关闭'}</Button>}
        {reply?.view?.canRollback && !progress && <Button variant="primary" disabled={working} onClick={() => void read('rollback')}>重试回滚</Button>}
        {progress && <span className="bridge-import__footer-note">请保持 Vonvon 运行，完成后会显示结果。</span>}
      </> : <>
        <Button disabled={working} onClick={() => setOpen(false)}>稍后再说</Button>
        {retryAction === 'detect' || !reply?.preflight?.canImport || !reply.preflight.bots.length || issue ? <Button variant="primary" loading={operation === retryAction} disabled={busy || !ready || progress} onClick={recheck}>{retryAction === 'detect' ? '重新检测' : '重新检查'}</Button>
          : <Button variant="primary" loading={operation === 'start'} disabled={!canStartBridgeImport(reply.preflight, accepted, working || Boolean(issue))} onClick={() => void read('start')}>开始导入</Button>}
      </>}>
      <div className="bridge-import">
        {issue && <InlineNotice title={progress ? '正在重新连接导入状态' : '未能完成操作'} tone="warning">{issue}{progress ? ' 后台可能仍在运行，请不要重新发起导入。' : ''}</InlineNotice>}
        {operation === 'preflight' && <div className="bridge-import__loading" role="status"><LoaderCircle size={18} className="ui-button__spinner"/>正在检查 Bot、群和本机数据…<small>这一步只读取旧数据，不会停止 Bridge。</small></div>}
        {reply?.view && <BridgeImportProgress view={reply.view}/>}
        {completed && !reply?.view && <InlineNotice tone="info" title="检测到迁移完成记录">暂未读取到详细回执。可以继续检查 Bot 的连接与权限。</InlineNotice>}
        {!progress && !completed && reply?.view?.step !== 'rollback-failed' && operation !== 'preflight' && <>
          {reply?.detection && ['upgrade-required', 'invalid'].includes(reply.detection.kind) && <InlineNotice tone="warning" title="导入前需要处理">{reply.detection.message}</InlineNotice>}
          {reply?.preflight && <BridgePreflightSummary preflight={reply.preflight}/>}
          <BridgeMigrationNotes/>
          {reply?.detection?.kind === 'found' && reply.preflight?.canImport && reply.preflight.bots.length > 0 && <label className="bridge-import__accept"><input type="checkbox" checked={accepted} disabled={working} onChange={event => setAccepted(event.target.checked)}/><span>我已了解迁移变化。开始导入后，会停止旧 Bridge；失败时会尝试恢复。</span></label>}
        </>}
      </div>
    </Dialog>
  </>;
}

export function BridgePreflightSummary({preflight}: {preflight: BridgePreflight}) {
  const hasBots = preflight.bots.length > 0;
  const allGroupsKnown = hasBots && preflight.bots.every(bot => bot.groups !== null);
  const groups = preflight.bots.reduce((total, bot) => total + (bot.groups ?? 0), 0);
  return <section className="bridge-import__preflight" aria-label="导入前检查">
    <header><div><h3>{hasBots ? <>{preflight.bots.length} 个 Bot{allGroupsKnown ? ` · ${groups} 个群绑定` : ''}</> : '尚未确认可导入的 Bot'}</h3><p>{hasBots ? '原工作区目录会继续使用，不会移动。' : '请先处理检测问题，再重新检查。'}</p></div><StatusBadge tone={preflight.canImport && hasBots ? 'success' : 'warning'}>{preflight.canImport && hasBots ? '可以导入' : '需要处理'}</StatusBadge></header>
    {hasBots && <ul className="bridge-import__bots">{preflight.bots.map(bot => <li key={bot.appId}><strong>{bot.name}</strong><span>{bot.groups === null ? '群绑定待确认' : `${bot.groups} 个群绑定`}</span></li>)}</ul>}
    {preflight.problems.length > 0 && <InlineNotice title="先处理这些问题，再重新检查" tone="warning"><ul>{preflight.problems.map((problem, index) => <li key={`${problem.code}-${index}`}>{problem.appId && <strong>{preflight.bots.find(bot => bot.appId === problem.appId)?.name ?? problem.appId}：</strong>}{problem.message}</li>)}</ul></InlineNotice>}
    {preflight.notes.length > 0 && <ul className="bridge-import__notes">{preflight.notes.map((note, index) => <li key={`${note.kind}-${index}`}>{note.message}</li>)}</ul>}
    <details><summary>查看预检详情</summary><dl><div><dt>旧 Bridge</dt><dd>{runningCopy[preflight.service]}</dd></div><div><dt>Bridge 安装的 Codex</dt><dd>{fileCopy[preflight.bundledCodex]}</dd></div></dl>
      {preflight.bots.map(bot => <section className="bridge-import__bot-check" key={bot.appId}><h4>{bot.name}</h4><dl>
        <div><dt>连接凭据</dt><dd>{secretCopy[bot.secret]}</dd></div><div><dt>运行状态</dt><dd>{runningCopy[bot.running]}</dd></div>
        {bot.directories.map(directory => <div key={directory.index}><dt>工作区 {directory.index + 1}</dt><dd>{fileCopy[directory.state]}</dd></div>)}
        <div><dt>Claude 审批 Hook</dt><dd>{hookCopy[bot.hooks.claude]}</dd></div><div><dt>Codex 审批 Hook</dt><dd>{hookCopy[bot.hooks.codex]}</dd></div>
      </dl>{bot.problems.length > 0 && <p className="bridge-import__technical">{bot.problems.map(problem => `${problem.file}：${problem.code}`).join('；')}</p>}</section>)}
    </details>
  </section>;
}

export function BridgeMigrationNotes() {
  return <section className="bridge-import__migration" aria-label="迁移变化">
    <h3>接着用原来的 Bot</h3>
    <ul><li>全部 Bot、群绑定、模型与规则设置；管理员名单。</li><li>Codex 线程、Claude 会话、评论提示词与已发文件记录。请保留旧目录和原来的 CODEX_HOME。</li></ul>
    <details><summary>迁移后有哪些变化</summary><ul>
      <li>群设置转为规则模式；管理员与访客权限不同时，采用更严格的一档。</li>
      <li>原群目录成为主工作区；原有个人指令与技能继续按 Provider 的规则加载。</li>
      <li>多 Bot 群中，各自只参与自己的话题；在群主区使用命令需要 @ Bot。</li>
      <li>“全部回复”会把引用 Bot 消息视为点名；自动压缩统一开启。</li>
      <li>云文档评论未设置权限时，改用默认的读写与开网权限。</li>
      <li>原网页及私聊控制台由这里的设置替代，需要补充飞书消息只读权限。</li>
    </ul></details>
    <details><summary>不再迁移的内容</summary><ul><li>日志、缓存、已下载的 Claude SDK（需要时重新下载）和 Codex Fast。</li><li>“咖啡一下”停止提供，旧审批 Hook 会移除，审批回到原终端。</li><li>本次导入仅支持 macOS；不迁移 Windows、WSL 或 Linux 环境。</li></ul></details>
  </section>;
}

export function BridgeImportProgress({view}: {view: BridgeImportView}) {
  const activePhase = phases.findIndex(phase => phase.steps.includes(view.step));
  const progress = bridgeImportInProgress(view);
  return <section className="bridge-import__progress" aria-label="导入进度" aria-live="polite">
    <h3>{progress ? <LoaderCircle size={18} className="ui-button__spinner" aria-hidden="true"/> : view.step === 'done' ? <Check size={18} aria-hidden="true"/> : null}{stepCopy[view.step]}</h3>
    {activePhase >= 0 && <ol className="bridge-import__phases">{phases.map((phase, index) => <li key={phase.label} data-state={index < activePhase || view.step === 'done' ? 'done' : index === activePhase ? 'current' : 'waiting'}><span>{index < activePhase || view.step === 'done' ? <Check size={12} aria-hidden="true"/> : index + 1}</span>{phase.label}</li>)}</ol>}
    {view.bots.length > 0 && <p>{view.bots.map(bot => bot.name).join('、')}</p>}
    {view.error && <InlineNotice title="导入没有完成" tone="warning">{view.error.message}</InlineNotice>}
    {view.cleanupPending && <InlineNotice title="还需要完成恢复" tone="warning">{view.canRollback ? '部分恢复尚未完成，请重试回滚。' : '部分恢复尚未完成，请根据错误说明处理后再继续。'}</InlineNotice>}
    {view.step === 'rolled-back' && <p>已撤回本次导入。处理问题后，可以重新检查并导入。</p>}
    {view.step === 'done' && <InlineNotice title="请保留旧 Bridge 目录" tone="info">原有项目与旧会话还会使用其中的文件。接下来检查飞书权限，确认 Bot 可以继续工作。</InlineNotice>}
    {view.notes.length > 0 && <ul className="bridge-import__notes">{view.notes.map((note, index) => <li key={`${note.kind}-${index}`}>{note.message}</li>)}</ul>}
  </section>;
}
