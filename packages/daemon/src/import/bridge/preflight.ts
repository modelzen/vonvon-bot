import { execFile } from 'node:child_process';
import { access, lstat, readlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { inspectLocalPath, LocalFileSafetyError, readLocalText, withTimeout } from './bounded-local-files';
import { canDecryptLegacySecret, loadLegacyKeystoreKey } from './legacy-keystore';
import {classifyHookCommand} from './hooks';
import {parseBridgeServiceState} from './service-state';

// Schema bounds and the read-only source inspection are adapted from #226.
const appId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().trim().min(1).max(4096);
const tier = z.enum(['qa', 'write', 'full']);
const reference = z.object({ source: z.enum(['env', 'file', 'exec']), id: text, provider: text.optional() });
const configSchema = z.object({
  accounts: z.object({ app: z.object({ id: appId, tenant: z.enum(['feishu', 'lark']), secret: z.union([text, reference]) }) }),
});
const registrySchema = z.object({ version: z.literal(1), current: appId.optional(), bots: z.array(z.object({
  appId, name: text, tenant: z.enum(['feishu', 'lark']), botName: z.string().max(256).optional(), active: z.boolean().optional(),
})).max(128) });
const projectSchema = z.object({ name: text, chatId: text, cwd: text.refine(isAbsolute),
  mode: tier.optional(), guestMode: tier.nullable().optional(), noMention: z.boolean().optional(), kind: z.enum(['multi', 'single']).optional(),
  network: z.boolean().optional(), allowedUsers: z.array(text).max(4096).optional(), backend: text.optional(),
  autoCompact: z.boolean().optional(), defaultModel: text.optional(), defaultEffort: text.optional(),
});
const projectsSchema = z.object({ version: z.literal(1), projects: z.array(projectSchema).max(4096) });
const sessionsSchema = z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]), sessions: z.array(z.object({
  threadId: text, chatId: text, cwd: text.refine(isAbsolute), sessionId: text.optional(), codexThreadId: text.optional(),
}).refine(value => value.sessionId !== undefined || value.codexThreadId !== undefined)).max(32768) });
const envelopeSchema = z.object({ iv: z.string(), data: z.string(), tag: z.string() });
const secretsSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), envelopeSchema) });
export const upgradeMessage = '这个 bridge 还是旧的目录格式。先照常启动一次原来的 bridge，让它升级目录，再回来重试导入';
export type CheckState = 'present' | 'missing' | 'invalid' | 'unknown';
export type RunningState = 'running' | 'stopped' | 'unknown';
export interface BotInspection {
  readonly appId: string;
  readonly name: string;
  readonly groups: number | null;
  readonly directories: readonly { readonly index: number; readonly state: CheckState }[];
  readonly secret: 'decryptable' | 'plaintext' | 'missing' | 'invalid' | 'cannot-decrypt' | 'external-reference' | 'unknown';
  readonly hooks: { readonly claude: HookState; readonly codex: HookState };
  readonly running: RunningState;
  readonly problems: readonly { readonly file: string; readonly code: string }[];
}
export type HookState = 'installed' | 'absent' | 'needs-repair' | 'unknown';
export type SourceInspection =
  | { readonly kind: 'unsupported-platform' | 'not-found' }
  | { readonly kind: 'upgrade-required'; readonly message: string }
  | { readonly kind: 'invalid'; readonly file: string; readonly problem: string }
  | { readonly kind: 'inspected'; readonly bots: readonly BotInspection[]; readonly service: RunningState; readonly bundledCodex: CheckState };
