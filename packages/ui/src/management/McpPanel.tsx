import {settingAnchor} from '../search';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {ChevronDown, Plus, X} from 'lucide-react';
import {mcpConfigSchema, type MachineReply, type MachineRequest} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {Button, FormField, InlineNotice} from '../reference/components/ui';
import {ConfirmDialog, Dialog} from '../reference/components/ui/Dialog';
import {SettingChoices} from '../settings/SettingChoices';
import {useDraft, useDraftGuard} from '../settings/DraftGuard';
import {copyShortcut} from '../url-actions';
import './mcp.css';

type McpView = Extract<MachineReply, {type: 'mcp'}>;
type McpRequest = Extract<MachineRequest, {type: 'mcp'}>['request'];
type AddRequest = Extract<McpRequest, {action: 'add'}>;
type Entry = McpView['entries'][number];
type Provider = McpView['provider'];
const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude';
const providers = [{value: 'codex', label: 'Codex'}, {value: 'claude', label: 'Claude'}] as const;
const safeFailure = '操作未完成，请重新读取后重试。';

/** Arguments are supplied by the daemon. Quote every argument; never execute it here. */
export function mcpLoginCommand(argv: readonly string[]): string | undefined {
  if (!argv[0]?.trim() || argv.some(value => /[\x00-\x1f\x7f]/.test(value))) return undefined;
  return argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}
export function mcpSummary(entry: Entry): string {
  if (entry.transport === 'stdio') return [entry.command || '本机命令', entry.argumentCount ? `${entry.argumentCount} 个参数` : ''].filter(Boolean).join(' · ');
  if (entry.transport === 'http' || entry.transport === 'sse') {
    try {return entry.urlOrigin ? new URL(entry.urlOrigin).origin : entry.transport.toUpperCase();} catch {return entry.transport.toUpperCase();}
  }
  return '其他配置';
}

