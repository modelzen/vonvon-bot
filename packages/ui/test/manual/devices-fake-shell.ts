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
/** A 60-character name with no break in it: rows wrap it, the header button and menus cut it short. */
const LONG_NAME = 'MacBook-Pro-of-a-colleague-with-a-really-long-hostname-2026x';
type Extra = {name?: string; localOnly?: boolean; adding?: object};
const state = (active: object, status = 'online', extra: Extra = {}) => ({
  v: 1, revision: 1, client: {version: '0.9.1', protocolVersion: 2}, registry: 'ok', secureStorage: true,
  devices: extra.localOnly ? [{id: 'local', name: '这台电脑', current: true, status: 'online', platform: 'macos', version: '0.9.1', routes: []}] : [
    {id: 'local', name: '这台电脑', current: false, status: 'online', platform: 'macos', version: '0.9.1', routes: []},
    {id: A, name: extra.name ?? '机房 Linux', current: true, status, platform: 'linux', version: '0.9.1', routes: [tailscale, lan]},
    {id: B, name: '家里的 Windows', current: false, status: 'revoked', platform: 'windows', version: '0.9.0', routes: [lan]},
    {id: C, name: '办公室 Mac', current: false, status: 'unknown', platform: 'macos', version: '0.9.1', lastConnectedAt: now - 3 * 3_600_000, routes: [lan]},
  ],
  active: extra.localOnly ? {id: 'local', attempt: 0, phase: 'ready', mode: 'full', serverInfo: {...info('0.9.1', 2), machineId: 'local', deviceName: '办公室 Mac', platform: 'macos'}} : {id: A, attempt: 0, ...active},
  ...(extra.adding ? {adding: extra.adding} : {}),
});
const snapshot = {
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.9.1'},
  agents: [{id: 'cli_example', name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [], projects: [], memberships: [], tools: [], jobs: [],
  application: {platform: 'linux', version: '0.9.1', loginItem: false, dataPath: '/home/<u>/.vonvon-bot'},
};
const preview = {ok: true, deviceId: C, name: '办公室 Mac', routes: [tailscale, lan], expiresAt: now + 8 * 60_000, repair: false};

/** `add`: what adding answers; none, it never answers (still connecting). */
function install(input: {state: unknown; snapshot: unknown; preview: unknown; add?: unknown}) {
  // What the desktop's preload marks, once there is a document.
  document.addEventListener('readystatechange', () => { document.documentElement.dataset.desktopChrome = 'silver'; }, {once: true});
  const never = () => new Promise(() => {});
  const client = new Proxy({}, {get: (_target, key) => key === 'then' ? undefined
    : key === 'watchSnapshots' ? (listener: (value: unknown) => void) => { setTimeout(() => listener(input.snapshot)); return () => {}; }
    : typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : never});
  const devices = {
    state: async () => input.state, onState: (listener: (value: unknown) => void) => { listener(input.state); return () => {}; }, clientFor: () => client,
    inspect: async () => input.preview, add: input.add === undefined ? never : async () => input.add, cancelAdd: async () => {}, rename: async () => {}, remove: never, switchTo: async () => {}, retry: async () => {},
  };
  Object.assign(window, {vonvonClient: client, vonvonShell: {devices, onQuitRequested: () => () => {}, onDesktopUpdate: () => () => {}, onLocalDeviceEvent: () => () => {}, openExternal: async () => {}}});
}

/** Each menu item: is what sits at its centre the item itself (Codex 审查 235-4: a sticky heading covered them)? */
const menuHits = (page: import('playwright').Page) => page.evaluate(() => [...document.querySelectorAll('.device-switcher__menu [role="menuitem"]')].map(item => {
  const box = item.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {item: item.textContent, hit: Boolean(hit && item.contains(hit)), on: hit?.tagName};
}));
type Page = import('playwright').Page;
type Scene = {name: string; active: object; status?: string; width?: number; extra?: Extra; preview?: unknown; add?: unknown; steps?: (page: Page) => Promise<unknown>};
const ready = {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)};
const devicesPage = async (page: Page) => {
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.getByRole('button', {name: /^设备/}).click();
};
const addDialog = async (page: Page) => {
  await devicesPage(page);
  await page.getByRole('button', {name: '添加设备'}).click();
  await page.getByRole('dialog').waitFor();
};
const confirmStep = async (page: Page) => {
  await addDialog(page);
  await page.locator('textarea').fill('vonvon://pair#made-up-example');
  await page.getByRole('dialog').locator('.device-add__preview').getByText('办公室 Mac').waitFor();
};
const connectAndAdd = async (page: Page) => {
  await confirmStep(page);
  await page.getByRole('button', {name: '连接并添加'}).click();
};
const cannotConnect = {phase: 'connecting', attempt: 2, retryAt: now + 60_000, failure: {code: 'unreachable', attempts: [{route: tailscale, code: 'unreachable'}, {route: lan, code: 'timeout'}], at: now}};
const scenes: Scene[] = [
  {name: 'devices-page', active: ready, steps: devicesPage},
  {name: 'add-device-confirm', active: ready, steps: confirmStep},
  // 0.9.0 设备 UI 打磨: the other steps of 添加设备, the row menu, one device only, a long name, and a narrow window.
  {name: 'add-device-paste', active: ready, steps: addDialog},
  {name: 'add-device-paste-problem', active: ready, preview: {ok: false, code: 'invalid_link'}, steps: async page => {
    await addDialog(page);
    await page.locator('textarea').fill('https://example.com/not-a-link');
    await page.getByText('这不是 Vonvon Bot 的连接链接').waitFor();
  }},
  {name: 'add-device-adding', active: ready, extra: {adding: {stage: 'connecting', route: tailscale}}, steps: async page => {
    await connectAndAdd(page);
    await page.getByText('正在连接 100.64.0.10:7767…').waitFor();
  }},
  {name: 'add-device-failed', active: ready, add: {kind: 'failed', code: 'unreachable', attempts: [{route: tailscale, code: 'unreachable'}]}, steps: async page => {
    await connectAndAdd(page);
    await page.getByRole('button', {name: '再试一次'}).waitFor();
  }},
  {name: 'add-device-done', active: ready, add: {kind: 'added', deviceId: C, name: '办公室 Mac', repaired: false}, steps: async page => {
    await connectAndAdd(page);
    await page.getByText('已添加「办公室 Mac」。').waitFor();
  }},
  {name: 'repair-dialog', active: ready, steps: async page => {
    await devicesPage(page);
    await page.getByRole('button', {name: '重新配对'}).click();
    await page.getByRole('dialog', {name: '重新配对「家里的 Windows」'}).waitFor();
  }},
  {name: 'devices-row-menu', active: ready, steps: async page => {
    await devicesPage(page);
    await page.getByRole('button', {name: '「机房 Linux」的更多操作'}).click();
    await page.getByRole('menuitem', {name: '删除'}).waitFor();
  }},
  {name: 'devices-rename', active: ready, steps: async page => {
    await devicesPage(page);
    await page.getByRole('button', {name: '「办公室 Mac」的更多操作'}).click();
    await page.getByRole('menuitem', {name: '改名'}).click();
    await page.getByLabel('设备名字').waitFor();
  }},
  {name: 'devices-local-only', active: ready, extra: {localOnly: true}, steps: devicesPage},
  {name: 'devices-long-name', active: ready, extra: {name: LONG_NAME}, steps: devicesPage},
  {name: 'devices-720', active: ready, width: 720, steps: devicesPage},
  {name: 'switcher-long-name', active: ready, extra: {name: LONG_NAME}, steps: async page => {
    await devicesPage(page);
    await page.getByRole('button', {name: /点击切换$/}).click();
  }},
  {name: 'cannot-connect-720', status: 'connecting', width: 720, active: cannotConnect},
  {name: 'maintenance-720', status: 'maintenance', width: 720, active: {phase: 'ready', mode: 'maintenance', serverInfo: info('0.8.2', 1)}},
  {name: 'switcher-over-application', active: {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)}, steps: async page => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: /^应用与启动/}).click();
    await page.getByRole('button', {name: /点击切换$/}).click();
    return menuHits(page);
  }},
  {name: 'rename-then-switch', active: {phase: 'ready', mode: 'full', serverInfo: info('0.9.1', 2)}, steps: async page => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: /^设备/}).click();
    await page.getByRole('button', {name: '「机房 Linux」的更多操作'}).click();
    await page.getByRole('menuitem', {name: '改名'}).click();
    await page.getByLabel('设备名字').fill('机房 Linux 新名字');
    await page.getByRole('button', {name: /点击切换$/}).click();
    await page.getByRole('menuitem', {name: /这台电脑/}).click();
    await page.getByText('有未保存的修改').waitFor();
    return {confirm: true};
  }},
  // 设备 UI 评审再改: a long name on the outside card, the list while the device shown reconnects, and the row menu by keyboard.
  {name: 'cannot-connect-long-name', status: 'connecting', active: cannotConnect, extra: {name: LONG_NAME}},
  {name: 'devices-reconnecting', status: 'reconnecting', active: {phase: 'reconnecting', mode: 'full', attempt: 1, retryAt: now + 60_000, serverInfo: info('0.9.1', 2)}, steps: devicesPage},
  {name: 'devices-menu-keyboard', active: ready, steps: async page => {
    await devicesPage(page);
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
    const open = () => page.locator('.device-menu[data-open]').count();
    const office = page.getByRole('button', {name: '「办公室 Mac」的更多操作'});
    await office.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', {name: '删除'}).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state: 'detached'});
    const afterCancel = await focused();
    await page.keyboard.press('Enter');
    const openedAgain = await open();
    await page.keyboard.press('Shift+Tab');
    const afterTabOut = await open();
    await page.getByRole('button', {name: '「机房 Linux」的更多操作'}).focus();
    await page.keyboard.press('Enter');
    await office.focus();
    await page.keyboard.press('Enter');
    const afterSecond = await open();
    return {afterCancel, openedAgain, afterTabOut, afterSecond};
  }},
  {name: 'cannot-connect', status: 'connecting', active: cannotConnect},
  {name: 'maintenance', status: 'maintenance', active: {phase: 'ready', mode: 'maintenance', serverInfo: info('0.8.2', 1)}},
  {name: 'reconnecting-banner', status: 'reconnecting', active: {phase: 'reconnecting', mode: 'full', attempt: 1, retryAt: now + 60_000, serverInfo: info('0.9.1', 2)}},
];
const browser = await chromium.launch();
try {
  for (const scene of scenes) {
    const page = await browser.newPage({viewport: {width: scene.width ?? 1100, height: 760}});
    page.on('pageerror', error => console.error(scene.name, error.message));
    await page.addInitScript(install, {state: state(scene.active, scene.status, scene.extra), snapshot, preview: scene.preview ?? preview, ...(scene.add ? {add: scene.add} : {})});
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForTimeout(800);
    const result = await scene.steps?.(page).catch(error => { console.error(scene.name, 'step failed:', (error as Error).message.split('\n')[0]); return undefined; });
    await page.waitForTimeout(400);
    if (result !== undefined) await writeFile(join(out, `${scene.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await page.screenshot({path: join(out, `${scene.name}.png`)});
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
