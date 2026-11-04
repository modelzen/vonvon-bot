import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {Agent, DesktopSnapshot, EnvironmentReply, EnvironmentToolState, ToolState} from '@vonvon/protocol';
import {ProviderManager, ProviderPreparation, ProviderSetup} from '../src/setup/ProviderSetup';
import {WelcomeSetup} from '../src/setup/WelcomeSetup';

type Provider = 'codex' | 'claude';
type Element = ReactElement<Record<string, any>>;
const harness = vi.hoisted(() => ({
  state: [] as unknown[], index: 0, effectIndex: 0,
  effects: [] as Array<{deps?: unknown[]}>, pending: [] as Array<() => void>,
  canContinue: false, check: undefined as {state: 'checking' | 'unavailable'; message?: string; stale?: boolean; models?: Array<{id: string; displayName: string}>} | undefined, issue: '', cli: undefined as EnvironmentToolState | undefined, codex: undefined as EnvironmentToolState | undefined,
  activeInstall: undefined as any,
  installProvider: vi.fn(), installTool: vi.fn(async () => ({kind: 'applied', message: '已更新'})), connect: vi.fn(), verify: vi.fn(), read: vi.fn(), cancelInstall: vi.fn(),
  request: vi.fn(async (request: {type: string; id?: string}): Promise<EnvironmentReply> => request.type === 'backendVersion'
    ? {kind: 'backendVersion', id: request.id!, installed: '1.0', latest: '1.1', hasUpdate: true} : {kind: 'applied', message: '已卸载'}),
  onContinue: vi.fn(), onCreateBot: vi.fn(), onRegister: vi.fn(),
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.index++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;}];
  },
  useEffect: (effect: () => void, deps?: unknown[]) => {
    const index = harness.effectIndex++;
    const prior = harness.effects[index]?.deps;
    if (prior && deps && deps.length === prior.length && deps.every((value, at) => Object.is(value, prior[at]))) return;
    harness.effects[index] = {deps};
    harness.pending.push(effect);
  },
}));
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(), useActiveDevice: () => ({id: 'local', isRemote: false, name: '这台电脑', mode: 'full', capabilities: []}), useShellCapabilities: () => undefined}));
vi.mock('../src/setup/useProviderSetup', () => ({useProviderSetup: (provider: Provider, snapshot: DesktopSnapshot) => ({
  tool: snapshot.tools.find(item => item.tool === provider), tools: provider === 'claude' ? [harness.cli ?? {tool: 'claude', installation: 'managed', version: '1.0', latestVersion: '1.1', executable: '/managed/claude', canUninstall: true}] : harness.codex ? [harness.codex] : [],
  entry: {id: provider === 'claude' ? 'claude-agent' : 'codex-appserver', installedVersion: '0.3.296', depState: snapshot.tools.find(item => item.tool === provider)?.installation === 'missing' ? 'missing' : 'installed', canUninstall: snapshot.tools.find(item => item.tool === provider)?.installation !== 'missing'},
  check: harness.canContinue ? {state: 'ready', models: [{id: 'model-1', displayName: 'Model 1'}]} : harness.check,
  issue: harness.issue, working: false, activeInstall: harness.activeInstall, relevantToolInstall: undefined,
  activeLogin: undefined, canContinue: harness.canContinue,
  installProvider: harness.installProvider, installTool: harness.installTool, connect: harness.connect, verify: harness.verify,
  read: harness.read, cancelInstall: harness.cancelInstall,
  request: harness.request,
})}));
vi.mock('../src/setup/BridgeImportPanel', () => ({BridgeImportPanel: () => <div data-testid="bridge-import">Bridge 导入</div>}));
vi.mock('../src/setup/SetupChecklist', () => ({SetupChecklist: ({botsOnly}: {botsOnly?: boolean}) => <div data-testid="feishu-checks">{botsOnly ? '飞书配置检查' : '设置检查'}</div>}));

