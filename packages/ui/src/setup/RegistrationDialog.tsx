import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowRight, Check, ChevronDown, Copy, ExternalLink, RefreshCw} from 'lucide-react';
import type {AgentId, Job} from '@vonvon/protocol';
import {useShellCapabilities} from '../client-context';
import {Button} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {OperationActivity} from '../management/OperationActivity';
import {copyAuthorizationUrl, copyFeedback, openExternalUrl} from '../url-actions';
import {GrantStep, type RegisterModal} from './GrantStep';
import {canRetryRegistration} from './registration-retry';
import './registration-dialog.css';

export function RegistrationDialog({modal, job, busy, feedback, onClose, onRetry, onChecklist}: {
  modal: RegisterModal; job?: Job; busy: boolean; feedback?: ReactNode;
  onClose: () => void; onRetry: () => void; onChecklist: (agentId: AgentId) => void;
}) {
  const [ready, setReady] = useState(false);
  const grant = Boolean(modal.agentId);
  const activating = job?.phase === 'activating';
  const complete = job?.phase === 'succeeded';
  return <Dialog open title={modal.refresh ? '刷新 Bot 凭据' : '注册 Bot'}
    onClose={busy || activating ? undefined : onClose}
    footer={<>
      <span className="registration-footer-status">{grant || complete ? <><Check size={13} aria-hidden="true"/>{modal.refresh ? '凭据已刷新' : 'Bot 已注册'}</> : busy || activating ? '请稍候' : modal.refresh ? '扫码后自动刷新凭据' : '扫码后自动进入下一步'}</span>
      <Button size="sm" variant="ghost" disabled={busy || activating} onClick={onClose}>{grant ? '稍后配置' : complete ? '完成' : '取消'}</Button>
      {grant && <Button size="sm" variant={ready ? 'primary' : 'secondary'} onClick={() => onChecklist(modal.agentId!)}>检查连接<ArrowRight size={13} aria-hidden="true"/></Button>}
    </>}>
    <div className="registration-content">
      {!modal.refresh && <div className="registration-steps" aria-label={grant ? '第 2 步：开通权限' : '第 1 步：扫码注册'}>
        <span className={grant ? 'complete' : 'current'}><i>{grant ? <Check size={12} aria-hidden="true"/> : 1}</i>扫码注册</span>
        <span className="registration-step-line"/>
        <span className={grant ? 'current' : ''}><i>2</i>开通权限</span>
      </div>}
      {feedback}
      {grant ? <GrantStep key={modal.agentId} agentId={modal.agentId!} onReadyChange={setReady}/> :
        <RegistrationScan key={modal.jobId} job={job} refresh={Boolean(modal.refresh)} busy={busy} onRetry={onRetry}/>}
    </div>
  </Dialog>;
}

export function RegistrationScan({job, refresh, busy, onRetry}: {job?: Job; refresh: boolean; busy: boolean; onRetry: () => void}) {
  const shell = useShellCapabilities();
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const disclosure = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (job?.phase !== 'qr') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job?.phase, job?.phase === 'qr' ? job.expiresAt : undefined]);
  const expired = job?.phase === 'qr' && job.expiresAt <= now;
  const retryable = canRetryRegistration(job, now);
  async function open(url: string) {
    setError('');
    try { await openExternalUrl(url, 'registration', shell); }
    catch (failure) {setError(failure instanceof Error ? failure.message : '无法打开链接，请复制后在浏览器打开。');}
  }
  async function copy(url: string) {
    setError(''); setCopied('');
    try {
      const result = await copyAuthorizationUrl(url, 'registration', () => {
        if (disclosure.current) disclosure.current.open = true;
        input.current?.focus(); input.current?.select();
      });
      setCopied(copyFeedback(result));
    } catch (failure) {setError(failure instanceof Error ? failure.message : '无法复制链接。');}
  }
  if (retryable) return <div className="registration-recovery">
    <div className="registration-recovery-icon"><RefreshCw size={27} aria-hidden="true"/></div>
    <h3>{expired ? '二维码已过期' : job?.phase === 'cancelled' ? '注册已取消' : '注册未完成'}</h3>
    <p>{expired ? '重新获取后，用飞书扫码继续。' : job && 'message' in job ? job.message : '注册状态已过期，请重新获取二维码。'}</p>
    <Button variant="primary" disabled={busy} loading={busy} onClick={onRetry}><RefreshCw size={14} aria-hidden="true"/>{expired ? '重新获取二维码' : '重新扫码'}</Button>
  </div>;
  if (job?.phase !== 'qr') return <div className="registration-recovery" role={job?.phase === 'succeeded' ? 'status' : undefined}>
    {job?.phase === 'succeeded' && <div className="registration-recovery-icon"><Check size={27} aria-hidden="true"/></div>}
    <h3>{job?.phase === 'succeeded' ? refresh ? '凭据已刷新' : 'Bot 已注册' : <OperationActivity key={job?.id} label={refresh ? '正在刷新凭据' : '正在注册 Bot'} state="connecting"/>}</h3>
    <p>{job && 'message' in job ? job.message : '正在等待注册状态…'}</p>
  </div>;
  return <div className="registration-scan">
    <h3>用飞书扫码</h3>
    <p className="registration-refresh-note">{refresh
      ? '请用这个 Bot 的管理员身份扫码，群聊、会话和设置会保留。'
      : '扫码后可以创建新应用，也可以选择已有应用。选择已有应用时，请核对飞书的确认页面，确认后可能更改该应用的配置。'}</p>
    <div className="registration-qr"><img src={job.image} alt="飞书注册二维码"/></div>
    <p className="registration-expires">有效期至 {new Date(job.expiresAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}</p>
    <div className="registration-link-actions">
      <Button size="sm" disabled={busy} onClick={() => void open(job.url)}><ExternalLink size={14} aria-hidden="true"/>打开链接</Button>
      <Button size="sm" disabled={busy} onClick={() => void copy(job.url)}><Copy size={14} aria-hidden="true"/>{copied === '已复制' ? '已复制' : '复制链接'}</Button>
    </div>
    <details ref={disclosure} className="registration-full-link">
      <summary>完整注册链接<ChevronDown size={12} aria-hidden="true"/></summary>
      <input ref={input} aria-label="完整注册链接" readOnly value={job.url}/>
    </details>
    {error && <p className="registration-error" role="alert">{error}</p>}
    {copied && <p className="registration-copy-note" role="status">{copied}</p>}
  </div>;
}
