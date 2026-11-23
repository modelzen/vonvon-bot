import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {registeredProviderPids} from '../src/agent/owned-process.js';
import {feedbackCliEnvironment, feedbackCliIdentity, FEEDBACK_SCOPES, IsolatedFeedbackCli, type FeedbackBotCredential} from '../src/feedback/lark-cli.js';
import {type FeedbackActor} from '../src/feedback/types.js';

const actor: FeedbackActor = {
  botId: 'bot-1', appId: 'cli_feedback', tenantKey: 'tenant-1', openId: 'ou_author', chatId: 'oc_feedback', messageId: 'message-1',
};
const fakeSecret = 'test-only-secret-sent-on-stdin';
const stderrSecret = 'test-only-sensitive-cli-stderr';
const inheritedSecrets = ['LARK_USER_ACCESS_TOKEN', 'LARKSUITE_CLI_TOKEN', 'FEISHU_USER_ACCESS_TOKEN', 'FEISHU_APP_SECRET', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'SECRETS', 'NODE_OPTIONS', 'NODE_PATH'];

function status(overrides: {appId?: string; openId?: string; name?: string; verified?: boolean; readiness?: string} = {}): unknown {
  return {
    appId: overrides.appId ?? actor.appId, verified: overrides.verified ?? true,
    identities: {user: {status: overrides.readiness ?? 'ready', available: true, verified: true, scope: FEEDBACK_SCOPES.join(' '), userName: overrides.name ?? '同名用户', openId: overrides.openId ?? actor.openId}},
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('feedback CLI verified identity', () => {
  it('uses appId and openId from verified root status, independent of display name', () => {
    expect(feedbackCliIdentity(status(), actor)).toEqual({appId: actor.appId, openId: actor.openId, name: '同名用户'});
    expect(feedbackCliIdentity(status({name: '改过名字'}), actor)).toEqual({appId: actor.appId, openId: actor.openId, name: '改过名字'});
    expect(() => feedbackCliIdentity(status({openId: 'ou_anotherPerson'}), actor)).toThrow(/不一致/);
    expect(() => feedbackCliIdentity(status({appId: 'cli_anotherApp'}), actor)).toThrow(/不一致/);
  });

  it('accepts a verified automatic refresh but rejects partial authorization', () => {
    expect(feedbackCliIdentity(status({readiness: 'needs_refresh'}), actor).openId).toBe(actor.openId);
    const incomplete = {appId: actor.appId, verified: true, identities: {user: {status: 'ready', available: true, verified: true,
      scope: 'base:form:read base:record:read', userName: '同名用户', openId: actor.openId}}};
    expect(() => feedbackCliIdentity(incomplete, actor)).toThrow(/范围不完整/);
  });

  it.each([status({verified: false}), status({readiness: 'expired'}), {appId: actor.appId, verified: true, identities: {bot: {status: 'ready'}}}, {ok: false, error: 'not authorized'}])('rejects unverified, expired, bot-only or failed status', value => {
    expect(() => feedbackCliIdentity(value, actor)).toThrow(/本人/);
  });
});

describe('feedback CLI isolated environment', () => {
  it('constructs a minimal private environment without inherited tokens, secrets or Node injection', () => {
    for (const name of inheritedSecrets) vi.stubEnv(name, `fake-inherited-${name}`);
    vi.stubEnv('LARKSUITE_CLI_CONFIG_DIR', '/untrusted/configuration');
    vi.stubEnv('PATH', '/untrusted/executable-directory');
    vi.stubEnv('HTTPS_PROXY', 'https://proxy.invalid:8443');
    const privateHome = join(tmpdir(), 'feedback-private-home');
    const executable = join(tmpdir(), 'trusted-cli', 'lark-cli');
    const environment = feedbackCliEnvironment(privateHome, executable);
    expect(environment.HOME).toBe(privateHome);
    expect(environment.USERPROFILE).toBe(privateHome);
    expect(environment.LARKSUITE_CLI_CONFIG_DIR).toBe(join(privateHome, 'configuration'));
    expect(environment.XDG_CONFIG_HOME).toBe(join(privateHome, '.config'));
    expect(environment.APPDATA).toBe(join(privateHome, 'AppData', 'Roaming'));
    expect(environment.HTTPS_PROXY).toBe('https://proxy.invalid:8443');
    for (const name of inheritedSecrets) expect(environment).not.toHaveProperty(name);
    expect(environment.PATH).toContain(dirname(process.execPath));
    expect(environment.PATH).toContain(dirname(executable));
    expect(environment.PATH).not.toContain('/untrusted');
    expect(JSON.stringify(environment)).not.toContain('fake-inherited-');
  });

  it('rejects relative host configuration before launching a child', () => {
    const credential = async (): Promise<FeedbackBotCredential> => ({appId: actor.appId, appSecret: fakeSecret, registrationKey: 'test-registration'});
    expect(() => new IsolatedFeedbackCli({root: 'relative', executable: process.execPath, credential})).toThrow();
    expect(() => new IsolatedFeedbackCli({root: tmpdir(), executable: 'relative-cli', credential})).toThrow();
  });

  it.runIf(process.platform === 'win32')('does not claim HOME isolates the Windows shared keychain', () => {
    expect(() => new IsolatedFeedbackCli({root: tmpdir(), executable: process.execPath,
      credential: async () => ({appId: actor.appId, appSecret: fakeSecret, registrationKey: 'test-registration'})})).toThrow(/Windows/);
  });
});

interface StubControl {
  openId?: string;
  auth?: unknown;
  mode?: 'ok' | 'fail' | 'hang' | 'flood';
}

const traceSchema = z.object({args: z.array(z.string()), stdin: z.string(), cwd: z.string(), pid: z.number().int().positive(), environment: z.record(z.string(), z.string())});
type StubTrace = z.infer<typeof traceSchema>;

function alive(pid: number): boolean {
  try {process.kill(pid, 0); return true;}
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('feedback CLI real local child lifecycle', () => {
  let scratch: string;
  let root: string;
  let executable: string;
  let controlPath: string;
  let tracePath: string;
  const clients: IsolatedFeedbackCli[] = [];

  async function control(value: StubControl = {}): Promise<void> {
    await writeFile(controlPath, JSON.stringify(value));
  }

  async function trace(): Promise<StubTrace[]> {
    let value: string;
    try {value = await readFile(tracePath, 'utf8');}
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    return value.split('\n').filter(Boolean).map(line => {
      const parsed: unknown = JSON.parse(line);
      return traceSchema.parse(parsed);
    });
  }

  function client(options: {timeoutMs?: number; credential?: (input: FeedbackActor) => Promise<FeedbackBotCredential>} = {}): IsolatedFeedbackCli {
    const cli = new IsolatedFeedbackCli({root, executable, timeoutMs: options.timeoutMs ?? 3000,
      credential: options.credential ?? (async input => ({appId: input.appId, appSecret: fakeSecret, registrationKey: 'test-registration'}))});
    clients.push(cli);
    return cli;
  }

  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'feedback-cli-')));
    root = join(scratch, 'private-homes');
    executable = join(scratch, 'local-cli.cjs');
    controlPath = join(scratch, 'control.json');
    tracePath = join(scratch, 'trace.ndjson');
    await control();
    const source = `#!${process.execPath}
const fs = require('node:fs/promises');
const path = require('node:path');
const args = process.argv.slice(2);
const valueAfter = flag => args[args.indexOf(flag) + 1];
async function main() {
  const control = JSON.parse(await fs.readFile(${JSON.stringify(controlPath)}, 'utf8'));
  let stdin = '';
  if (args[0] === 'config') for await (const chunk of process.stdin) stdin += chunk;
  await fs.appendFile(${JSON.stringify(tracePath)}, JSON.stringify({args, stdin, cwd: process.cwd(), pid: process.pid, environment: process.env}) + '\\n');
  if (args[0] === 'config') {
    await fs.writeFile(path.join(process.env.HOME, 'stub-profile.json'), JSON.stringify({appId: valueAfter('--app-id')}));
    process.stdout.write(JSON.stringify({ok: true, identity: 'user', data: {}}));
    return;
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    const configured = JSON.parse(await fs.readFile(path.join(process.env.HOME, 'stub-profile.json'), 'utf8'));
    process.stdout.write(JSON.stringify(control.auth ?? {appId: configured.appId, verified: true,
      identities: {user: {status: 'ready', available: true, verified: true, scope: ${JSON.stringify(FEEDBACK_SCOPES.join(' '))}, userName: '同名用户', openId: control.openId ?? 'ou_author'}}}));
    return;
  }
  if (control.mode === 'fail') {
    process.stderr.write(${JSON.stringify(stderrSecret)});
    process.exitCode = 1;
    return;
  }
  if (control.mode === 'hang') {
    process.stderr.write(${JSON.stringify(stderrSecret)});
    setInterval(() => {}, 1000);
    return;
  }
  if (control.mode === 'flood') {
    process.stderr.write('x'.repeat(256001));
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(JSON.stringify({ok: true, identity: 'user', data: {complete: true}}));
}
main().catch(error => {process.stderr.write(error.message); process.exitCode = 1;});
`;
    await writeFile(executable, source, {mode: 0o700});
    await chmod(executable, 0o700);
  });

  afterEach(async () => {
    try {
      await Promise.all(clients.splice(0).map(cli => cli.close()));
      expect(registeredProviderPids()).toEqual([]);
      for (const call of await trace()) expect(alive(call.pid), `stub child ${call.pid} remained alive`).toBe(false);
    } finally {await rm(scratch, {recursive: true, force: true});}
  });

  it('passes configuration secrets only through stdin and gives the actual child a private HOME', async () => {
    for (const name of inheritedSecrets) vi.stubEnv(name, `fake-inherited-${name}`);
    const cli = client();
    await cli.run(actor, ['auth', 'status', '--json', '--verify']);
    await cli.run(actor, ['auth', 'status', '--json', '--verify']);
    const calls = await trace();
    const configuration = calls.filter(call => call.args[0] === 'config');
    expect(configuration).toHaveLength(1);
    expect(configuration[0]?.stdin).toBe(fakeSecret + '\n');
    expect(configuration[0]?.args).toContain('--app-secret-stdin');
    for (const call of calls) {
      expect(call.args).not.toContain(fakeSecret);
      expect(call.args).not.toContain('--app-secret');
      expect(call.environment.HOME).toMatch(new RegExp(`^${root}/[a-f0-9]{64}$`));
      expect(call.environment.USERPROFILE).toBe(call.environment.HOME);
      expect(call.environment.LARKSUITE_CLI_CONFIG_DIR).toBe(join(call.cwd, 'configuration'));
      for (const name of inheritedSecrets) expect(call.environment).not.toHaveProperty(name);
    }
    const configured = configuration[0];
    if (!configured) throw new Error('Missing configuration child');
    expect((await stat(configured.cwd)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(configured.cwd, 'configured.json'), 'utf8')).not.toContain(fakeSecret);
  });

  it('isolates account, Bot registration and credential generations into separate private directories', async () => {
    let credentialSecret = fakeSecret;
    let registrationKey = 'registration-1';
    const cli = client({credential: async input => ({appId: input.appId, appSecret: credentialSecret, registrationKey})});
    const actors = [actor, {...actor, openId: 'ou_sameNameOtherPerson'}, {...actor, appId: 'cli_anotherApp'}, {...actor, botId: 'another-bot'}, {...actor, tenantKey: 'another-tenant'}];
    for (const input of actors) {
      await control({openId: input.openId});
      await cli.run(input, ['auth', 'status', '--json', '--verify']);
    }
    await control();
    credentialSecret = 'test-only-rotated-secret';
    await cli.run(actor, ['auth', 'status', '--json', '--verify']);
    registrationKey = 'registration-2';
    await cli.run(actor, ['auth', 'status', '--json', '--verify']);
    const configurations = (await trace()).filter(call => call.args[0] === 'config');
    expect(configurations).toHaveLength(7);
    expect(new Set(configurations.map(call => call.environment.HOME)).size).toBe(7);
    for (const call of configurations) expect(call.environment.HOME).not.toContain('test-only');
  });

  it.each([status({appId: 'cli_other'}), status({openId: 'ou_sameNameOtherPerson'})])('checks current app and user before the requested data command', async auth => {
    await control({auth});
    await expect(client().run(actor, ['base', '+fixture'])).rejects.toThrow(/不一致/);
    expect((await trace()).map(call => call.args.slice(0, 2))).toEqual([['config', 'init'], ['auth', 'status']]);
  });

  it('clears a partially saved authorization when device completion reports failure', async () => {
    const cli = client();
    await cli.run(actor, ['auth', 'status', '--json', '--verify']);
    const home = (await trace()).find(call => call.args[0] === 'config')?.cwd;
    if (!home) throw new Error('Missing private profile directory');
    await writeFile(join(home, 'authorization.json'), JSON.stringify({state: 'pending', deviceCode: 'fake-private-device-code', expiresAt: Date.now() + 60000}));
    await control({mode: 'fail'});
    await expect(cli.finishAuthorization(actor)).rejects.toThrow();
    const authCalls = (await trace()).filter(call => call.args[0] === 'auth').map(call => call.args[1]);
    expect(authCalls).toEqual(['status', 'login', 'logout']);
  });

  it('finishes authorization twice without reusing the code or logging out the authorized person', async () => {
    const cli = client();
    await cli.run(actor, ['auth', 'status', '--json', '--verify']);
    const home = (await trace()).find(call => call.args[0] === 'config')?.cwd;
    if (!home) throw new Error('Missing private profile directory');
    await writeFile(join(home, 'authorization.json'), JSON.stringify({state: 'pending', deviceCode: 'fake-private-device-code', expiresAt: Date.now() + 60000}));
    await expect(cli.finishAuthorization(actor)).resolves.toMatchObject({openId: actor.openId});
    await expect(cli.finishAuthorization(actor)).resolves.toMatchObject({openId: actor.openId});
    const authCalls = (await trace()).filter(call => call.args[0] === 'auth').map(call => call.args[1]);
    expect(authCalls).toEqual(['status', 'login', 'status', 'status']);
    const persisted = await readFile(join(home, 'authorization.json'), 'utf8');
    expect(persisted).toContain('completed');
    expect(persisted).not.toContain('fake-private-device-code');
  });

  it('rejects missing write scope before any requested data command', async () => {
    await control({auth: {appId: actor.appId, verified: true, identities: {user: {status: 'ready', available: true, verified: true,
      scope: FEEDBACK_SCOPES.filter(scope => scope !== 'base:form:update').join(' '), userName: '同名用户', openId: actor.openId}}}});
    await expect(client().run(actor, ['base', '+fixture'])).rejects.toThrow(/范围不完整/);
    expect((await trace()).map(call => call.args.slice(0, 2))).toEqual([['config', 'init'], ['auth', 'status']]);
  });

  it('rejects changed Bot credentials before launching any child', async () => {
    await expect(client({credential: async () => ({appId: 'cli_wrong', appSecret: fakeSecret, registrationKey: 'registration'})}).run(actor, ['auth', 'status'])).rejects.toThrow(/配置已变化/);
    expect(await trace()).toEqual([]);
  });

  it('proves a guard rejection happened before the form process starts', async () => {
    const cli = client();
    const error = await cli.run(actor, ['base', '+form-submit'], undefined, async () => {throw new Error('revoked');}).catch((error: unknown) => error);
    expect(error).toMatchObject({name: 'FeedbackNotDispatchedError'});
    expect((await trace()).some(call => call.args[1] === '+form-submit')).toBe(false);
  });

  it('proves shutdown during the awaited guard prevented the form process', async () => {
    const cli = client();
    const error = await cli.run(actor, ['base', '+form-submit'], undefined, () => cli.close()).catch((error: unknown) => error);
    expect(error).toMatchObject({name: 'FeedbackNotDispatchedError'});
    expect((await trace()).some(call => call.args[1] === '+form-submit')).toBe(false);
  });

  it('keeps a real form process failure potentially dispatched', async () => {
    await control({mode: 'fail'});
    const error = await client().run(actor, ['base', '+form-submit']).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({name: 'FeedbackNotDispatchedError'});
    expect((await trace()).some(call => call.args[1] === '+form-submit')).toBe(true);
  });

  it('uses the requested working directory only after the isolated account preflight succeeds', async () => {
    const operationDirectory = join(scratch, 'private-operation');
    await mkdir(operationDirectory);
    await expect(client().run(actor, ['base', '+fixture', '--as', 'user'], operationDirectory)).resolves.toMatchObject({ok: true, identity: 'user', data: {complete: true}});
    const calls = await trace();
    expect(calls.map(call => call.args.slice(0, 2))).toEqual([['config', 'init'], ['auth', 'status'], ['base', '+fixture']]);
    expect(calls[2]?.cwd).toBe(operationDirectory);
    expect(calls[2]?.environment.HOME).toBe(calls[0]?.environment.HOME);
    expect(calls[1]?.cwd).toBe(calls[0]?.environment.HOME);
  });

  it('times out and confirms the real child has exited without returning sensitive stderr', async () => {
    await control({mode: 'hang'});
    const cli = client({timeoutMs: 500});
    await expect(cli.run(actor, ['base', '+hang'])).rejects.toThrow(/超时/);
    const command = (await trace()).find(call => call.args[1] === '+hang');
    if (!command) throw new Error('Timed out before exercising the waiting child');
    expect(alive(command.pid)).toBe(false);
    expect(registeredProviderPids()).toEqual([]);
  });

  it('close cancels an active child and prevents later launches', async () => {
    await control({mode: 'hang'});
    const cli = client();
    const pending = cli.run(actor, ['base', '+hang']).then(value => ({value}), (error: unknown) => ({error}));
    await expect.poll(async () => (await trace()).some(call => call.args[1] === '+hang'), {timeout: 3000}).toBe(true);
    await cli.close();
    const outcome = await pending;
    expect('error' in outcome && outcome.error).toBeInstanceOf(Error);
    if ('error' in outcome && outcome.error instanceof Error) expect(outcome.error.message).toMatch(/取消/);
    const callsBeforeRetry = (await trace()).length;
    await expect(cli.run(actor, ['auth', 'status'])).rejects.toThrow();
    expect(await trace()).toHaveLength(callsBeforeRetry);
    expect(registeredProviderPids()).toEqual([]);
  });

  it('rejects excessive child output and closes its actual process', async () => {
    await control({mode: 'flood'});
    await expect(client().run(actor, ['base', '+flood'])).rejects.toThrow(/内容过大/);
    const command = (await trace()).find(call => call.args[1] === '+flood');
    if (!command) throw new Error('Missing flood child');
    expect(alive(command.pid)).toBe(false);
  });

  it('keeps failed CLI stderr out of thrown errors and parent output', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await control({mode: 'fail'});
    const outcome = await client().run(actor, ['base', '+failure']).then(value => ({value}), (error: unknown) => ({error}));
    expect('error' in outcome && outcome.error).toBeInstanceOf(Error);
    if ('error' in outcome && outcome.error instanceof Error) {
      expect(outcome.error.message).toMatch(/飞书请求未完成/);
      expect(outcome.error.message).not.toContain(stderrSecret);
      expect(outcome.error.stack).not.toContain(stderrSecret);
    }
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });
});
