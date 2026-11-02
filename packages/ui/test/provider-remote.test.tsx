import {beforeEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DesktopSnapshot, EnvironmentToolState, ToolState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider, type ActiveDevice} from '../src/client-context';
import {ProviderPreparation} from '../src/setup/ProviderSetup';

// Codex review 246-2: the Provider details of a remote device said 本机配置, 本机 Claude Code 无法启动, 请先在终端运行 claude.
// The page renders through React; only the RPC hook is fixed, to a Claude Code that does not start and a Codex from Homebrew.
const h = vi.hoisted(() => ({tools: [] as EnvironmentToolState[], issue: ''}));
vi.mock('../src/setup/useProviderSetup', () => ({useProviderSetup: (provider: 'codex' | 'claude', snapshot: DesktopSnapshot) => ({
  tool: snapshot.tools.find(item => item.tool === provider), tools: h.tools, check: undefined, issue: h.issue, working: false,
  entry: {id: provider === 'claude' ? 'claude-agent' : 'codex-appserver', depState: 'installed', canUninstall: true},
  activeInstall: undefined, relevantToolInstall: undefined, activeLogin: undefined, canContinue: false,
  installProvider: vi.fn(), installTool: vi.fn(), verify: vi.fn(), read: vi.fn(), cancelInstall: vi.fn(), request: vi.fn(),
})}));

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const remote: ActiveDevice = {id: 'test-remote', name: 'Linux 服务器', isRemote: true, platform: 'linux', version: '0.9.0', mode: 'full', capabilities: ['device']};
const tool = (name: 'codex' | 'claude', authentication: ToolState['authentication']): ToolState => ({tool: name, installation: 'installed', authentication, version: '1.0.0'});
const external = (name: 'codex' | 'claude', fields: Partial<EnvironmentToolState>): EnvironmentToolState =>
  ({tool: name, installation: 'external', executable: `/usr/local/bin/${name}`, version: '1.0.0', managedVersion: null, latestVersion: null, updateAvailable: null, canUninstall: false, ...fields});
const snapshot = (tools: ToolState[]): DesktopSnapshot => ({revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'attached', version: '0.9.0'},
  tools, agents: [], groups: [], memberships: [], jobs: [], application: {platform: 'linux', version: '0.9.0', loginItem: false, dataPath: '/srv/vonvon'}});
const page = (provider: 'codex' | 'claude', tools: ToolState[], device?: ActiveDevice) => renderToStaticMarkup(<ClientProvider client={client} device={device}>
  <ProviderPreparation provider={provider} snapshot={snapshot(tools)} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} management/>
</ClientProvider>);
beforeEach(() => { h.tools = []; h.issue = ''; });

it('says a remote Claude Code that does not start is the device\'s, and so is its fix', () => {
  h.tools = [external('claude', {runtimeStatus: 'failed'})];
  const html = page('claude', [tool('claude', 'signedIn')], remote);
  expect(html).toContain('<strong>「Linux 服务器」上的配置</strong>');
  expect(html).toContain('已读取「Linux 服务器」上的配置');
  expect(html).toContain('「Linux 服务器」上的 Claude Code 无法启动。请先在「Linux 服务器」的终端运行 <code>claude</code>，修复问题并确认可以使用，再回来重新检测。Vonvon 会复用「Linux 服务器」上 Claude 的认证或 API 配置。');
  expect(html).toContain('Vonvon 用「Linux 服务器」上已有的配置。');
  expect(html).toContain('「Linux 服务器」上已有');
  expect(html).not.toContain('本机');
});

it('names the device in the daemon\'s own words of a remote Provider: its sign-in hint and a Homebrew update', () => {
  h.tools = [external('claude', {runtimeStatus: 'ready'})];
  h.issue = '没配置好。在终端运行 `claude` 配置账号，或设置 ANTHROPIC_API_KEY 用自定义 API。';
  const claude = page('claude', [tool('claude', 'signedOut')], remote);
  expect(claude).toContain('未检测到可用配置');
  expect(claude).toContain('没配置好。在「Linux 服务器」的终端运行 `claude` 配置账号，或设置 ANTHROPIC_API_KEY 用自定义 API。');
  expect(claude).not.toContain('本机');
  h.issue = '';
  h.tools = [external('codex', {source: 'homebrew', updateInstructions: '请在终端运行 brew upgrade codex，完成后点击「刷新模型」。'})];
  const codex = page('codex', [tool('codex', 'signedIn')], remote);
  expect(codex).toContain('请在「Linux 服务器」的终端运行 brew upgrade codex，完成后点击「刷新模型」。');
  expect(codex).toContain('<strong>「Linux 服务器」上的配置</strong>');
  expect(codex).not.toContain('本机');
});

it('leaves this computer\'s Provider details as they were', () => {
  h.tools = [external('claude', {runtimeStatus: 'failed'})];
  const html = page('claude', [tool('claude', 'signedIn')]);
  expect(html).toContain('<strong>本机配置</strong>');
  expect(html).toContain('已读取本机配置');
  expect(html).toContain('本机 Claude Code 无法启动。请先在终端运行 <code>claude</code>，修复问题并确认可以使用，再回来重新检测。Vonvon 会复用本机 Claude 的认证或 API 配置。');
  expect(html).toContain('本机已有');
  expect(html).not.toContain('Linux 服务器');
});

// 0.9.0 Linux acceptance (task 287): a managed Codex or Claude Code is on no PATH; the page named a bare codex or claude
it('names what starts a managed copy in the device\'s terminal, and keeps the name for one found on PATH', () => {
  const codex = '/srv/vonvon/node/bin/node /srv/vonvon-data/managed-tools/codex/releases/g/bin/codex';
  h.tools = [external('codex', {installation: 'managed', source: 'managed', canUninstall: true, command: codex})];
  const managed = page('codex', [tool('codex', 'signedOut')], remote);
  expect(managed).toContain(`可以用 Codex App 或 <code>${codex}</code> 命令行配置。`);
  const claude = '/srv/vonvon-data/managed-tools/claude/releases/g/bin/claude';
  h.tools = [external('claude', {installation: 'managed', runtimeStatus: 'failed', canUninstall: true, command: claude})];
  const failed = page('claude', [tool('claude', 'signedOut')], remote);
  expect(failed).toContain(`可以用 Claude Code（<code>${claude}</code>）配置。`);
  expect(failed).toContain(`请先在「Linux 服务器」的终端运行 <code>${claude}</code>，修复问题并确认可以使用`);
  h.tools = [external('codex', {})];
  expect(page('codex', [tool('codex', 'signedOut')], remote)).toContain('可以用 Codex App 或 <code>codex</code> 命令行配置。');
});