function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.icon)];
}
const tool = (name: Provider, installation: ToolState['installation'], authentication: ToolState['authentication']): ToolState => ({tool: name, installation, authentication, version: installation === 'installed' ? '1.0' : null});
const bot: Agent = {id: 'cli_existing' as Agent['id'], name: '已有 Bot', enabled: true, running: true, connection: 'connected', activation: 'active'};
function snapshot(tools: ToolState[], agents: Agent[] = []): DesktopSnapshot {
  return {revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
    tools, agents, groups: [], memberships: [], jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'}};
}
const run = vi.fn(async () => ({kind: 'applied' as const, revision: 1}));
function resetRender() {harness.index = harness.effectIndex = 0;}
function renderManager(props: Parameters<typeof ProviderManager>[0]) {
  resetRender();
  const view = nodes(ProviderManager(props));
  for (const effect of harness.pending.splice(0)) effect();
  return view;
}
function button(all: Element[], label: string): Element {
  const found = all.find(node => (node.props.label === label || node.props['aria-label'] === label || [node.props.children].flat().join('') === label) && typeof node.props.onClick === 'function');
  if (!found) throw new Error(`button ${label} missing`);
  return found;
}
function installationInfo(all: Element[], label: string): ReactNode {
  const row = all.find(node => node.type === 'div' && Array.isArray(node.props.children)
    && node.props.children[0]?.type === 'dt' && node.props.children[0].props.children === label);
  return row?.props.children[1]?.props.children;
}
beforeEach(() => {
  harness.state = []; harness.effects = []; harness.pending = []; harness.index = harness.effectIndex = 0; harness.canContinue = false; harness.check = undefined; harness.issue = ''; harness.cli = undefined; harness.codex = undefined; harness.activeInstall = undefined;
  vi.clearAllMocks();
});

it.each([
  ['', '正在准备安装…'],
  ['\n正在下载并安装组件…\n', '正在下载并安装组件，可能需要几分钟…'],
  ['\n正在下载并安装组件…\n\n正在校验安装结果…\n', '正在校验安装结果…'],
])('shows the current SDK installation stage', (output, label) => {
  harness.activeInstall = {operationId: 'install', state: 'running', replay: output ? [{type: 'log', chunk: output}] : []};
  harness.issue = '旧的检测错误';
  const view = nodes(ProviderPreparation({provider: 'claude', snapshot: snapshot([tool('claude', 'installed', 'unknown')]), ready: true, busy: false, run, management: true}));
  expect(view.some(node => node.props.label === label)).toBe(true);
  expect(view.some(node => node.props.children === '旧的检测错误')).toBe(false);
  expect(button(view, '取消')).toBeTruthy();
});

it.each([
  ['missing', 'unknown'], ['installed', 'unknown'], ['installed', 'signedOut'],
] as const)('keeps scan unavailable while Provider is %s / %s', (installation, authentication) => {
  const data = snapshot([tool('codex', installation, authentication)]);
  const first = nodes(WelcomeSetup({snapshot: data, ready: true, busy: false, run, onRegister: harness.onRegister, onCreateBot: harness.onCreateBot, onOpenProviders: () => {}, onNotice: () => {}}));
  expect(first.some(node => node.type === ProviderSetup)).toBe(true);
  expect(first.some(node => node.props.children === '添加 Bot')).toBe(false);
  expect(first.some(node => node.props['data-testid'] === 'bridge-import')).toBe(false); // nested BridgeImportPanel remains reachable
  expect(first.some(node => typeof node.type === 'function' && node.type.name === 'BridgeImportPanel')).toBe(true);
  resetRender();
  const card = nodes(ProviderPreparation({provider: 'codex', snapshot: data, ready: true, busy: false, run, onContinue: harness.onContinue}));
  expect(button(card, '继续').props.disabled).toBe(true);
  button(card, '继续').props.onClick();
  expect(harness.onContinue).not.toHaveBeenCalled();
  expect(harness.onCreateBot).not.toHaveBeenCalled();
});

it('changes Provider explicitly, then Continue opens Bot creation with the same Provider', () => {
  const data = snapshot([tool('codex', 'installed', 'signedIn'), tool('claude', 'installed', 'signedIn')]);
  resetRender();
  let welcome = nodes(WelcomeSetup({snapshot: data, ready: true, busy: false, run, onRegister: harness.onRegister, onCreateBot: harness.onCreateBot, onOpenProviders: () => {}, onNotice: () => {}}));
  const setup = welcome.find(node => node.type === ProviderSetup)!;
  expect(setup).toBeTruthy();
  resetRender();
  let choices = nodes(ProviderSetup(setup.props as any));
  const claude = choices.find(node => node.props['aria-pressed'] === false && node.props.children?.[1]?.props?.children === 'Claude');
  expect(claude).toBeTruthy();
  claude!.props.onClick();
  resetRender();
  choices = nodes(ProviderSetup(setup.props as any));
  expect(choices.find(node => node.type === ProviderPreparation)?.props.provider).toBe('claude');
  harness.canContinue = true;
  resetRender();
  const card = nodes(ProviderPreparation({...setup.props, provider: 'claude'} as any));
  button(card, '继续').props.onClick();
  resetRender();
  welcome = nodes(WelcomeSetup({snapshot: data, ready: true, busy: false, run, onRegister: harness.onRegister, onCreateBot: harness.onCreateBot, onOpenProviders: () => {}, onNotice: () => {}}));
  expect(welcome.some(node => node.props.children === '添加 Bot')).toBe(true);
  button(welcome, '添加 Bot').props.onClick();
  expect(harness.onCreateBot).toHaveBeenCalledWith('claude');
  expect(harness.onRegister).not.toHaveBeenCalled();
});

it('keeps existing Bot Feishu checks and group action after Provider is ready', () => {
  const data = snapshot([tool('codex', 'installed', 'signedIn')], [bot]);
  resetRender();
  const welcome = nodes(WelcomeSetup({snapshot: data, ready: true, busy: false, run, onRegister: harness.onRegister, onOpenGroups: () => {}, onOpenProviders: () => {}, onNotice: () => {}}));
  expect(welcome.some(node => node.props.children === '选择群聊')).toBe(true);
  expect(welcome.some(node => node.type.name === 'SetupChecklist' && node.props.botsOnly)).toBe(true);
  expect(welcome.some(node => node.type.name === 'BridgeImportPanel')).toBe(true);
});

it('keeps Provider management entry, version, update and owned uninstall actions available', async () => {
  const data = snapshot([tool('codex', 'installed', 'signedIn'), tool('claude', 'installed', 'signedIn')]);
  const manager = renderManager({snapshot: data, ready: true, busy: false, run});
  expect(manager.filter(node => node.props.className === 'provider-list-row')).toHaveLength(2);
  resetRender();
  const detail = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true}));
  const restartNotice = '更新或重装 SDK 后，请到「应用与启动」重启后台服务，以加载新版本。';
  expect(detail.some(node => node.props.children === restartNotice)).toBe(true);
  button(detail, '更新 SDK').props.onClick();
  expect(harness.installProvider).toHaveBeenCalledWith(true);
  resetRender();
  const updated = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true}));
  expect(updated.some(node => node.props.children === restartNotice)).toBe(true);
  button(detail, '检查版本').props.onClick();
  expect(harness.request).toHaveBeenCalledWith({type: 'backendVersion', id: 'claude-agent'});
  button(detail, '卸载 SDK').props.onClick();
  resetRender();
  const confirm = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true})).find(node => node.props.title === '卸载 Claude Agent SDK');
  expect(confirm?.props.open).toBe(true);
  confirm!.props.onConfirm();
  await Promise.resolve();
  expect(harness.request).toHaveBeenCalledWith({type: 'backendUninstall', id: 'claude-agent'});
  expect(detail.some(node => node.props.children === '模型来源')).toBe(true);
});

