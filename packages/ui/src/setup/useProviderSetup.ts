import {useCallback, useEffect, useRef, useState} from 'react';
import type {BackendEntry, CollaborationReply, Command, CommandResult, DesktopSnapshot, EnvironmentOperation, EnvironmentReply, EnvironmentRequest, EnvironmentToolState, ToolInstallOperation} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {providerAuthenticated, providerBackends, providerInstalled, providerSignature, type SetupProvider} from './provider-state';

type Models = Extract<CollaborationReply, {kind: 'providerModels'}>;
type Install = Extract<EnvironmentReply, {kind: 'backendInstallStatus'}>['operation'];
type Check = {state: 'checking' | 'ready' | 'unavailable'; provider: SetupProvider; signature: string; models?: Models['models']; message?: string};
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';

/** Owns only this Provider's UI. Native configuration is read, never replaced. */
export function useProviderSetup(provider: SetupProvider, snapshot: DesktopSnapshot, ready: boolean, run: (command: Command) => Promise<CommandResult>) {
  const client = useClient();
  const backend = providerBackends[provider];
  const [tools, setTools] = useState<EnvironmentToolState[]>([]);
  const [entry, setEntry] = useState<BackendEntry>();
  const [check, setCheck] = useState<Check>();
  const [install, setInstall] = useState<Install>(null);
  const [toolInstall, setToolInstall] = useState<ToolInstallOperation | null>(null);
  const [login, setLogin] = useState<EnvironmentOperation | null>(null);
  const [working, setWorking] = useState(false);
  const [pendingToolInstall, setPendingToolInstall] = useState(false);
  const [issue, setIssue] = useState('');
  const mounted = useRef(true);
  const sequence = useRef(0);
  const infoSequence = useRef(0);
  const statusSequence = useRef(0);
  const providerNow = useRef(provider); providerNow.current = provider;
  const pendingRequests = useRef(0);
  const observedLoginId = useRef<string | undefined>(undefined);
  const observedToolInstallId = useRef<string | undefined>(undefined);
  const tool = snapshot.tools.find(item => item.tool === provider);
  const signature = providerSignature(tool);
  const codexJob = snapshot.jobs.filter(job => job.type === 'loginCodex').at(-1);
  const activeCodexJob = provider === 'codex' && codexJob && !['succeeded', 'failed', 'cancelled'].includes(codexJob.phase) ? codexJob : undefined;
  const accept = useCallback((reply: EnvironmentReply) => {
    if (!mounted.current) return;
    if (reply.kind === 'refused') throw new Error(reply.message);
    if (reply.kind === 'tools') setTools(reply.tools);
    if (reply.kind === 'backends') setEntry(reply.entries.find(item => item.id === backend));
    if (reply.kind === 'backendInstallStatus') setInstall(reply.operation);
    if (reply.kind === 'toolInstall') {
      if (reply.operation?.kind === 'running' && reply.operation.tool === provider) observedToolInstallId.current = reply.operation.id;
      setToolInstall(reply.operation);
    }
    if (reply.kind === 'operation') {
      if (reply.operation?.kind === 'running' && reply.operation.purpose.kind === 'login' && reply.operation.purpose.tool === provider) observedLoginId.current = reply.operation.id;
      setLogin(reply.operation);
    }
  }, [backend, provider]);
  const readReplies = useCallback(async (requests: EnvironmentRequest[], sequence: {current: number}) => {
    const mine = ++sequence.current;
    await Promise.all(requests.map(async request => {
      try {
        const reply = await client.environment(request);
        if (mounted.current && providerNow.current === provider && mine === sequence.current) accept(reply);
      } catch {
        if (mounted.current && providerNow.current === provider && mine === sequence.current) setIssue('状态读取未完成，请重新检测。');
      }
    }));
  }, [client, provider, accept]);
  const pollStatus = useCallback(() => readReplies([
    {type: 'backendInstallStatus', id: backend}, {type: 'toolInstallStatus'}, {type: 'loginStatus'},
  ], statusSequence), [backend, readReplies]);
  const read = useCallback(() => Promise.all([
    readReplies([{type: 'scan'}, {type: 'backendCatalog'}], infoSequence), pollStatus(),
  ]).then(() => undefined), [readReplies, pollStatus]);
  const verify = useCallback(async () => {
    const mine = ++sequence.current;
    const currentRequest = () => mounted.current && providerNow.current === provider && mine === sequence.current;
    setCheck({state: 'checking', provider, signature: ''});
    setIssue('');
    try {
      // Claude's snapshot authentication is cached; ask the SDK explicitly first.
      if (provider === 'claude') {
        const catalog = await client.environment({type: 'backendCatalog'});
        if (!currentRequest()) return;
        accept(catalog);
        if (catalog.kind === 'backends' && catalog.entries.some(item => item.id === backend && item.depState === 'installed')) {
          const login = await client.environment({type: 'backendLogin', id: backend, refresh: true});
          if (!currentRequest()) return;
          accept(login);
        }
      }
      await run({type: 'refresh', tools: true});
      if (!currentRequest()) return;
      const current = (await client.snapshot()).tools.find(item => item.tool === provider);
      if (!currentRequest()) return;
      const currentSignature = providerSignature(current);
      const source = tools.find(item => item.tool === provider);
      if (provider === 'claude' || current?.installation === 'installed' && (!tool || tool.installation === 'unknown' || !source || source.installation === 'missing')) {
        await readReplies([{type: 'scan'}], infoSequence);
        if (!currentRequest()) return;
      }
      if (!providerInstalled(current) || !providerAuthenticated(current)) {
        if (currentRequest()) setCheck({state: 'unavailable', provider, signature: currentSignature, message: !current || current.installation === 'unknown' ? current?.message || '暂时无法确认安装状态，请重新检测。' : providerInstalled(current) && current.authentication === 'unknown' ? current.message : undefined});
        return;
      }
      const models = await client.collaboration({action: 'providerModels', backend});
      if (!currentRequest()) return;
      if (models.kind !== 'providerModels') throw new Error('模型读取未完成，请重试。');
      setCheck({state: models.state === 'ready' && models.models.length > 0 ? 'ready' : 'unavailable', provider, signature: currentSignature, models: models.models, message: models.message});
    } catch (error) {
      if (currentRequest()) setCheck({state: 'unavailable', provider, signature: '', message: errorText(error)});
    }
  }, [client, provider, backend, accept, run, readReplies, tool, tools]);
  // run is supplied by App and can change on every snapshot; keep effects tied to native state.
  const latest = useRef({read, pollStatus, verify}); latest.current = {read, pollStatus, verify};
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; sequence.current++; infoSequence.current++; statusSequence.current++;};}, []);
  useEffect(() => {sequence.current++; infoSequence.current++; statusSequence.current++; observedLoginId.current = undefined; observedToolInstallId.current = undefined; setCheck(undefined); setInstall(null); setToolInstall(null); setLogin(null); setEntry(undefined); setTools([]); setIssue(''); setPendingToolInstall(false); if (ready) {void latest.current.read(); void latest.current.verify();}}, [ready, provider]);
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    if (ready) void latest.current.verify();
  }, [signature, ready]);
  useEffect(() => {
    if (provider === 'codex' && codexJob?.phase === 'succeeded' && ready) void latest.current.verify();
  }, [provider, ready, codexJob?.id, codexJob?.phase]);

  async function request(next: EnvironmentRequest) {
    const requestedProvider = provider;
    pendingRequests.current++; setWorking(true); setIssue('');
    try {const reply = await client.environment(next); if (mounted.current && providerNow.current === requestedProvider) {
      if (reply.kind === 'backendInstallStatus' || reply.kind === 'toolInstall' || reply.kind === 'operation') statusSequence.current++;
      accept(reply);
    } return reply;}
    catch (error) {if (mounted.current && providerNow.current === requestedProvider) setIssue(errorText(error)); return undefined;}
    finally {pendingRequests.current--; if (mounted.current) setWorking(pendingRequests.current > 0);}
  }
  async function installTool(toolName: 'codex' | 'claude', update = false) {
    setPendingToolInstall(true);
    try { return await request({type: update ? 'update' : 'install', tool: toolName}); }
    finally {if (mounted.current && providerNow.current === provider) setPendingToolInstall(false);}
  }
  async function installProvider(update = false) {
    if (!tool || tool.installation === 'unknown') {await verify(); return;}
    sequence.current++; setCheck(undefined);
    const reply = await (provider === 'codex' ? installTool('codex', update) : request({type: 'backendInstall', id: backend, update}));
    if (!mounted.current || providerNow.current !== provider) return;
    if (reply?.kind === 'backendInstall' || reply?.kind === 'applied') {
      void read();
      // If polling saw the operation, its terminal transition verifies once. A fast install
      // can finish before the first poll, so check it here instead.
      if (provider === 'codex' && !observedToolInstallId.current) void verify();
    }
  }
  const activeInstall = provider === 'claude' && install?.state === 'running' ? install : undefined;
  const relevantToolInstall = toolInstall?.kind === 'running' && toolInstall.tool === provider ? toolInstall : undefined;
  const activeLogin = login?.kind === 'running' && login.purpose.kind === 'login' && login.purpose.tool === provider ? login : undefined;
  const polling = Boolean(activeInstall || pendingToolInstall || relevantToolInstall || activeLogin);
  useEffect(() => {
    if (!ready || !polling) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await latest.current.pollStatus();
      if (live) timer = setTimeout(() => void poll(), 1200);
    }
    timer = setTimeout(() => void poll(), 1200);
    return () => {live = false; clearTimeout(timer);};
  }, [ready, polling]);
  const terminal = `${provider === 'claude' ? `${install?.operationId}:${install?.state}` : ''}|${toolInstall && toolInstall.id === observedToolInstallId.current ? `${toolInstall.id}:${toolInstall.kind}` : ''}|${login && login.id === observedLoginId.current ? `${login.id}:${login.kind}` : ''}`;
  const priorTerminal = useRef(terminal);
  useEffect(() => {
    if (priorTerminal.current === terminal) return;
    priorTerminal.current = terminal;
    if (provider === 'claude' && install && install.state !== 'running' || toolInstall && toolInstall.id === observedToolInstallId.current && toolInstall.kind !== 'running' || login && login.id === observedLoginId.current && login.kind !== 'running') {
      void latest.current.read();
      void latest.current.verify();
    }
  }, [terminal]);
  const installError = install?.replay.filter(item => item.type === 'error').at(-1);
  const operationMessage = provider === 'claude' && install?.state === 'failed' ? installError?.message ?? '安装未完成，请重试。'
    : toolInstall?.id === observedToolInstallId.current && toolInstall?.kind === 'failed' ? toolInstall.message
    : login?.id === observedLoginId.current && (login?.kind === 'failed' || login?.kind === 'timedOut') ? login.message : undefined;
  const canContinue = ready && !working && !activeInstall && !relevantToolInstall && !activeLogin && !activeCodexJob && providerInstalled(tool) && providerAuthenticated(tool) && check?.state === 'ready' && check.provider === provider && Boolean(check.models?.length) && check.signature === signature;
  return {tool, tools, entry, check, issue: issue || operationMessage || (tool?.installation === 'unknown' || providerInstalled(tool) && tool?.authentication === 'unknown' ? tool?.message : undefined), working, activeInstall, relevantToolInstall, activeLogin, activeCodexJob, canContinue, verify, read, installProvider,
    cancelInstall: () => activeInstall ? request({type: 'cancelBackendInstall', operationId: activeInstall.operationId}) : relevantToolInstall ? request({type: 'cancelInstall', operationId: relevantToolInstall.id}) : undefined,
    cancelLogin: () => activeLogin ? request({type: 'cancelLogin', operationId: activeLogin.id}) : undefined,
    installTool, request};
}
