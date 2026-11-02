// devices-ui-2 6.1 step 4: screenshots of the pages that change while another device is shown, with a made-up shell
// (not run by vitest). Build the ui first; then `node packages/ui/test/manual/remote-mode-fake-shell.ts <output directory>`.
// Listens on 127.0.0.1 only; made-up names, ids and documentation addresses only.
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
const lan = {host: '192.0.2.10', port: 7767, kind: 'lan'};
type Platform = 'linux' | 'windows' | 'macos';
const NAMES: Record<Platform, string> = {linux: '机房 Linux', windows: '家里的 Windows', macos: '办公室 Mac'};
const info = (platform: Platform, version: string, protocolVersion: number, capabilities: string[]) =>
  ({type: 'serverInfo', machineId: A, version, protocolVersion, deviceName: NAMES[platform], platform, capabilities});
const state = (platform: Platform, active: object, status = 'online') => ({
  v: 1, revision: 1, client: {version: '0.9.1', protocolVersion: 2}, registry: 'ok', secureStorage: true,
  devices: [
    {id: 'local', name: '这台电脑', current: false, status: 'online', platform: 'macos', version: '0.9.1', routes: []},
    {id: A, name: NAMES[platform], current: true, status, platform, version: '0.9.1', routes: [lan]},
  ],
  active: {id: A, attempt: 0, ...active},
});
const service = {linux: {state: 'running', skipped: false, linger: 'off'}, windows: undefined, macos: {state: 'running', skipped: false}};
const snapshot = (platform: Platform) => ({
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'attached', version: '0.9.1'},
  agents: [{id: 'cli_example', name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active', provider: 'codex'}],
  groups: [], projects: [], memberships: [], tools: [], jobs: [],
  application: {platform, version: '0.9.1', loginItem: false, dataPath: '/home/<u>/.vonvon-bot', ...service[platform] ? {service: service[platform]} : {}},
});
const tool = (name: string, version: string) => ({tool: name, installation: 'external', executable: `/usr/local/bin/${name}`, version, managedVersion: null, latestVersion: version, updateAvailable: false, canUninstall: false, runtimeStatus: 'ready', source: 'npm'});
const answers = {
  machine: {
    checkCoreUpdate: {type: 'coreUpdate', distribution: {kind: 'standalone', cliPath: '/home/<u>/.local/bin/vonvon'}, current: '0.9.0', latest: '0.9.1', hasUpdate: true, dev: false},
    coreUpdateStatus: {type: 'coreUpdateStatus', status: null},
    status: {type: 'status', service: {platformName: 'systemd', installed: true, running: true, servicePath: '/home/<u>/.config/systemd/user/vonvon-bot.service', stdoutPath: '/home/<u>/.vonvon-bot/daemon.log', stderrPath: '/home/<u>/.vonvon-bot/daemon.log', state: 'running'}, host: {ownership: 'attached', pid: 4242}, cli: {kind: 'ready', bin: '/home/<u>/.local/bin/vonvon', message: '已就绪'}},
  },
  environment: {
    scan: {kind: 'tools', tools: [tool('codex', '0.130.0'), tool('claude', '2.4.0'), tool('lark-cli', '1.9.0')]},
    profileList: {kind: 'profiles', profiles: []}, backendCatalog: {kind: 'backends', entries: []},
    profileInitStatus: {kind: 'operation', operation: null}, toolInstallStatus: {kind: 'toolInstall', operation: null},
    authStatus: {kind: 'auth', tool: 'codex', state: 'signedIn', message: '可用'},
  },
};

function install(input: {state: unknown; snapshot: unknown; answers: Record<string, Record<string, unknown>>}) {
  // What the desktop's preload marks, once there is a document.
  document.addEventListener('readystatechange', () => { document.documentElement.dataset.desktopChrome = 'silver'; }, {once: true});
  const never = () => new Promise(() => {});
  const answer = (surface: Record<string, unknown>) => (request: {type: string; tool?: string}) => {
    const reply = surface[request.type];
    if (!reply) return never();
    return Promise.resolve(request.type === 'authStatus' ? {...reply as object, tool: request.tool} : reply);
  };
  const client = new Proxy({}, {get: (_target, key) => key === 'then' ? undefined
    : key === 'watchSnapshots' ? (listener: (value: unknown) => void) => { setTimeout(() => listener(input.snapshot)); return () => {}; }
    : typeof key === 'string' && input.answers[key] ? answer(input.answers[key]!)
    : typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : never});
  const devices = {
    state: async () => input.state, onState: (listener: (value: unknown) => void) => { listener(input.state); return () => {}; }, clientFor: () => client,
    inspect: never, add: never, cancelAdd: async () => {}, rename: async () => {}, remove: never, switchTo: async () => {}, retry: async () => {},
  };
  Object.assign(window, {vonvonClient: client, vonvonShell: {devices, quitKeepsDaemon: async () => true, onQuitRequested: () => () => {}, onDesktopUpdate: () => () => {}, onLocalDeviceEvent: () => () => {}, openExternal: async () => {}}});
}

const settings = (title: RegExp) => async (page: Page) => {
  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.getByRole('button', {name: title}).first().click();
};
// The page scrolls inside its own container: bring the device's 后台服务 group up.
const serviceGroup = async (page: Page) => {
  await settings(/^应用与启动/)(page);
  await page.getByText('登录时启动').first().scrollIntoViewIfNeeded();
};
const full = (platform: Platform) => ({phase: 'ready', mode: 'full', serverInfo: info(platform, '0.9.0', 2, ['device', 'update.standalone'])});
const scenes: {name: string; platform: Platform; active: object; status?: string; steps?: (page: Page) => Promise<void>}[] = [
  {name: 'application-remote-linux', platform: 'linux', active: full('linux'), steps: settings(/^应用与启动/)},
  {name: 'application-remote-linux-service', platform: 'linux', active: full('linux'), steps: serviceGroup},
  {name: 'application-remote-windows-service', platform: 'windows', active: full('windows'), steps: serviceGroup},
  {name: 'application-remote-stop-confirm', platform: 'linux', active: full('linux'), steps: async page => {
    await settings(/^应用与启动/)(page);
    await page.getByText('高级运行设置').first().click().catch(() => {});
    await page.getByRole('button', {name: '停止', exact: true}).click();
  }},
  {name: 'tools-remote', platform: 'linux', active: full('linux'), steps: settings(/^工具与连接/)},
  {name: 'providers-remote', platform: 'linux', active: full('linux'), steps: settings(/^Provider/)},
  {name: 'create-group-full-access', platform: 'linux', active: full('linux'), steps: async page => {
    await page.getByRole('button', {name: 'Bot', exact: true}).click();
    await page.getByText('研发助手').first().click();
    await page.getByRole('button', {name: '拉 Bot 入群'}).click();
    await page.getByText('权限').first().scrollIntoViewIfNeeded();
  }},
  {name: 'maintenance-upgrade-server', platform: 'linux', status: 'maintenance',
    active: {phase: 'ready', mode: 'maintenance', serverInfo: info('linux', '0.9.0', 1, ['device', 'update.standalone'])}},
];
const browser = await chromium.launch();
try {
  for (const scene of scenes) {
    const page = await browser.newPage({viewport: {width: 1100, height: 820}});
    page.on('pageerror', error => console.error(scene.name, error.message));
    await page.addInitScript(install, {state: state(scene.platform, scene.active, scene.status), snapshot: snapshot(scene.platform), answers});
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForTimeout(800);
    await scene.steps?.(page).catch(error => console.error(scene.name, 'step failed:', (error as Error).message.split('\n')[0]));
    await page.waitForTimeout(600);
    await page.screenshot({path: join(out, `${scene.name}.png`)});
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