it('shows the current selected Codex and latest official version separately', () => {
  harness.codex = {tool: 'codex', installation: 'managed', version: '0.164.0', latestVersion: '0.165.0', executable: '/managed/codex', canUninstall: true};
  const data = snapshot([{...tool('codex', 'installed', 'signedIn'), version: 'codex-cli 0.164.0'}]);
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: data, ready: true, busy: false, run, management: true}));
  expect(installationInfo(detail, '当前版本')).toBe('0.164.0');
  expect(installationInfo(detail, '最新版本')).toBe('0.165.0');
});

it('shows managed Codex source and path, with an update action and an independent model refresh', () => {
  harness.codex = {tool: 'codex', installation: 'managed', version: '0.164.0', latestVersion: '0.165.0', updateAvailable: true, executable: '/managed/codex', canUninstall: true};
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: snapshot([tool('codex', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true}));
  expect(installationInfo(detail, '安装来源')).toBe('Vonvon 管理');
  expect(nodes(installationInfo(detail, '安装位置')).some(node => node.type === 'code' && node.props.children === '/managed/codex')).toBe(true);
  expect(installationInfo(detail, '最新版本')).toBe('0.165.0');
  button(detail, '更新 Codex').props.onClick();
  expect(harness.installProvider).toHaveBeenCalledWith(true);
  button(detail, '刷新模型').props.onClick();
  expect(harness.verify).toHaveBeenCalledOnce();
});