export function McpPanel({refreshKey = 0}: {refreshKey?: number}) {
  const client = useClient();
  const {navigate} = useDraftGuard();
  const [provider, setProvider] = useState<Provider>('codex');
  const [view, setView] = useState<McpView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Entry>();
  const [authorizing, setAuthorizing] = useState<Entry>();
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {
      const reply = await client.machine({type: 'mcp', request: {action: 'list', provider}});
      if (request !== sequence.current) return;
      if (reply.type !== 'mcp' || reply.provider !== provider) throw new Error();
      setView(previous => reply.status === 'unavailable' && previous?.provider === provider ? {...reply, entries: previous.entries, configPath: reply.configPath || previous.configPath} : reply);
      if (reply.status !== 'ready') setError(reply.message || '无法读取 MCP 配置。');
      return reply;
    } catch {
      if (request === sequence.current) setError('未读到最新的 MCP 配置。');
    } finally {if (request === sequence.current) setLoading(false);}
  }, [client, provider]);
  useEffect(() => {void refresh(); return () => {sequence.current++;};}, [refresh, refreshKey]);
  const current = view?.provider === provider ? view : undefined;
  const writable = Boolean(current?.status === 'ready' && current.cliAvailable && !loading && !error && !busy);
  async function add(name: string, config: AddRequest['config'], revision: string) {
    const reply = await client.machine({type: 'mcp', request: {action: 'add', provider, name, config, revision}});
    if (reply.type !== 'mcp' || reply.provider !== provider) throw new Error(safeFailure);
    if (reply.status === 'conflict') {
      setView(reply);
      return {kind: 'conflict' as const, message: reply.message || '配置已在别处更改。'};
    }
    if (reply.status !== 'ready' || !reply.changed) return {kind: 'failed' as const, message: reply.message || safeFailure};
    setView(reply); setAdding(false); setNotice('已添加。新会话使用更新后的配置。');
    return {kind: 'saved' as const};
  }
  async function remove() {
    if (!removing || !current || !writable) return;
    setBusy(true); setRemoveError('');
    try {
      const reply = await client.machine({type: 'mcp', request: {action: 'remove', provider, name: removing.name, revision: current.revision}});
      if (reply.type !== 'mcp' || reply.provider !== provider) throw new Error();
      if (reply.status !== 'ready' || !reply.changed) {
        if (reply.status === 'conflict') {setView(reply); setError('配置已更改，请重新读取后再操作。');}
        setRemoveError(reply.message || safeFailure); return;
      }
      setView(reply); setRemoving(undefined); setNotice('已移除。新会话使用更新后的配置。');
    } catch {setRemoveError(safeFailure);} finally {setBusy(false);}
  }
  return <section className="mcp-panel" id={settingAnchor('MCP')} aria-label="MCP 连接">
    <header className="mcp-heading"><h3>MCP 连接</h3><div><Button size="sm" disabled={loading || busy || adding} onClick={() => void refresh()}>重新读取</Button><Button size="sm" icon={<Plus size={13}/>} disabled={!writable || adding} onClick={() => {setNotice(''); setAdding(true);}}>添加</Button></div></header>
    <SettingChoices label="MCP Provider" value={provider} choices={providers} disabled={busy || adding} onChange={next => navigate(() => {setProvider(next); setError(''); setNotice(''); setRemoving(undefined); setAuthorizing(undefined);})}/>
    {error && <InlineNotice title="读取未完成" tone="warning">{error}{current?.entries.length ? ' 下面保留上次读取的列表。' : ''}</InlineNotice>}
    {loading && !current && <p className="mcp-empty" role="status">正在读取…</p>}
    {current && <>
      <McpEntries view={current} disabled={!writable} onAuthorize={setAuthorizing} onRemove={entry => {setRemoving(entry); setRemoveError('');}}/>
      <details className="mcp-source"><summary>配置来源</summary><span>{providerName(provider)} 用户配置</span><code>{current.configPath}</code></details>
      {!current.cliAvailable && <p className="mcp-note">安装 {providerName(provider)} 命令行后可管理连接。</p>}
    </>}
    {notice && <p className="mcp-note" role="status">{notice}</p>}
    {adding && current && <AddMcpDialog provider={provider} revision={current.revision} onSave={add} onRefresh={refresh} onClose={() => setAdding(false)}/>}
    <ConfirmDialog open={Boolean(removing)} title={`移除 ${removing?.name ?? 'MCP'}？`} description={`将从 ${providerName(provider)} 用户配置移除，使用此配置的 Bot 都会受影响。`} confirmLabel="移除" tone="danger" pending={busy} error={removeError}
      onCancel={() => {if (!busy) setRemoving(undefined);}} onConfirm={() => void remove()}><p className="mcp-note">只移除本机配置，保留远端服务。</p>{current?.status === 'conflict' && <Button disabled={busy || loading} onClick={async () => {const latest = await refresh(); if (latest?.status === 'ready') {if (!latest.entries.some(entry => entry.name === removing?.name)) {setRemoving(undefined); setNotice('该连接已从配置中移除。');} else setRemoveError('已重新读取，请确认后再次移除。');}}}>重新读取</Button>}</ConfirmDialog>
    <McpAuthorizationDialog provider={provider} entry={authorizing} onClose={() => setAuthorizing(undefined)}/>
  </section>;
}

export function McpEntries({view, disabled, onAuthorize, onRemove}: {view: McpView; disabled: boolean; onAuthorize: (entry: Entry) => void; onRemove: (entry: Entry) => void}) {
  return <div className="mcp-list">
    {view.entries.length ? view.entries.map(entry => <details className="mcp-entry" key={entry.name}>
      <summary><span><strong>{entry.name}</strong><small>{mcpSummary(entry)}{!entry.enabled ? ' · 配置中已停用' : ''}</small></span><ChevronDown size={14}/></summary>
      <div className="mcp-entry-detail"><dl>
        <div><dt>连接方式</dt><dd>{entry.transport === 'stdio' ? '本机命令' : entry.transport === 'unknown' ? '其他' : entry.transport.toUpperCase()}</dd></div>
        {entry.envNames.length > 0 && <div><dt>环境变量</dt><dd>{entry.envNames.join('、')}</dd></div>}
        {entry.headerNames.length > 0 && <div><dt>请求头</dt><dd>{entry.headerNames.join('、')}</dd></div>}
        <div><dt>作用范围</dt><dd>{providerName(view.provider)} 用户配置</dd></div>
      </dl><div className="mcp-entry-actions">
        {entry.loginArgv && mcpLoginCommand(entry.loginArgv) && <Button size="sm" disabled={disabled} onClick={() => onAuthorize(entry)}>授权…</Button>}
        <Button size="sm" disabled={disabled} onClick={() => onRemove(entry)}>移除…</Button>
      </div></div>
    </details>) : view.status === 'ready' ? <p className="mcp-empty">尚未添加连接</p> : <p className="mcp-empty">连接列表暂不可用</p>}
  </div>;
}

