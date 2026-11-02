// devices-ui-1b 6.1 step 3: screenshots of the devices pages for review, with a made-up shell (not run by vitest).
// Build the ui first; then `node packages/ui/test/manual/devices-fake-shell.ts <output directory>`.
// Listens on 127.0.0.1 only; made-up names, ids and documentation addresses only.
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';
import {chromium} from 'playwright';

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

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const now = Date.now();
const tailscale = {host: '100.64.0.10', port: 7767, kind: 'tailscale'}, lan = {host: '192.0.2.10', port: 7767, kind: 'lan'};
const info = (version: string, protocolVersion: number) => ({type: 'serverInfo', machineId: A, version, protocolVersion, deviceName: '机房', platform: 'linux', capabilities: ['device']});
const state = (active: object, status = 'online') => ({
  v: 1, revision: 1, client: {version: '0.9.1', protocolVersion: 2}, registry: 'ok', secureStorage: true,
  devices: [
    {id: 'local', name: '这台电脑', current: false, status: 'online', platform: 'macos', version: '0.9.1', routes: []},
    {id: A, name: '机房 Linux', current: true, status, platform: 'linux', version: '0.9.1', routes: [tailscale, lan]},
    {id: B, name: '家里的 Windows', current: false, status: 'revoked', platform: 'windows', version: '0.9.0', routes: [lan]},
    {id: C, name: '办公室 Mac', current: false, status: 'unknown', platform: 'macos', version: '0.9.1', lastConnectedAt: now - 3 * 3_600_000, routes: [lan]},
  ],
  active: {id: A, attempt: 0, ...active},
});
const snapshot = {
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.9.1'},
  agents: [{id: 'cli_example', name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [], projects: [], memberships: [], tools: [], jobs: [],
  application: {platform: 'linux', version: '0.9.1', loginItem: false, dataPath: '/home/<u>/.vonvon-bot'},
};
const preview = {ok: true, deviceId: C, name: '办公室 Mac', routes: [tailscale, lan], expiresAt: now + 8 * 60_000, repair: false};

function install(input: {state: unknown; snapshot: unknown; preview: unknown}) {
  // What the desktop's preload marks, once there is a document.
  document.addEventListener('readystatechange', () => { document.documentElement.dataset.desktopChrome = 'silver'; }, {once: true});
  const never = () => new Promise(() => {});
  const client = new Proxy({}, {get: (_target, key) => key === 'then' ? undefined
    : key === 'watchSnapshots' ? (listener: (value: unknown) => void) => { setTimeout(() => listener(input.snapshot)); return () => {}; }
    : typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : never});
  const devices = {
    state: async () => input.state, onState: (listener: (value: unknown) => void) => { listener(input.state); return () => {}; }, clientFor: () => client,
    inspect: async () => input.preview, add: never, cancelAdd: async () => {}, rename: async () => {}, remove: never, switchTo: async () => {}, retry: async () => {},
  };
  Object.assign(window, {vonvonClient: client, vonvonShell: {devices, onQuitRequested: () => () => {}, onDesktopUpdate: () => () => {}, onLocalDeviceEvent: () => () => {}, openExternal: async () => {}}});
}

/** Each menu item: is what sits at its centre the item itself (Codex 审查 235-4: a sticky heading covered them)? */
const menuHits = (page: import('playwright').Page) => page.evaluate(() => [...document.querySelectorAll('.device-switcher__menu [role="menuitem"]')].map(item => {
  const box = item.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {item: item.textContent, hit: Boolean(hit && item.contains(hit)), on: hit?.tagName};
}));
const scenes: {name: string; active: object; status?: string; steps?: (page: import('playwright').Page) => Promise<unknown>}[] = [
  {name: 'devices-page', active: {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)}, steps: async page => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: /^设备/}).click();
  }},
  {name: 'add-device-confirm', active: {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)}, steps: async page => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: /^设备/}).click();
    await page.getByRole('button', {name: '添加设备'}).click();
    await page.locator('textarea').fill('vonvon://pair#made-up-example');
    await page.getByText('设备：办公室 Mac').waitFor();
  }},
  {name: 'switcher-over-application', active: {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)}, steps: async page => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: /^应用与启动/}).click();
    await page.getByRole('button', {name: /点击切换$/}).click();
    return menuHits(page);
  }},
  {name: 'rename-then-switch', active: {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)}, steps: async page => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: /^设备/}).click();
    await page.getByRole('button', {name: '改名'}).first().click();
    await page.getByLabel('设备名字').fill('机房 Linux 新名字');
    await page.getByRole('button', {name: /点击切换$/}).click();
    await page.getByRole('menuitem', {name: /这台电脑/}).click();
    await page.getByText('有未保存的修改').waitFor();
    return {confirm: true};
  }},
  {name: 'cannot-connect', status: 'connecting', active: {phase: 'connecting', attempt: 2, retryAt: now + 60_000, failure: {code: 'unreachable', attempts: [{route: tailscale, code: 'unreachable'}, {route: lan, code: 'timeout'}], at: now}}},
  {name: 'maintenance', status: 'maintenance', active: {phase: 'ready', mode: 'maintenance', serverInfo: info('0.8.2', 1)}},
  {name: 'reconnecting-banner', status: 'reconnecting', active: {phase: 'reconnecting', mode: 'full', attempt: 1, retryAt: now + 60_000, serverInfo: info('0.9.1', 2)}},
];
const browser = await chromium.launch();
try {
  for (const scene of scenes) {
    const page = await browser.newPage({viewport: {width: 1100, height: 760}});
    page.on('pageerror', error => console.error(scene.name, error.message));
    await page.addInitScript(install, {state: state(scene.active, scene.status), snapshot, preview});
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForTimeout(800);
    const result = await scene.steps?.(page);
    await page.waitForTimeout(400);
    if (result !== undefined) await writeFile(join(out, `${scene.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await page.screenshot({path: join(out, `${scene.name}.png`)});
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