it('shows external Codex update instructions without offering a managed install', () => {
  harness.codex = {tool: 'codex', installation: 'external', source: 'homebrew', updateInstructions: '运行 brew upgrade codex', version: '0.164.0', latestVersion: '0.165.0', executable: '/opt/homebrew/bin/codex', canUninstall: false} as EnvironmentToolState;
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: snapshot([tool('codex', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true}));
  expect(installationInfo(detail, '安装来源')).toBe('Homebrew');
  expect(detail.some(node => node.props.children === '运行 brew upgrade codex')).toBe(true);
  expect(() => button(detail, '更新 Codex')).toThrow();
  button(detail, '刷新模型').props.onClick();
  expect(harness.verify).toHaveBeenCalledOnce();
});

it('retains the last Codex model list and marks it stale after refresh fails', () => {
  harness.check = {state: 'unavailable', stale: true, message: '读取失败', models: [{id: 'old', displayName: 'Old model'}]};
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: snapshot([tool('codex', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.props.children === 'Old model')).toBe(true);
  expect(detail.some(node => node.props.children === '模型列表是上次读取的结果；本次刷新失败，请稍后重试。')).toBe(true);
  button(detail, '刷新模型').props.onClick();
  expect(harness.verify).toHaveBeenCalledOnce();
});

it('retains previous models while rechecking without announcing a refresh failure', () => {
  harness.check = {state: 'checking', stale: true, models: [{id: 'old', displayName: 'Old model'}]};
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: snapshot([tool('codex', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.props.children === 'Old model')).toBe(true);
  expect(detail.some(node => node.props.children === '正在检查…')).toBe(true);
  expect(detail.some(node => node.props.children === '模型列表是上次读取的结果；本次刷新失败，请稍后重试。')).toBe(false);
  expect(button(detail, '刷新模型').props.disabled).toBe(true);
});

it('refreshes Codex path and versions from the same scan despite a stale snapshot', async () => {
  harness.codex = {tool: 'codex', installation: 'managed', version: '0.162.1', latestVersion: '0.163.0', executable: '/managed/codex', canUninstall: true};
  const props = {provider: 'codex' as const, snapshot: snapshot([{...tool('codex', 'installed', 'signedIn'), version: 'codex-cli 0.162.1'}]), ready: true, busy: false, run, management: true};
  const upgraded = {...harness.codex, version: '0.164.0', latestVersion: '0.165.0', executable: '/managed/new/codex'};
  harness.request.mockImplementationOnce(async () => {harness.codex = upgraded; return {kind: 'tools', tools: [upgraded]};});
  let detail = nodes(ProviderPreparation(props));
  await button(detail, '检查版本').props.onClick();
  expect(harness.request).toHaveBeenCalledWith({type: 'scan'});
  resetRender(); detail = nodes(ProviderPreparation(props));
  expect(installationInfo(detail, '当前版本')).toBe('0.164.0');
  expect(installationInfo(detail, '最新版本')).toBe('0.165.0');
  expect(nodes(installationInfo(detail, '安装位置')).some(node => node.type === 'code' && node.props.children === '/managed/new/codex')).toBe(true);
  expect(detail.some(node => node.props.children === '已安装 · 0.164.0')).toBe(true);
  expect(detail.some(node => node.props.children === '已安装 · 0.162.1')).toBe(false);
});

it('shows unknown Codex versions when a refreshed source cannot report them', async () => {
  harness.codex = {tool: 'codex', installation: 'managed', version: '0.162.1', latestVersion: '0.163.0', executable: '/managed/codex', canUninstall: true};
  const props = {provider: 'codex' as const, snapshot: snapshot([tool('codex', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true};
  const upgraded = {...harness.codex, version: '0.164.0', latestVersion: '0.164.0'};
  harness.request.mockImplementationOnce(async () => {harness.codex = upgraded; return {kind: 'tools', tools: [upgraded]};});
  await button(nodes(ProviderPreparation(props)), '检查版本').props.onClick();
  resetRender();
  const unknown = {...upgraded, version: null, latestVersion: null};
  harness.request.mockImplementationOnce(async () => {harness.codex = unknown; return {kind: 'tools', tools: [unknown]};});
  await button(nodes(ProviderPreparation(props)), '检查版本').props.onClick();
  resetRender(); const detail = nodes(ProviderPreparation(props));
  expect(installationInfo(detail, '当前版本')).toBe('暂时无法确认');
  expect(installationInfo(detail, '最新版本')).toBe('暂时无法查询');
  expect(detail.some(node => node.props.children === '已安装 · 0.164.0')).toBe(false);
});

it('shows the selected Codex source when the installation changes', async () => {
  const props = {provider: 'codex' as const, snapshot: snapshot([{...tool('codex', 'installed', 'signedIn'), version: 'codex-cli 0.164.0'}]), ready: true, busy: false, run, management: true};
  harness.codex = {tool: 'codex', installation: 'managed', version: '0.164.0', latestVersion: '0.165.0', executable: '/managed/codex', canUninstall: true};
  harness.request.mockResolvedValueOnce({kind: 'tools', tools: [harness.codex]});
  await button(nodes(ProviderPreparation(props)), '检查版本').props.onClick();
  harness.codex = {tool: 'codex', installation: 'external', version: '0.166.0', latestVersion: '0.166.0', executable: '/external/codex', canUninstall: false};
  resetRender();
  const detail = nodes(ProviderPreparation({...props, snapshot: snapshot([{...tool('codex', 'installed', 'signedIn'), version: 'codex-cli 0.166.0'}])}));
  expect(installationInfo(detail, '当前版本')).toBe('0.166.0');
  expect(installationInfo(detail, '最新版本')).toBe('0.166.0');
});

it('keeps Claude SDK version checks labelled as the verified version', async () => {
  const props = {provider: 'claude' as const, snapshot: snapshot([tool('claude', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true};
  await button(nodes(ProviderPreparation(props)), '检查版本').props.onClick();
  resetRender(); const detail = nodes(ProviderPreparation(props));
  expect(detail.some(node => node.props.children === '验证版本：1.1')).toBe(true);
  expect(installationInfo(nodes(detail.find(node => node.props.className === 'provider-meta')?.props.children), '最新版本')).toBeUndefined();
});

it('uses current source metadata after switching installations A to B and back to A', async () => {
  const props = {provider: 'codex' as const, snapshot: snapshot([tool('codex', 'installed', 'signedIn')]), ready: true, busy: false, run, management: true};
  function render() {
    resetRender();
    const detail = nodes(ProviderPreparation(props));
    for (const effect of harness.pending.splice(0)) effect();
    return detail;
  }
  const original = {tool: 'codex' as const, installation: 'external' as const, version: '1.0', latestVersion: '1.2', executable: '/a/codex', canUninstall: false};
  harness.codex = original;
  const checked = {...original, version: '1.1', latestVersion: '1.1'};
  harness.request.mockImplementationOnce(async () => {harness.codex = checked; return {kind: 'tools', tools: [checked]};});
  await button(render(), '检查版本').props.onClick();
  expect(installationInfo(render(), '最新版本')).toBe('1.1');
  harness.codex = {...original, executable: '/b/codex'};
  render();
  harness.codex = original;
  expect(installationInfo(render(), '最新版本')).toBe('1.2');
});

it('switches a visible Codex detail to Claude when search reveals Claude in the same Provider page', () => {
  const data = snapshot([tool('codex', 'installed', 'signedIn'), tool('claude', 'installed', 'signedIn')]);
  const props = {snapshot: data, ready: true, busy: false, run};
  let view = renderManager({...props, reveal: 'codex'});
  expect(view.find(node => node.type === ProviderPreparation)?.props.provider).toBe('codex');
  view = renderManager({...props, reveal: 'claude'});
  // React applies the reveal effect after this render; the next render must use the new choice.
  view = renderManager({...props, reveal: 'claude'});
  expect(view.find(node => node.type === ProviderPreparation)?.props.provider).toBe('claude');
});

it('keeps Claude CLI management inside its details with update, auth check and owned uninstall', async () => {
  const data = snapshot([tool('claude', 'installed', 'signedIn')]);
  resetRender();
  let detail = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.type === 'summary' && [node.props.children].flat().join('') === 'Claude Code · 已安装')).toBe(true);
  button(detail, '更新 Claude Code').props.onClick();
  expect(harness.installTool).toHaveBeenCalledWith('claude', true);
  button(detail, '检查配置').props.onClick();
  expect(harness.request).toHaveBeenCalledWith({type: 'authStatus', tool: 'claude'});
  button(detail, '卸载 Claude Code 托管副本').props.onClick();
  resetRender();
  detail = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true}));
  const confirm = detail.find(node => node.props.title === '卸载 Claude Code 托管副本');
  expect(confirm?.props.open).toBe(true);
  confirm!.props.onConfirm();
  await Promise.resolve();
  expect(harness.request).toHaveBeenCalledWith({type: 'uninstall', tool: 'claude'});
});


it('keeps a detected Claude Code CLI separate from the missing Agent SDK', () => {
  const data = snapshot([tool('claude', 'missing', 'signedIn')]);
  const manager = renderManager({snapshot: data, ready: true, busy: false, run});
  expect(manager.some(node => node.props.children === '缺少运行组件')).toBe(true);
  resetRender();
  const detail = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true, onContinue: harness.onContinue}));
  expect(detail.some(node => node.type === 'strong' && [node.props.children].flat().join('') === 'Claude Agent SDK')).toBe(true);
  expect(detail.some(node => node.type === 'summary' && [node.props.children].flat().join('') === 'Claude Code · 已安装')).toBe(true);
  expect(detail.some(node => node.type === 'dd' && node.props.children === '/managed/claude')).toBe(true);
  expect(detail.some(node => node.type === 'dd' && node.props.children === '1.0')).toBe(true);
  expect(button(detail, '继续').props.disabled).toBe(true);
  expect(harness.installProvider).not.toHaveBeenCalled();
  expect(harness.installTool).not.toHaveBeenCalled();
  button(detail, '安装 SDK').props.onClick();
  expect(harness.installProvider).toHaveBeenCalledWith(false);
  expect(harness.installTool).not.toHaveBeenCalled();
  button(detail, '更新 Claude Code').props.onClick();
  expect(harness.installTool).toHaveBeenCalledWith('claude', true);
});


