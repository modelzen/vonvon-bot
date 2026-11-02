import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { vi } from 'vitest';
import { eventSchema, PROTOCOL_VERSION, replyEnvelopeSchema, serverInfoSchema, type Request, type Event, type ReplyEnvelope, type ServerInfo } from '@vonvon/protocol';
import type { AdminService } from '../src/admin/service';
import type { ShutdownControl } from '../src/host/lifecycle';
import type { EnvironmentServiceOptions } from '../src/environment/service';
import type { startApi as StartApi } from '../src/server/http';
import { createSessionTokens } from '../src/host/session-tokens';

type StartApiOptions = Parameters<typeof StartApi>[0];
/** Linux refuses the service switch, so no test spawns `vonvon service install` from a Mac runner; and with no
 * manager the snapshot gets no service field, whose first real read would publish an event at a random moment. */
const noServiceManager: StartApiOptions['serviceActions'] = { platform: 'linux', readService: async () => ({ supported: false, installed: false, running: false }) };

const testHome = vi.hoisted(() => ({ current: '' }));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return testHome.current; } } }));
vi.mock('../src/agent', () => ({ createBackend: () => ({ doctor: async () => ({ ok: false, version: null, depState: 'not-installed' }) }) }));
export function fakeService(overrides: Partial<AdminService> = {}): AdminService {
  const empty = async (): Promise<void> => {};
  return {
    listBots: async () => [], listProjects: async () => [], getProject: async () => undefined,
    switchBackend: empty, setPermissionMode: empty, setNoMention: empty, setCompletionReminder: empty,
    doctorBackends: async () => [], eventDiagnosis: async () => ({ state: 'unchecked' }), listSessions: async () => [], tailLogs: async () => 'log\n',
    codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }),
    getSetupStatus: async appId => ({ appId, tenant: 'feishu', credentials: { ok: false }, connection: { running: false }, event: { state: 'unchecked' }, scopes: { grantUrl: 'https://example.test' }, eventConfigUrl: 'https://example.test', consoleUrl: 'https://example.test', cardCallback: { confirmed: false } }),
    confirmCardCallback: empty,
    registerBotByQr: async () => ({ ok: false, code: 'abort', reason: 'cancelled' }), refreshBotByQr: async () => ({ ok: false, code: 'abort', reason: 'cancelled' }),
    listBackendCatalog: async () => ({ defaultBackend: 'codex-appserver', entries: [] }),
    installBackend: async () => ({ ok: true, code: 0, aborted: false, tail: '' }),
    uninstallBackend: async () => ({ ok: true, message: 'removed' }), backendVersion: async () => ({ installed: null, latest: null, hasUpdate: false }), backendLogin: async () => ({ state: 'unknown', message: 'fixture' }),
    getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'test', supported: true }),
    restartDaemon: empty, startDaemon: empty, stopDaemon: empty, applyUpdate: empty,
    checkUpdate: async () => ({ current: 'test', latest: null, hasUpdate: false, dev: true }), updateStatus: () => null,
    hostDoctor: async () => ({ node: 'test', platform: 'test', arch: 'test', osRelease: 'test', appDir: testHome.current, logsDir: join(testHome.current, 'logs'), logBytes: 0, version: 'test', backends: [] }),
    setBotEnabled: async () => ({ ok: true, activation: 'applied', message: 'applied' }), deleteBot: async () => ({ ok: true }),
    getVoice: async () => ({ enabled: false, feishu: { state: 'unchecked', message: '' }, result: '', grantUrl: '' }), setVoice: empty,
    accountUsage: async () => ({ profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 1 } }),
    ...overrides,
  };
}
/** The daemon start every fixture reports in daemonStatus (devices 4.7). */
export const FIXTURE_STARTED_AT = 1_700_000_000_000;
export async function startFixture(service = fakeService(), environmentOptions?: EnvironmentServiceOptions, serviceActions: StartApiOptions['serviceActions'] = noServiceManager, remote?: StartApiOptions['remote'], askBot?: StartApiOptions['askBot']) {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-api-'));
  testHome.current = home;
  const { startApi } = await import('../src/server/http');
  const control: ShutdownControl = { requested: false, waitForRequest: () => new Promise<void>(() => {}), dispose: () => {}, requestStop: vi.fn(), requestRestart: vi.fn(), completeShutdown: release => release() };
  // devices-4a 4.1: the host's Bot-session tokens, which a test issues as a Bot process would ask for them
  const sessionTokens = createSessionTokens();
  const api = await startApi({ service, port: 0, control, environmentOptions, serviceActions, startedAt: FIXTURE_STARTED_AT, sessionTokens, ...(remote ? { remote } : {}), ...(askBot ? { askBot } : {}) });
  const credential = (await readFile(join(home, 'local-credential'), 'utf8')).trim();
  return { api, home, credential, control, sessionTokens, close: async () => { await api.close(); await rm(home, { recursive: true, force: true }); } };
}
export type Frame = Event | ReplyEnvelope | ServerInfo;
export async function socketClient(port: number, credential?: string, version: number = PROTOCOL_VERSION, timeoutMs = 3000) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  socket.on('message', bytes => {
    const raw: unknown = JSON.parse(bytes.toString());
    const hello = serverInfoSchema.safeParse(raw);
    const event = eventSchema.safeParse(raw);
    // A protocol 1 peer gets the old shapes (devices 4.5), which today's strict schemas may refuse: kept raw for the test to look at.
    const reply = hello.success || event.success ? undefined : version === 1 ? replyEnvelopeSchema.safeParse(raw).data ?? raw as ReplyEnvelope : replyEnvelopeSchema.parse(raw);
    frames.push(hello.success ? hello.data : event.success ? event.data : reply as ReplyEnvelope);
    for (const wake of waiters) wake();
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Missing expected frame')); }, timeoutMs);
      const check = (): void => { const frame = frames.find(predicate); if (frame) { clearTimeout(timer); waiters.delete(check); resolve(frame); } };
      waiters.add(check);
    });
  }
  socket.send(JSON.stringify({ type: 'hello', clientKind: 'cli', protocolVersion: version, ...(credential ? { credential } : {}) }));
  return { socket, frames, wait, async ready() { await wait(frame => frame.type === 'serverInfo'); }, async call(request: Request) { socket.send(JSON.stringify(request)); return wait(frame => (frame.type === 'response' || frame.type === 'error') && frame.id === request.id); }, async close() { if (socket.readyState === WebSocket.CLOSED) return; await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(); }); } };
}
