// devices-ui-3 6.1 step 3: screenshots of 允许别的设备连接 and the paired toast, with a made-up shell (not run by vitest).
// Build the ui first; then `node packages/ui/test/manual/served-fake-shell.ts <output directory>`.
// Listens on 127.0.0.1 only; made-up names and ids, documentation addresses only; nothing is opened on the network.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {chromium, type Page} from 'playwright';

const out = resolve(process.argv[2] ?? '.');
const dist = resolve(import.meta.dirname, '../../dist');
const types: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
const server = createServer((request, response) => {
  const path = join(dist, decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname).replace(/^\/$/, '/index.html'));
  if (!path.startsWith(dist)) { response.writeHead(403).end(); return; }
  readFile(path).then(body => response.writeHead(200, {'content-type': types[extname(path)] ?? 'application/octet-stream'}).end(body), () => response.writeHead(404).end());
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const port = (server.address() as {port: number}).port;

const A = '11111111-1111-4111-8111-111111111111';
const now = Date.now();
const devicesState = (remote: boolean) => ({
  v: 1, revision: 1, client: {version: '0.9.1', protocolVersion: 2}, registry: 'ok', secureStorage: true,
  devices: [
    {id: 'local', name: '这台电脑', current: !remote, status: 'online', platform: 'macos', version: '0.9.1', routes: []},
    {id: A, name: '机房 Linux', current: remote, status: 'online', platform: 'linux', version: '0.9.1', routes: [{host: '100.64.0.10', port: 7767, kind: 'tailscale'}]},
  ],
  active: remote
    ? {id: A, attempt: 0, phase: 'ready', mode: 'full', serverInfo: {type: 'serverInfo', machineId: A, version: '0.9.1', protocolVersion: 2, deviceName: '机房 Linux', platform: 'linux', capabilities: ['device', 'remote']}}
    : {id: 'local', attempt: 0, phase: 'ready', mode: 'full', serverInfo: {type: 'serverInfo', machineId: 'local', version: '0.9.1', protocolVersion: 2, deviceName: '办公室 Mac', platform: 'macos', capabilities: ['device']}},
});
const snapshot = (platform: string) => ({
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.9.1'},
  agents: [{id: 'cli_example', name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active', provider: 'codex'}],
  groups: [], projects: [], memberships: [], tools: [], jobs: [],
  application: {platform, version: '0.9.1', loginItem: false, dataPath: '/Users/<u>/.vonvon-bot'},
});
const candidates = [
  {host: '100.64.0.10', kind: 'tailscale', iface: 'utun4', tool: 'Tailscale'},
  {host: '10.147.17.5', kind: 'overlay', iface: 'feth2', tool: 'ZeroTier'},
  {host: '192.168.1.23', kind: 'lan', iface: 'en0'},
  {host: '100.70.0.3', kind: 'cgnat', iface: 'pdp_ip0'},
];
type Listener = {state?: string; detail?: string};
const status = (open: string | undefined, via?: string, listener: Listener = {}, list: object[] = candidates) => ({
  device: {id: A, name: via ? '机房 Linux' : '办公室 Mac', publicKey: 'made-up'},
  remote: {port: 7767, addresses: open ? [{host: open, kind: candidates.find(each => each.host === open)?.kind ?? 'tailscale', enabledAt: now - 3_600_000, state: listener.state ?? 'listening', ...(listener.detail ? {detail: listener.detail} : {})}] : [], candidates: list},
  clients: {total: open ? 3 : 0, active: open ? 1 : 0}, ...(via ? {via} : {}),
});
const client = (id: string, name: string, extra: object) => ({id, name, publicKey: 'made-up', clientKind: 'desktop', createdAt: now - 20 * 86_400_000, lastSeenAt: now - 2 * 3_600_000, lastAddress: '100.64.0.20:51000', pairedVia: 'invite', invitedBy: 'local', ...extra});
const clients = (some: boolean, self?: string) => ({kind: 'clients', generation: 3, ...(self ? {self} : {}), clients: some ? [
  client('cl_aaaaaaaaaaaaaaaa', 'Clay 的 MacBook', {}),
  client('cl_bbbbbbbbbbbbbbbb', '工作笔记本', {createdAt: now - 3_600_000, lastSeenAt: now - 120_000, invitedBy: 'cl_aaaaaaaaaaaaaaaa'}),
  client('cl_cccccccccccccccc', 'CI 服务', {clientKind: 'cli', invitedBy: 'cl_bbbbbbbbbbbbbbbb', lastAddress: '100.64.0.30:40000'}),
] : []});

type Input = {state: unknown; snapshot: unknown; status: unknown; clients: unknown};
function install(input: Input) {
  // What the desktop's preload marks, once there is a document.
  document.addEventListener('readystatechange', () => { document.documentElement.dataset.desktopChrome = 'silver'; }, {once: true});
  const never = () => new Promise(() => {});
  const device = async (request: {type: string}) => {
    if (request.type === 'status') return {kind: 'deviceStatus', status: input.status};
    if (request.type === 'clients') return input.clients;
    if (request.type === 'pair') return {kind: 'pairingLink', link: 'vonvon://pair#made-up-example-link-for-a-screenshot', inviteId: 'inv_0000000000000000', expiresAt: Date.now() + 552_000};
    return never();
  };
  const client = new Proxy({}, {get: (_target, key) => key === 'then' ? undefined
    : key === 'watchSnapshots' ? (listener: (value: unknown) => void) => { setTimeout(() => listener(input.snapshot)); return () => {}; }
    : key === 'device' ? device
    : key === 'admin' || key === 'machine' ? never
    : typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : never});
  const devices = {
    state: async () => input.state, onState: (listener: (value: unknown) => void) => { listener(input.state); return () => {}; }, clientFor: () => client,
    inspect: never, add: never, cancelAdd: async () => {}, rename: async () => {}, remove: never, switchTo: async () => {}, retry: async () => {},
  };
  const paired = new Set<(event: unknown) => void>();
  Object.assign(window, {
    vonvonClient: client,
    emitPaired: (event: unknown) => { for (const listener of paired) listener(event); },
    vonvonShell: {devices, quitKeepsDaemon: async () => false, onQuitRequested: () => () => {}, onDesktopUpdate: () => () => {}, openExternal: async () => {},
      onLocalDeviceEvent: (listener: (event: unknown) => void) => { paired.add(listener); return () => { paired.delete(listener); }; }},
  });
}

const panel = async (page: Page) => {
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.getByRole('button', {name: /^应用与启动/}).click();
  await page.getByText('别的设备用哪个地址连过来').scrollIntoViewIfNeeded();
};
/** The panel with the bottom of the address choice in the middle of the page (its actions and any long state). */
const addressEnd = async (page: Page) => {
  await panel(page);
  await page.locator('.remote-address-actions').evaluate(element => element.scrollIntoView({block: 'center'}));
};
const toast = (name: string) => async (page: Page) => {
  await page.evaluate(event => (window as unknown as {emitPaired: (value: unknown) => void}).emitPaired(event),
    {change: 'client-paired', clientId: 'cl_dddddddddddddddd', name, clientKind: 'desktop', address: '100.64.0.40:52144', invitedBy: 'local'});
};
const scenes: {name: string; remote?: boolean; open?: string; via?: string; some?: boolean; self?: string; width?: number; listener?: Listener; noCandidates?: boolean; steps: (page: Page) => Promise<void>}[] = [
  {name: 'served-local-none', steps: panel},
  {name: 'served-local-link', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByRole('button', {name: '生成连接链接'}).click();
    await page.getByText('还剩').waitFor();
    await page.getByText('连接链接').first().scrollIntoViewIfNeeded();
  }},
  {name: 'served-clients', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByText('已配对的设备').last().scrollIntoViewIfNeeded();
  }},
  {name: 'served-cgnat-confirm', steps: async page => {
    await panel(page);
    await page.getByText('运营商地址（要确认）').click();
    await page.getByRole('button', {name: '开启', exact: true}).click();
  }},
  {name: 'served-switch-confirm', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByText('局域网', {exact: true}).click();
    await page.getByRole('button', {name: '换成这个地址'}).click();
  }},
  {name: 'served-revoke-confirm', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByText('已配对的设备').last().scrollIntoViewIfNeeded();
    await page.getByRole('button', {name: '「Clay 的 MacBook」的更多操作'}).click();
    await page.getByRole('menuitem', {name: '撤销'}).click();
  }},
  {name: 'served-remote-via', remote: true, open: '100.64.0.10', via: '100.64.0.10', some: true, self: 'cl_bbbbbbbbbbbbbbbb', steps: panel},
  {name: 'served-remote-self', remote: true, open: '100.64.0.10', via: '100.64.0.10', some: true, self: 'cl_bbbbbbbbbbbbbbbb', steps: async page => {
    await panel(page);
    await page.getByText('已配对的设备').last().scrollIntoViewIfNeeded();
  }},
  {name: 'served-remote-close-confirm', remote: true, open: '100.64.0.10', via: '100.64.0.10', some: true, self: 'cl_bbbbbbbbbbbbbbbb', steps: async page => {
    await panel(page);
    await page.getByRole('button', {name: '关闭远程连接'}).click();
  }},
  {name: 'served-paired-toast-local', open: '100.64.0.10', steps: async page => { await panel(page); await toast('家里的台式机')(page); }},
  {name: 'served-paired-toast-remote', remote: true, open: '100.64.0.10', steps: toast('家里的台式机')},
  // 0.9.0 设备 UI 打磨: no address, a port that is taken, the paired row's menu, 已复制, and a narrow window.
  {name: 'served-no-address', noCandidates: true, steps: addressEnd},
  {name: 'served-waiting-port', open: '100.64.0.10', listener: {state: 'waiting', detail: '端口 7767 被占用，每 15 秒重试；可用 `vonvon remote port <n>` 换端口'}, steps: addressEnd},
  {name: 'served-paired-menu', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByText('已配对的设备').last().scrollIntoViewIfNeeded();
    await page.getByRole('button', {name: '「工作笔记本」的更多操作'}).click();
    await page.getByRole('menuitem', {name: '撤销'}).waitFor();
  }},
  {name: 'served-paired-rename', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByText('已配对的设备').last().scrollIntoViewIfNeeded();
    await page.getByRole('button', {name: '「CI 服务」的更多操作'}).click();
    await page.getByRole('menuitem', {name: '改名'}).click();
    await page.getByLabel('名字', {exact: true}).waitFor();
  }},
  {name: 'served-copied', open: '100.64.0.10', some: true, steps: async page => {
    await panel(page);
    await page.getByRole('button', {name: '生成连接链接'}).click();
    await page.getByRole('button', {name: '复制'}).click();
    await page.getByText('已复制', {exact: true}).waitFor();
    await page.getByText('连接链接').first().scrollIntoViewIfNeeded();
  }},
  {name: 'served-720', open: '100.64.0.10', some: true, width: 720, steps: addressEnd},
  {name: 'served-720-clients', open: '100.64.0.10', some: true, width: 720, steps: async page => {
    await panel(page);
    await page.getByRole('button', {name: '生成连接链接'}).click();
    await page.getByText('已配对的设备').last().scrollIntoViewIfNeeded();
  }},
];
const browser = await chromium.launch();
try {
  for (const scene of scenes) {
    const page = await browser.newPage({viewport: {width: scene.width ?? 1100, height: 820}});
    page.on('pageerror', error => console.error(scene.name, error.message));
    // 复制 writes to the clipboard: allowed here, on this made-up page only.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(install, {state: devicesState(Boolean(scene.remote)), snapshot: snapshot(scene.remote ? 'linux' : 'macos'),
      status: status(scene.open, scene.via, scene.listener, scene.noCandidates ? [] : candidates), clients: clients(Boolean(scene.some), scene.self)});
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForTimeout(800);
    await scene.steps(page).catch(error => console.error(scene.name, 'step failed:', (error as Error).message.split('\n')[0]));
    await page.waitForTimeout(600);
    await page.screenshot({path: join(out, `${scene.name}.png`)});
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