it('describes an undetected Claude Code CLI without conflating it with SDK readiness', () => {
  harness.cli = {tool: 'claude', installation: 'missing', version: null, executable: null, canUninstall: false};
  const data = snapshot([tool('claude', 'installed', 'signedIn')]);
  resetRender();
  const detail = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.type === 'summary' && [node.props.children].flat().join('') === 'Claude Code · 未检测到')).toBe(true);
  button(detail, '更新 SDK').props.onClick();
  expect(harness.installProvider).toHaveBeenCalledWith(true);
  button(detail, '安装 Claude Code').props.onClick();
  expect(harness.installTool).toHaveBeenCalledWith('claude', false);
});

it('prompts the user to verify Claude Code when the local executable fails', () => {
  harness.cli = {tool: 'claude', installation: 'external', version: null, executable: '/bin/claude', canUninstall: false, runtimeStatus: 'failed'};
  resetRender();
  const detail = nodes(ProviderPreparation({provider: 'claude', snapshot: snapshot([tool('claude', 'installed', 'unknown')]), ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.type === 'summary' && [node.props.children].flat().join('') === 'Claude Code · 无法启动')).toBe(true);
  expect(detail.some(node => node.props.role === 'status' && node.props.className === 'provider-problem')).toBe(true);
});

it('guides Codex login in its own command instead of starting authorization', () => {
  const props = {provider: 'codex' as const, snapshot: snapshot([tool('codex', 'installed', 'signedOut')]), ready: true, busy: false, run, management: true};
  resetRender();
  const guide = nodes(ProviderPreparation(props));
  button(guide, '检测配置').props.onClick();
  expect(harness.verify).toHaveBeenCalledOnce();
  expect(guide.some(node => node.type === 'code' && node.props.children === 'codex')).toBe(true);
  expect(harness.connect).not.toHaveBeenCalled();
});

it.each(['codex', 'claude'] as const)('uses the shared model card and external setup guidance for %s', provider => {
  harness.canContinue = true;
  const data = snapshot([tool(provider, 'installed', 'signedIn')]);
  const manager = renderManager({snapshot: data, ready: true, busy: false, run, reveal: provider});
  expect(manager.some(node => node.props.className === 'provider-setup provider-detail--compact')).toBe(true);
  resetRender();
  const view = nodes(ProviderPreparation({provider, snapshot: data, ready: true, busy: false, run, management: true}));
  expect(view.some(node => node.type === 'details' && node.props.className === 'provider-models')).toBe(true);
  expect(view.some(node => node.props.className === 'provider-models__list')).toBe(true);
  expect(view.some(node => node.props.className === 'provider-config-guide')).toBe(true);
  expect(view.some(node => node.props.className === 'provider-authorization')).toBe(false);
});

it('keeps managed Claude SDK maintenance separate from account connection and CLI management', () => {
  const data = snapshot([tool('claude', 'installed', 'signedOut')]);
  resetRender();
  const detail = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true, onContinue: harness.onContinue}));
  expect(detail.filter(node => node.props.className === 'provider-step')).toHaveLength(2);
  expect(detail.some(node => node.type === 'strong' && node.props.children === '本机配置')).toBe(true);
  expect(detail.some(node => node.type === 'dd' && node.props.children === 'Vonvon 管理')).toBe(true);
  expect(button(detail, '更新 SDK').props.disabled).toBe(false);
  expect(button(detail, '卸载 SDK').props.disabled).toBe(false);
  expect(button(detail, '检查版本').props.disabled).toBe(false);
  button(detail, '检测配置').props.onClick();
  resetRender();
  const guide = nodes(ProviderPreparation({provider: 'claude', snapshot: data, ready: true, busy: false, run, management: true}));
  expect(guide.some(node => node.type === 'code' && node.props.children === 'claude')).toBe(true);
  expect(harness.connect).not.toHaveBeenCalled();
  button(detail, '更新 Claude Code').props.onClick();
  expect(harness.installTool).toHaveBeenCalledWith('claude', true);
  expect(button(detail, '继续').props.disabled).toBe(true);
  expect(harness.installProvider).not.toHaveBeenCalled();
});


