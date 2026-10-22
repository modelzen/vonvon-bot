import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {McpReply} from '@vonvon/protocol';
import {McpAuthorizationDialog, McpEntries, mcpLoginCommand, mcpSummary} from '../src/management/McpPanel';
const view: McpReply = {type: 'mcp', provider: 'codex', status: 'ready', cliAvailable: true, revision: 'r1', configPath: '/home/user/.codex/config.toml', entries: [
  {name: 'docs', transport: 'http', source: 'user', urlOrigin: 'https://docs.example', envNames: ['DOCS_TOKEN'], headerNames: ['Authorization'], enabled: true, authorization: 'not-checked', loginArgv: ['/path with space/codex', 'mcp', 'login', 'docs']},
]};
it('summarizes only safe connection metadata, without asserting authorization', () => {
  const entry = {...view.entries[0]!, url: 'https://docs.example/private?token=do-not-display', env: {DOCS_TOKEN: 'do-not-display'}, args: ['do-not-display']};
  const html = renderToStaticMarkup(<McpEntries view={{...view, entries: [entry]}} disabled={false} onAuthorize={() => {}} onRemove={() => {}}/>);
  expect(html).toContain('https://docs.example');
  expect(html).toContain('DOCS_TOKEN'); expect(html).toContain('Authorization');
  expect(html).not.toContain('do-not-display'); expect(html).not.toContain('已授权');
  expect(html).not.toContain('role="switch"'); expect(html).toContain('Codex 用户配置');
  expect(mcpSummary({...entry, urlOrigin: 'https://user:secret@docs.example/path?token=secret'})).toBe('https://docs.example');
});
it('quotes shell arguments as data and refuses multi-line clipboard commands', () => {
  expect(mcpLoginCommand(['/path with space/codex', 'mcp', 'login', "name'with$(echo nope)"])).toBe("'/path with space/codex' 'mcp' 'login' 'name'\\''with$(echo nope)'");
  expect(mcpLoginCommand(['codex', 'mcp\nlogin'])).toBeUndefined();
  expect(mcpLoginCommand([])).toBeUndefined();
});
it('keeps OAuth an explicit terminal instruction and never presents success', () => {
  const html = renderToStaticMarkup(<McpAuthorizationDialog provider="codex" entry={view.entries[0]} onClose={() => {}}/>);
  expect(html).toContain('在本机终端运行命令'); expect(html).toContain('不检测授权结果'); expect(html).toContain('复制命令');
  expect(html).not.toContain('已授权'); expect(html).not.toContain('授权成功');
});
it('does not describe an unreadable configuration as an empty configured list', () => {
  const html = renderToStaticMarkup(<McpEntries view={{...view, status: 'unavailable', entries: []}} disabled onAuthorize={() => {}} onRemove={() => {}}/>);
  expect(html).toContain('列表暂不可用'); expect(html).not.toContain('尚未添加');
});
