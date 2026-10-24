import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {desktopSnapshotSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DirectoryPickerProvider} from '../src/directory-picker';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {MindMap, type MapNode} from '../src/MindMap';
import {BotMap} from '../src/BotMap';
import {ProjectPage} from '../src/ProjectPage';

const tree: MapNode = {id: 'root', kind: 'root', label: '支付组', children: [
  {id: 'b1', kind: 'branch', label: '决定', meta: '2', open: true, onToggle: vi.fn(), children: [
    {id: 'l1', kind: 'leaf', label: '发版改到周四', onClick: vi.fn(), drag: 'l1', tone: 'pending', meta: '待确认', menu: [{id: 'd', label: '删除', onSelect: vi.fn(), danger: true}]},
    {id: 'l2', kind: 'leaf', label: '第二条', selected: true, onClick: vi.fn()},
  ]},
  {id: 'b2', kind: 'branch', label: '约定', open: false, onToggle: vi.fn(), children: [{id: 'l3', kind: 'leaf', label: '不应出现'}]},
  {id: 'b3', kind: 'branch', label: '发版', drop: {accepts: () => true, onDrop: vi.fn()}},
]};

it('retains semantic node content before the library mounts, and hides folded descendants', () => {
  const html = renderToStaticMarkup(<MindMap root={tree} label="导图"/>);
  expect(html).toContain('role="tree"');
  expect(html).toContain('class="mm-static"');
  expect(html).not.toContain('class="mm-links"');
  expect(html).toContain('发版改到周四');
  expect(html).not.toContain('不应出现');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('data-tone="pending"');
  expect(html).toContain('draggable="true"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('更多操作');
  expect(html).toContain('data-danger="true"');
});

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const row = (agentId: string, groupId: string) => ({id: JSON.stringify([agentId, groupId]), agentId, groupId, projectId: 'prj_00000001', name: groupId, directory: '/w', backend: 'codex-appserver', conversation: 'smart', response: 'mention', effectMode: 'qa', permission: {administrator: 'qa', member: 'qa', network: false}, stale: false});
const snapshot: DesktopSnapshot = desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
  agents: [{id: 'cli_a', name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active'}, {id: 'cli_b', name: '小发', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: 'oc_pay', name: '支付组群'}], projects: [{id: 'prj_00000001', name: '支付组', revision: 1, directory: '/w', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}]}],
  memberships: [row('cli_a', 'oc_pay')], tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/t'},
});
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<ClientProvider client={client}><DraftGuardProvider><DirectoryPickerProvider>{node}</DirectoryPickerProvider></DraftGuardProvider></ClientProvider>);

it('the Bot page is a map centred on the Bot: 角色设定 with its two leaves, Bot 记忆, and the projects it works in', () => {
  const html = wrap(<BotMap agentId={'cli_a' as never} snapshot={snapshot} onProject={vi.fn()}/>);
  for (const text of ['小支', '角色设定', '身份与职责', '其他说明', 'Bot 记忆', '项目', '支付组 →']) expect(html).toContain(text);
  expect(html).not.toContain('群友说的、Bot 自己观察到的永远进不了这里');
  expect(html).toContain('添加记忆');
  expect(html).not.toMatch(/AGENTS\.md|CLAUDE\.md/);
  expect(html).not.toContain('模型看到什么');
});

it('the project page map has 群和 Bot as a branch with the bindings and the 把一个群加进来 leaf, and folds nothing it does not own', () => {
  const html = wrap(<ProjectPage project={snapshot.projects![0]!} snapshot={snapshot} pane={{kind: 'map'}} onPane={vi.fn()} onMembership={vi.fn()} onChanged={async () => {}} onDeleted={vi.fn()} onAddGroup={vi.fn()}/>);
  expect(html).toContain('群和 Bot');
  expect(html).toContain('支付组群 · 小支');
  expect(html).toContain('+ 把一个群加进来…');
  expect(html).not.toContain('mm-menu');
  expect(html).not.toContain('memory-panel');
  expect(html).not.toContain('共用这个项目的群里，Bot 都会读到这些记忆');
});


it('shows only add on a selected expanded parent, and a persistent count when collapsed', () => {
  const child: MapNode = {id: 'child', kind: 'leaf', label: '内容'};
  const make = (open: boolean) => renderToStaticMarkup(<MindMap label="交互" root={{id: 'root', label: '分类', kind: 'branch', selected: true, open, onToggle: vi.fn(), onAdd: vi.fn(), childCount: 7, children: [child]}}/>);
  expect(make(true)).toContain('class="mm-add"');
  expect(make(true)).toContain('lucide-plus');
  expect(make(true)).not.toContain('>+</button>');
  expect(make(true)).not.toContain('class="mm-fold"');
  expect(make(false)).not.toContain('class="mm-add"');
  expect(make(false)).toContain('data-collapsed="true"');
  expect(make(false)).toContain('>7</button>');
});

it('marks protected nodes by background state while editable deletable leaves remain plain', () => {
  const html = renderToStaticMarkup(<MindMap label="固定" root={{id: 'fixed', kind: 'root', label: '固定', children: [{id: 'mutable', kind: 'leaf', label: '可删除', onDelete: vi.fn()}]}}/>);
  expect(html.match(/data-fixed="true"/g)).toHaveLength(1);
  expect(html).not.toContain('锁');
});


it('keeps operation menus in the diagram when inline menu mode is enabled', () => {
  const html = renderToStaticMarkup(<MindMap root={tree} label="导图" inlineMenus/>);
  expect(html).not.toContain('<details');
  expect(html).not.toContain('role="menu"');
  expect(html).toContain('发版改到周四');
});