it.each(['codex', 'claude'] as const)('offers detection, never installation, for an unknown %s state', provider => {
  harness.check = {state: 'unavailable', message: '检测失败：进程暂时不可用'};
  const data = snapshot([tool(provider, 'unknown', 'unknown')]);
  const detail = nodes(ProviderPreparation({provider, snapshot: data, ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.props.children === '检测异常')).toBe(true);
  expect(detail.some(node => node.props.children === '等待检测结果')).toBe(true);
  expect(detail.some(node => node.props.children === harness.check?.message)).toBe(true);
  expect(detail.some(node => node.type === 'dd' && node.props.children === '暂时无法确认')).toBe(true);
  expect(detail.some(node => ['安装', '安装 SDK', '安装后连接', '更新后连接'].includes(node.props.children))).toBe(false);
  const retry = button(detail, '重新检测');
  expect(retry.props.disabled).toBe(false);
  retry.props.onClick();
  expect(harness.verify).toHaveBeenCalledOnce();
  expect(harness.installProvider).not.toHaveBeenCalled();
  expect(harness.installTool).not.toHaveBeenCalled();
});

it('waits for a missing snapshot entry without exposing an install or connection action', () => {
  harness.check = {state: 'checking'};
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: snapshot([]), ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.props.children === '正在检测…')).toBe(true);
  expect(button(detail, '重新检测').props.disabled).toBe(true);
  expect(detail.some(node => ['安装', '连接', '安装后连接'].includes(node.props.children))).toBe(false);
});