type SaveOutcome = {kind: 'saved'} | {kind: 'failed' | 'conflict'; message: string};
export function AddMcpDialog({provider, revision, onSave, onRefresh, onClose}: {provider: Provider; revision: string; onSave: (name: string, config: AddRequest['config'], revision: string) => Promise<SaveOutcome>; onRefresh: () => Promise<McpView | undefined>; onClose: () => void}) {
  const {navigate} = useDraftGuard();
  const id = useId();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envRows, setEnvRows] = useState<{id: number; name: string}[]>([]);
  const envId = useRef(0);
  const envInputs = useRef(new Map<number, HTMLInputElement>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const baseline = useRef(revision);
  const dirty = Boolean(name || url || tokenEnv || command || args || envRows.length);
  const complete = Boolean(name.trim() && (transport === 'http' ? url.trim() : command.trim()));
  function discard() {for (const input of envInputs.current.values()) input.value = ''; onClose();}
  function close() {if (!pending) navigate(discard);}
  async function save() {
    if (!complete || pending || conflict) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name.trim())) {setError('名称以英文或数字开头，最多 64 个字符，可包含 . _ -。'); return false;}
    let config: AddRequest['config'];
    if (transport === 'http') {
      try {const parsed = new URL(url.trim()); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();}
      catch {setError('请输入 HTTP 或 HTTPS 地址，不含用户名和密码。'); return false;}
      if (tokenEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv.trim())) {setError('请填写有效的环境变量名。'); return false;}
      config = {transport, url: url.trim(), ...(tokenEnv.trim() ? {bearerTokenEnvVar: tokenEnv.trim()} : {})};
    } else {
      const names = envRows.map(row => row.name.trim());
      if (names.some(value => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) || new Set(names).size !== names.length) {setError('环境变量名称无效或重复。'); return false;}
      const env = Object.fromEntries(envRows.map(row => [row.name.trim(), envInputs.current.get(row.id)?.value ?? '']));
      config = {transport, command: command.trim(), args: args ? args.split(/\r?\n/) : [], ...(envRows.length ? {env} : {})};
    }
    if (!mcpConfigSchema.safeParse(config).success) {setError('配置内容过长或格式有误，请检查后重试。'); return false;}
    setPending(true); setError('');
    try {
      const result = await onSave(name.trim(), config, baseline.current);
      if (result.kind === 'saved') {for (const input of envInputs.current.values()) input.value = ''; return true;}
      setConflict(result.kind === 'conflict'); setError(result.message); return false;
    } catch {setError(safeFailure); return false;} finally {setPending(false);}
  }
  // Navigation never adds a real connection implicitly.
  useDraft(dirty || pending, {title: '添加 MCP', discard});
  return <Dialog open title="添加 MCP" onClose={pending ? undefined : close} footer={<><Button disabled={pending} onClick={close}>取消</Button><Button variant="primary" loading={pending} disabled={!complete || conflict} onClick={() => void save()}>添加</Button></>}>
    <div className="mcp-form">
      <p className="mcp-note">添加到 {providerName(provider)} 用户配置。</p>
      <FormField label="名称" htmlFor={`${id}-name`}><input id={`${id}-name`} value={name} disabled={pending} maxLength={64} autoComplete="off" onChange={event => setName(event.target.value)}/></FormField>
      <SettingChoices label="连接方式" value={transport} choices={[{value: 'http', label: '远程地址'}, {value: 'stdio', label: '本机命令'}]} disabled={pending} onChange={setTransport}/>
      {transport === 'http' ? <>
        <FormField label="服务地址" htmlFor={`${id}-url`}><input id={`${id}-url`} type="url" value={url} disabled={pending} placeholder="https://…/mcp" autoComplete="off" spellCheck={false} onChange={event => setUrl(event.target.value)}/></FormField>
        <details className="mcp-form-advanced"><summary>令牌环境变量</summary><FormField label="变量名" htmlFor={`${id}-token`} description="由 Provider 读取该变量，不在这里填写令牌。"><input id={`${id}-token`} value={tokenEnv} disabled={pending} placeholder="MCP_TOKEN" autoComplete="off" onChange={event => setTokenEnv(event.target.value)}/></FormField></details>
      </> : <>
        <FormField label="命令或可执行文件" htmlFor={`${id}-command`}><input id={`${id}-command`} value={command} disabled={pending} autoComplete="off" spellCheck={false} onChange={event => setCommand(event.target.value)}/></FormField>
        <FormField label="参数" htmlFor={`${id}-args`} description="每行一个参数，无需加引号。"><textarea id={`${id}-args`} rows={3} value={args} disabled={pending} autoComplete="off" spellCheck={false} onChange={event => setArgs(event.target.value)}/></FormField>
        <details className="mcp-form-advanced"><summary>环境变量</summary>
          {envRows.map(row => <div className="mcp-env-row" key={row.id}><input aria-label="环境变量名" value={row.name} disabled={pending} placeholder="变量名" autoComplete="off" onChange={event => setEnvRows(rows => rows.map(item => item.id === row.id ? {...item, name: event.target.value} : item))}/><input aria-label={`环境变量 ${row.name || '未命名'} 的值`} type="password" disabled={pending} autoComplete="off" spellCheck={false} data-1p-ignore="" data-lpignore="true" ref={input => {if (input) envInputs.current.set(row.id, input); else envInputs.current.delete(row.id);}} placeholder="值"/><button type="button" className="mcp-remove-env" aria-label="移除环境变量" disabled={pending} onClick={() => {const input = envInputs.current.get(row.id); if (input) input.value = ''; setEnvRows(rows => rows.filter(item => item.id !== row.id));}}><X size={14}/></button></div>)}
          <Button size="sm" disabled={pending} onClick={() => setEnvRows(rows => [...rows, {id: ++envId.current, name: ''}])}>添加变量</Button>
        </details>
      </>}
      {error && <InlineNotice title="添加未完成" tone="warning">{error}</InlineNotice>}
      {conflict && <Button disabled={pending} onClick={async () => {setPending(true); try {const latest = await onRefresh(); if (latest?.status === 'ready') {baseline.current = latest.revision; setConflict(false); setError('已重新读取，请确认后再次添加。');} else setError('仍无法读取最新配置，草稿已保留。');} finally {setPending(false);}}}>重新读取并保留草稿</Button>}
    </div>
  </Dialog>;
}

export function McpAuthorizationDialog({provider, entry, onClose}: {provider: Provider; entry?: Entry; onClose: () => void}) {
  const command = entry?.loginArgv ? mcpLoginCommand(entry.loginArgv) : undefined;
  const field = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {setNotice('');}, [entry]);
  async function copy() {
    if (!command) return;
    try {await navigator.clipboard.writeText(command); setNotice('已复制');}
    catch {field.current?.focus(); field.current?.select(); setNotice(`按 ${copyShortcut()} 复制`);}
  }
  return <Dialog open={Boolean(entry && command)} title={`授权 ${entry?.name ?? 'MCP'}`} onClose={onClose} footer={<><Button onClick={onClose}>完成</Button><Button variant="primary" onClick={() => void copy()}>复制命令</Button></>}>
    <div className="mcp-authorization"><p>在本机终端运行命令，按 {providerName(provider)} 提示完成授权。</p><textarea ref={field} aria-label="MCP 授权命令" value={command ?? ''} rows={3} readOnly/>
      <p className="mcp-note">这里不检测授权结果；完成后在新会话中使用连接。</p>{notice && <p className="mcp-note" role="status">{notice}</p>}
    </div>
  </Dialog>;
}
