import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ClientRecord, DeviceStatus} from '@vonvon/protocol';
import {ConfirmPanel, RemoteAccessView} from '../src/settings/RemoteAccessPanel';
import {addressRows, type ClientsReply, type Confirm} from '../src/settings/remote-access-presentation';
import {DraftGuardProvider} from '../src/settings/DraftGuard';

// devices-ui-3 第 5 节 remote-access-panel. main 必败: there was no 允许别的设备连接.
const now = 1_000_000_000_000;
const local = {isRemote: false, name: '这台电脑'};
const remote = {isRemote: true, name: '机房 Linux'};
const status = (addresses: DeviceStatus['remote']['addresses'], via?: string): DeviceStatus => ({
  device: {id: 'd', name: '办公室 Mac', publicKey: 'k'}, clients: {total: 2, active: 1}, ...(via ? {via} : {}),
  remote: {port: 7767, addresses, candidates: [{host: '100.64.0.10', kind: 'tailscale', iface: 'tailscale0', tool: 'Tailscale'}, {host: '192.168.1.9', kind: 'lan', iface: 'eth0'}, {host: '100.70.0.3', kind: 'cgnat', iface: 'eth1'}]},
});
const client = (id: string, name: string, extra: Partial<ClientRecord> = {}): ClientRecord => ({
  id, name, publicKey: 'k', clientKind: 'desktop', createdAt: now - 30 * 86_400_000, lastSeenAt: now - 3_600_000, lastAddress: '100.64.0.20:51000', pairedVia: 'invite', invitedBy: 'local', ...extra,
});
const noop = () => {};
const view = (props: Partial<Parameters<typeof RemoteAccessView>[0]> & {status?: DeviceStatus}) => renderToStaticMarkup(<DraftGuardProvider><RemoteAccessView
  where={local} rows={props.status ? addressRows(props.status) : []} expired={false} now={now} busy={false}
  onPick={noop} onRefresh={noop} onEnable={noop} onDisable={noop} onReconfirm={noop} onPair={noop} onCopy={noop} onRename={noop} renameForm={() => null} onRevoke={noop}
  {...props}/></DraftGuardProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const confirmPanel = (confirm: Confirm, ticked: boolean, ready: boolean) => renderToStaticMarkup(<ConfirmPanel confirm={confirm} ticked={ticked} ready={ready} busy={false} onTick={vi.fn()} onCancel={vi.fn()} onConfirm={vi.fn()}/>);

it('offers the addresses as one choice, the recommended one first and picked, with 开启 and the link greyed', () => {
  const html = view({status: status([]), picked: '100.64.0.10'});
  expect(text(html)).toContain('允许别的设备连接本机');
  expect(html).toContain('role="radiogroup"');
  expect(html.match(/type="radio"/g)).toHaveLength(3);
  expect(html).toMatch(/checked="" value="100\.64\.0\.10"/);
  expect(text(html).indexOf('Tailscale（推荐）')).toBeLessThan(text(html).indexOf('局域网'));
  expect(text(html)).toContain('运营商地址（要确认）');
  expect(html).toMatch(/<button[^>]*><span>开启<\/span>/);
  expect(html).not.toContain('关闭远程连接');
  expect(html).toMatch(/disabled=""[^>]*><span>生成连接链接/);
  expect(text(html)).toContain('先在上面选一个地址并开启。');
  expect(text(html)).toContain('端口 7767');
  expect(text(html)).toContain('还没有别的设备连过来。');
  // a Tailscale address is there: no advice
  expect(html).not.toContain('推荐用 Tailscale');
});
it('shows the open address\'s state, 换成这个地址 for another pick, and 确认并重新开启 after the network changed', () => {
  const open = view({status: status([{host: '100.64.0.10', kind: 'tailscale', enabledAt: 1, state: 'listening'}]), picked: '192.168.1.9'});
  expect(text(open)).toContain('监听中');
  expect(text(open)).toContain('换成这个地址');
  expect(text(open)).toContain('换了以后 100.64.0.10 不再接受连接，已配对的设备要粘一次新链接。');
  expect(text(open)).toContain('关闭远程连接');
  expect(open).not.toMatch(/<span>开启<\/span>/);
  expect(open).toMatch(/<button[^>]*class="ui-button ui-button--secondary ui-button--sm"><span>生成连接链接/);
  const changed = view({status: status([{host: '192.168.1.9', kind: 'lan', enabledAt: 1, state: 'needs-confirmation', detail: '这台设备所在的网络变了'}]), picked: '192.168.1.9'});
  expect(text(changed)).toContain('网络变了，要确认：这台设备所在的网络变了');
  expect(text(changed)).toContain('确认并重新开启');
  expect(text(changed)).not.toContain('换成这个地址');
});
it('asks about the risk with 开启 grey until 我了解风险 is ticked, and gives the reply\'s words for confirm_required', () => {
  const risk: Confirm = {kind: 'risk', host: '100.70.0.3', text: '100.70.0.3 不在 Tailscale 或别的组网工具的网卡上…勾选「我了解风险」后再开启。'};
  const unticked = confirmPanel(risk, false, false);
  expect(unticked).toContain('我了解风险');
  expect(unticked).toMatch(/disabled=""[^>]*><span>开启<\/span>/);
  expect(unticked).not.toMatch(/disabled=""[^>]*><span>取消<\/span>/);
  expect(confirmPanel(risk, true, true)).not.toMatch(/disabled=""[^>]*><span>开启<\/span>/);
});
it('marks the address this computer came in on, and asks before closing it', () => {
  const html = view({status: status([{host: '100.64.0.10', kind: 'tailscale', enabledAt: 1, state: 'listening'}], '100.64.0.10'), picked: '100.64.0.10', where: remote});
  expect(text(html)).toContain('允许别的设备连接「机房 Linux」');
  expect(text(html)).toContain('你正通过它连着');
  expect(text(html)).toContain('在「机房 Linux」的终端运行');
  const closing = confirmPanel({kind: 'disable', host: '100.64.0.10', text: '你现在就是通过这个地址连着「机房 Linux」的。关掉后这台电脑会马上断开，要到那台设备上重新开启。'}, false, true);
  expect(text(closing)).toContain('你现在就是通过这个地址连着「机房 Linux」的。');
  expect(closing).not.toContain('我了解风险');
});
it('shows the link with its countdown, and says when it ran out', () => {
  const st = status([{host: '100.64.0.10', kind: 'tailscale', enabledAt: 1, state: 'listening'}]);
  const html = view({status: st, link: {text: 'vonvon://pair#example', expiresAt: now + 552_000}});
  expect(html).toContain('value="vonvon://pair#example"');
  expect(text(html)).toContain('还剩 9 分 12 秒');
  expect(text(html)).toContain('再生成一个');
  expect(text(html)).toContain('复制');
  const gone = view({status: st, expired: true});
  expect(text(gone)).toContain('链接过期了，再生成一个。');
  expect(gone).not.toContain('vonvon://pair#example');
});
it('lists the paired clients with who brought them, marks the new one and the caller, and gives no 撤销 for the caller', () => {
  const clients: ClientsReply = {kind: 'clients', generation: 4, self: 'cl_bbbbbbbbbbbbbbbb', clients: [
    client('cl_aaaaaaaaaaaaaaaa', 'Clay 的 MacBook'),
    client('cl_bbbbbbbbbbbbbbbb', '工作笔记本', {invitedBy: 'cl_aaaaaaaaaaaaaaaa', createdAt: now - 3_600_000, lastSeenAt: now - 60_000, clientKind: 'cli'}),
    client('cl_cccccccccccccccc', '旧电脑', {revokedAt: now - 1}),
  ]};
  const html = view({status: status([]), clients, where: remote});
  const rows = html.split('remote-client').slice(1);
  expect(rows).toHaveLength(2);
  const [newest, first] = rows.map(text);
  expect(newest).toContain('工作笔记本');
  expect(newest).toContain('新');
  expect(newest).toContain('这台电脑');
  expect(newest).not.toContain('本机');
  expect(newest).toContain('命令行 · 上次连接 1 分钟前，来自 100.64.0.20 · 由「Clay 的 MacBook」带进来');
  expect(newest).toContain('这是你现在用的这台电脑。要断开，到「设备」页删掉「机房 Linux」。');
  expect(newest).not.toContain('撤销');
  expect(first).toContain('在「机房 Linux」上生成的链接');
  expect(first).toContain('撤销');
  expect(first).not.toContain('新');
  expect(text(html)).not.toContain('旧电脑');
});
it('offers to revoke the ones a client brought in too', () => {
  const html = confirmPanel({kind: 'revoke', clientId: 'cl_aaaaaaaaaaaaaaaa', name: 'Clay 的 MacBook', downstream: 2}, false, true);
  expect(text(html)).toContain('取消「Clay 的 MacBook」的访问？它会立刻断开，要再连得重新配对。');
  expect(text(html)).toContain('同时撤销它带进来的 2 台');
  expect(html).not.toMatch(/checked=""/);
  expect(confirmPanel({kind: 'revoke', clientId: 'x', name: 'x', downstream: 0}, false, true)).not.toContain('同时撤销');
});
it('says why it has nothing to show, and gives the Tailscale advice without a Tailscale address', () => {
  expect(text(view({readError: '「机房 Linux」上的 Vonvon Bot 太旧，不支持这里的设置。'}))).toContain('太旧，不支持这里的设置');
  const bare: DeviceStatus = {...status([]), remote: {port: 7767, addresses: [], candidates: [{host: '192.168.1.9', kind: 'lan'}]}};
  expect(text(view({status: bare}))).toContain('推荐用 Tailscale');
  const none: DeviceStatus = {...status([]), remote: {port: 7767, addresses: [], candidates: []}};
  expect(text(view({status: none}))).toContain('这台设备现在没有别的设备能连过来的地址。');
});