it.each(['codex', 'claude'] as const)('keeps the install action for confirmed missing %s', provider => {
  const detail = nodes(ProviderPreparation({provider, snapshot: snapshot([tool(provider, 'missing', 'unknown')]), ready: true, busy: false, run}));
  expect(detail.some(node => node.props.children === '未安装')).toBe(true);
  button(detail, provider === 'claude' ? '安装 SDK' : '安装').props.onClick();
  expect(harness.installProvider).toHaveBeenCalledWith(false);
  expect(harness.verify).not.toHaveBeenCalled();
});

it('keeps the update action for an installed but unsupported Codex version', () => {
  harness.codex = {tool: 'codex', installation: 'managed', version: '0.1', latestVersion: '0.2', executable: '/managed/codex', canUninstall: true};
  const outdated = {...tool('codex', 'installed', 'unknown'), compatibility: {status: 'tooOld'}} as ToolState;
  const detail = nodes(ProviderPreparation({provider: 'codex', snapshot: snapshot([outdated]), ready: true, busy: false, run, management: true}));
  expect(detail.some(node => node.props.children === '需要更新')).toBe(true);
  expect(detail.some(node => node.props.children === '安装后检测')).toBe(true);
  button(detail, '更新').props.onClick();
  expect(harness.installProvider).toHaveBeenCalledWith(true);
});