export interface SourceInspectionOptions {
  readonly sourceDir: string;
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  /** Read-only native seams: tests must never query the owner's services. */
  readonly command?: (command: string, args: readonly string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
}

function problem(error: unknown): string {
  if (error instanceof LocalFileSafetyError) return error.problem;
  if (error instanceof SyntaxError) return 'invalid-json';
  if (error instanceof z.ZodError) return 'invalid-schema';
  return 'unreadable';
}
async function json(root: string, file: string, signal?: AbortSignal): Promise<unknown> {
  const contents = await readLocalText(root, join(root, file), signal);
  return contents === undefined ? undefined : JSON.parse(contents) as unknown;
}
const nativeCommand: NonNullable<SourceInspectionOptions['command']> = (command, args) => new Promise((done) => {
  execFile(command, [...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    done({ status: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr });
  });
});

/** A fresh read on every call. This report is neither a migration journal nor a snapshot fence. */
export async function inspectBridgeSource(options: SourceInspectionOptions): Promise<SourceInspection> {
  if ((options.platform ?? process.platform) !== 'darwin') return { kind: 'unsupported-platform' };
  if (!isAbsolute(options.sourceDir) || !isAbsolute(options.homeDir)) return { kind: 'invalid', file: '.', problem: 'source-path' };
  const root = resolve(options.sourceDir);
  const home = resolve(options.homeDir);
  let file = '.';
  try {
    const directory = await inspectLocalPath(root, root, options.signal);
    if (!directory) return { kind: 'not-found' };
    if (!directory.isDirectory()) return { kind: 'invalid', file, problem: 'not-directory' };
    file = 'bots.json';
    const raw = await json(root, file, options.signal);
    if (raw === undefined) {
      for (const legacy of ['processes.json', 'config.json']) {
        if (await inspectLocalPath(root, join(root, legacy), options.signal)) return { kind: 'upgrade-required', message: upgradeMessage };
      }
      return { kind: 'not-found' };
    }
    const registry = registrySchema.parse(raw);
    if (new Set(registry.bots.map(bot => bot.appId)).size !== registry.bots.length
      || (registry.current !== undefined && !registry.bots.some(bot => bot.appId === registry.current))) {
      return { kind: 'invalid', file, problem: 'inconsistent-registry' };
    }
    const run = async (command: string, args: readonly string[]) => withTimeout((options.command ?? nativeCommand)(command, args), 2500, options.signal);
    const service = await inspectService(run);
    const hooks = await readHooks(home, options.signal);
    const bundledCodex = await inspectBundledCodex(root, options.signal);
    const bots: BotInspection[] = [];
    const active = registry.bots.some(bot => bot.active !== undefined) ? registry.bots.filter(bot => bot.active) : registry.bots.filter(bot => bot.appId === registry.current);
    for (const entry of registry.bots) {
      const base = join('bots', entry.appId);
      const problems: { file: string; code: string }[] = [];
      let groups: number | null = null;
      const directories: { index: number; state: CheckState }[] = [];
      let secret: BotInspection['secret'] = 'unknown';
      try {
        const config = configSchema.parse(await json(root, join(base, 'config.json'), options.signal));
        if (config.accounts.app.id !== entry.appId || config.accounts.app.tenant !== entry.tenant) throw new Error('inconsistent-config');
        secret = await inspectSecret(root, config.accounts.app.secret, options.signal);
      } catch (error) { problems.push({ file: join(base, 'config.json'), code: error instanceof Error && error.message === 'inconsistent-config' ? error.message : problem(error) }); }
      try {
        const rawProjects = await json(root, join(base, 'projects.json'), options.signal);
        const projects = rawProjects === undefined ? [] : projectsSchema.parse(rawProjects).projects;
        if (new Set(projects.map(project => project.chatId)).size !== projects.length) throw new Error('duplicate-group');
        groups = projects.length;
        for (const [index, project] of projects.entries()) {
          let state: CheckState;
          try {
            const metadata = await inspectLocalPath(project.cwd, project.cwd, options.signal);
            state = !metadata ? 'missing' : metadata.isDirectory() ? 'present' : 'invalid';
          } catch { state = 'invalid'; }
          directories.push({ index, state });
        }
      } catch (error) { problems.push({ file: join(base, 'projects.json'), code: problem(error) }); }
      try {
        const rawSessions = await json(root, join(base, 'sessions.json'), options.signal);
        if (rawSessions !== undefined) {
          const sessions = sessionsSchema.parse(rawSessions).sessions;
          if (new Set(sessions.map(session => session.threadId)).size !== sessions.length) throw new Error('duplicate-session');
        }
        await readLocalText(root, join(root, base, 'comment-instructions.md'), options.signal);
      } catch (error) { problems.push({ file: join(base, 'sessions.json'), code: problem(error) }); }
      const running = await inspectBotProcess(root, base, entry.appId, run, options.signal, active.length === 1 && active[0]?.appId === entry.appId);
      bots.push({ appId: entry.appId, name: entry.botName || entry.name, groups, directories, secret,
        hooks: { claude: hookFor(hooks.claude, entry.appId, 'claude', registry.current === entry.appId), codex: hookFor(hooks.codex, entry.appId, 'codex', registry.current === entry.appId) }, running, problems });
    }
    return { kind: 'inspected', bots, service, bundledCodex };
  } catch (error) { return { kind: 'invalid', file, problem: problem(error) }; }
}

async function inspectSecret(root: string, secret: z.infer<typeof configSchema>['accounts']['app']['secret'], signal?: AbortSignal): Promise<BotInspection['secret']> {
  if (typeof secret === 'string') return 'plaintext';
  // Never resolve env/file/foreign exec providers or execute even the bridge getter.
  if (secret.source !== 'exec' || secret.provider !== 'bridge') return 'external-reference';
  let store: z.infer<typeof secretsSchema>;
  try {
    const raw = await json(root, 'secrets.enc', signal);
    if (raw === undefined) return 'missing';
    store = secretsSchema.parse(raw);
  } catch { return 'invalid'; }
  const envelope = Object.hasOwn(store.entries, secret.id) ? store.entries[secret.id] : undefined;
  if (!envelope) return 'missing';
  try {
    if (!await inspectLocalPath(root, join(root, '.keystore.salt'), signal)) return 'missing';
    const key = await loadLegacyKeystoreKey(root, signal);
    if (key.state !== 'ready') return key.state;
    try { return canDecryptLegacySecret(key.key, envelope) ? 'decryptable' : 'cannot-decrypt'; }
    finally { key.key.fill(0); }
  } catch { return 'invalid'; }
}

type Run = NonNullable<SourceInspectionOptions['command']>;
async function inspectService(run: Run): Promise<RunningState> {
  try {
    const result = await run('/bin/launchctl', ['print', `gui/${process.getuid?.()}/ai.feishu-codex-bridge.bot`]);
    const state = parseBridgeServiceState(result);
    if (!state) return 'unknown';
    // A stopping job can still hold Bot locks. Do not report it as a manually started process.
    return state.running || state.stopping || state.starting ? 'running' : 'stopped';
  } catch { return 'unknown'; }
}
async function inspectBotProcess(root: string, base: string, appId: string, run: Run, signal?: AbortSignal, allowUnscoped = false): Promise<RunningState> {
  try {
    const raw = await json(root, join(base, 'processes.json'), signal);
    if (raw === undefined) return 'stopped';
    const owner = z.object({ pid: z.number().int().positive(), appId: z.literal(appId), startedAt: z.number().finite().positive().optional() }).parse(raw);
    const result = await run('/bin/ps', ['-p', String(owner.pid), '-o', 'etime=,command=']);
    if (result.status === 1 && result.stdout.trim() === '') return 'stopped';
    if (result.status !== 0) return 'unknown';
    const match = /^\s*((?:\d+-)?\d+:\d+(?::\d+)?)\s+(.+)$/.exec(result.stdout.trim());
    if (!match) return 'unknown';
    const [clock, command] = [match[1]!, match[2]!];
    const days = clock.includes('-') ? Number(clock.split('-')[0]) : 0;
    const units = clock.slice(clock.lastIndexOf('-') + 1).split(':').map(Number);
    const seconds = units.reduce((total, unit) => total * 60 + unit, 0) + days * 86400;
    if (owner.startedAt !== undefined && Date.now() - seconds * 1000 > owner.startedAt + 15000) return 'stopped';
    if (!/(?:^|[\s/"'])feishu-codex-bridge(?:\.mjs)?["']?\s+run(?:\s|$)/.test(command)) return 'unknown';
    const bot = /(?:^|\s)--bot\s+["']?([A-Za-z0-9_-]+)/.exec(command)?.[1];
    return bot === appId || (bot === undefined && allowUnscoped && !command.includes('--bot')) ? 'running' : 'unknown';
  } catch { return 'unknown'; }
}

const hookSchema = z.object({ hooks: z.record(z.string(), z.array(z.object({
  hooks: z.array(z.object({ type: z.string().optional(), command: z.string().optional() })).optional(),
}))).optional() });
type HookInput = { value: z.infer<typeof hookSchema>; enabled: boolean } | undefined;
async function readHooks(home: string, signal?: AbortSignal): Promise<{ claude: HookInput; codex: HookInput }> {
  const results: { claude: HookInput; codex: HookInput } = { claude: undefined, codex: undefined };
  for (const agent of ['claude', 'codex'] as const) {
    try {
      const raw = await json(home, agent === 'claude' ? '.claude/settings.json' : '.codex/hooks.json', signal);
      const value = hookSchema.parse(raw === undefined ? {} : raw);
      let enabled = true;
      if (agent === 'codex') {
        const toml = await readLocalText(home, join(home, '.codex/config.toml'), signal) ?? '';
        const config = z.object({ features: z.object({ hooks: z.boolean().optional() }).optional() })
          .parse(parseToml(toml, { integersAsBigInt: 'asNeeded' }));
        enabled = config.features?.hooks === true;
      }
      results[agent] = { value, enabled };
    } catch { /* Unknown is preserved; unreadable is never reported as absent. */ }
  }
  return results;
}
function hookFor(input: HookInput, appId: string, agent: 'claude' | 'codex', current = false): HookState {
  if (!input) return 'unknown';
  const events = new Set<string>();
  for (const [event, groups] of Object.entries(input.value.hooks ?? {})) {
    for (const group of groups) for (const hook of group.hooks ?? []) {
      if (hook.type !== undefined && hook.type !== 'command') continue;
      const command = hook.command ?? '';
      if (command.includes('agent2lark-hook')) continue;
      // Only known bridge entry points; unrelated commands containing "hook" do not count.
      const bridge = classifyHookCommand(command) !== 'other';
      if (!bridge || !new RegExp(`(?:^|\\s)--agent\\s+${agent}(?:\\s|$)`).test(command)) continue;
      const bot = /(?:^|\s)--bot\s+(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))(?:\s|$)/.exec(command);
      if (bot ? (bot[1] ?? bot[2] ?? bot[3]) === appId : current) events.add(event);
    }
  }
  if (events.size === 0) return 'absent';
  return input.enabled && events.has('PermissionRequest') && events.has('Stop') ? 'installed' : 'needs-repair';
}
async function inspectBundledCodex(root: string, signal?: AbortSignal): Promise<CheckState> {
  const base = join(root, 'codex-cli');
  const bin = join(base, 'node_modules', '.bin');
  try {
    if (!await inspectLocalPath(root, bin, signal)) return 'missing';
    const path = join(bin, 'codex');
    let metadata;
    try { metadata = await withTimeout(lstat(path), 2000, signal); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'; throw error; }
    let target = path;
    if (metadata.isSymbolicLink()) {
      // npm's .bin link is expected, but no destination outside this private install.
      const link = await withTimeout(readlink(path), 2000, signal);
      target = resolve(bin, link);
      const inside = relative(base, target);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return 'invalid';
      target = await withTimeout(realpath(target), 2000, signal);
      const actual = relative(base, target);
      if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) return 'invalid';
      metadata = await inspectLocalPath(base, target, signal);
    }
    if (!metadata?.isFile()) return 'invalid';
    await withTimeout(access(target, constants.X_OK), 2000, signal);
    return 'present';
  } catch { return 'invalid'; }
}