it.each(['homebrew', 'explicit'] as const)('does not install a managed Codex over outdated external %s', source => {
  harness.codex = {tool: 'codex', installation: source === 'explicit' ? 'managed' : 'external', source, version: '0.1', latestVersion: '0.2', executable: source === 'explicit' ? '/chosen/codex' : '/opt/homebrew/bin/codex', canUninstall: source === 'explicit', updateInstructions: '请按原安装方式更新'};
  const outdated = {...tool('codex', 'installed', 'unknown'), compatibility: {status: 'tooOld'}} as ToolState;
  const props = {provider: 'codex' as const, snapshot: snapshot([outdated]), ready: true, busy: false, run};
  const setup = nodes(ProviderPreparation(props));
  expect(() => button(setup, '更新')).toThrow();
  expect(setup.some(node => node.props.children === '请按原安装方式更新')).toBe(true);
  button(setup, '重新检测').props.onClick();
  expect(harness.verify).toHaveBeenCalledOnce();
  resetRender();
  const manager = nodes(ProviderPreparation({...props, management: true}));
  if (source === 'explicit') expect(installationInfo(manager, '安装来源')).toBe('显式指定');
  expect(() => button(manager, '更新 Codex')).toThrow();
  expect(() => button(manager, '更新')).toThrow();
  if (source === 'explicit') expect(() => button(manager, '卸载托管副本')).toThrow();
  expect(manager.some(node => node.props.children === '请按原安装方式更新')).toBe(true);
  expect(harness.installProvider).not.toHaveBeenCalled();
});
