import { lstat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  LocalFileSafetyError,
  readBoundedUtf8FileStrict,
  withTimeout,
} from './bounded-local-files';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BOTS = 128;
const MAX_PROJECTS = 4_096;
const MAX_SESSIONS = 32_768;
const MAX_SETTING_NODES = 100_000;
const MAX_SETTING_PATH_CHARACTERS = 8 * 1024 * 1024;
const appId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const named = z.string().trim().min(1).max(256);
const identity = z.string().max(256).refine((value) => value.trim().length > 0);
const tenant = z.enum(['feishu', 'lark']);
const secret = z.union([
  z.string().min(1).max(64 * 1024),
  z.object({ source: z.enum(['env', 'file', 'exec']), id: z.string().min(1).max(4_096), provider: z.string().max(256).optional() }).passthrough(),
]);
const configSchema = z.object({
  accounts: z.object({ app: z.object({ id: appId, tenant, secret }).passthrough() }).passthrough(),
  preferences: z.object({
    access: z.object({
      ownerOpenId: identity.optional(),
      admins: z.array(identity).max(4_096).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
const botSchema = z.object({
  name: named,
  appId,
  tenant,
  botName: z.string().trim().max(256).optional(),
  active: z.boolean().optional(),
  createdAt: z.number().finite().optional(),
}).passthrough();
const registrySchema = z.object({
  version: z.literal(1),
  current: appId.optional(),
  bots: z.array(botSchema).max(MAX_BOTS),
}).passthrough();
const projectSchema = z.object({
  name: named,
  chatId: named,
  cwd: z.string().trim().min(1).max(4_096),
  blank: z.boolean().optional(),
  createdAt: z.number().finite().optional(),
  branch: z.string().max(256).optional(),
  origin: z.enum(['created', 'joined']).optional(),
  addedBy: z.string().max(256).optional(),
  pendingPolicy: z.enum(['steer', 'queue']).optional(),
  kind: z.enum(['multi', 'single']).optional(),
  noMention: z.boolean().optional(),
  allowedUsers: z.array(identity).max(4_096).optional(),
  mode: z.enum(['qa', 'write', 'full']).optional(),
  guestMode: z.enum(['qa', 'write', 'full']).optional(),
  network: z.boolean().optional(),
  autoCompact: z.boolean().optional(),
  backend: z.string().max(128).optional(),
  defaultModel: z.string().max(256).optional(),
  defaultEffort: z.string().max(256).optional(),
}).passthrough();
const projectStoreSchema = z.object({ version: z.literal(1), projects: z.array(projectSchema).max(MAX_PROJECTS) }).passthrough();
const sessionSchema = z.object({
  threadId: identity.transform((value) => value.trim()),
  chatId: identity.transform((value) => value.trim()),
  cwd: z.string().trim().max(4_096).refine(isAbsolute),
  sessionId: identity.transform((value) => value.trim()).optional(),
  codexThreadId: identity.transform((value) => value.trim()).optional(),
  backend: appId.optional(),
  model: z.string().max(256).optional(),
  effort: z.string().max(256).optional(),
  summary: z.string().max(64 * 1024).optional(),
  titleJobKey: z.string().max(256).optional(),
  lastSeenAt: z.number().finite().optional(),
  createdAt: z.number().finite().optional(),
  updatedAt: z.number().finite().optional(),
}).passthrough().refine((value) => value.sessionId !== undefined || value.codexThreadId !== undefined);
const sessionStoreSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  sessions: z.array(sessionSchema).max(MAX_SESSIONS),
  titleJobs: z.array(z.unknown()).max(MAX_SESSIONS).optional(),
}).passthrough();

export interface SourceInspectionOptions {
  readonly sourceDir: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly readText?: typeof readBoundedUtf8FileStrict;
  readonly inspectPath?: typeof lstat;
}

export interface SourceProject {
  readonly name: string;
  readonly chatId: string;
  readonly sessionCount: number;
  readonly settingCount: number;
  readonly settings: readonly string[];
}

export interface SourceSession {
  readonly threadId: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly backend: string;
  readonly settings: readonly string[];
}

export interface SourceBot {
  readonly appId: string;
  readonly name: string;
  readonly tenant: z.infer<typeof tenant>;
  readonly enabled: boolean;
  readonly projects: readonly SourceProject[];
  readonly sessions: readonly SourceSession[];
  readonly sessionCount: number;
  readonly settingCount: number;
  readonly settings: readonly string[];
}

export type SourceInspection =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly problem: 'source-path' | 'unsafe-path' | 'missing-file' | 'unsafe-file' | 'too-large' | 'invalid-encoding' | 'invalid-json' | 'invalid-schema' | 'timed-out'; readonly file: string }
  | { readonly kind: 'ready'; readonly format: 'multi-bot-v1' | 'legacy-flat'; readonly currentAppId?: string; readonly bots: readonly SourceBot[]; readonly counts: Readonly<{ bots: number; groups: number; sessions: number; settings: number }> };

class InvalidSource extends Error {
  constructor(readonly problem: Extract<SourceInspection, { kind: 'invalid' }>['problem'], readonly file: string) {
    super(problem);
  }
}

const projectSettings = ['noMention', 'allowedUsers', 'mode', 'guestMode', 'network', 'autoCompact', 'backend', 'defaultModel', 'defaultEffort'] as const;

export async function inspectBridgeSource(options: SourceInspectionOptions): Promise<SourceInspection> {
  const { sourceDir } = options;
  if (!isAbsolute(sourceDir)) return { kind: 'invalid', problem: 'source-path', file: '.' };
  const root = resolve(sourceDir);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const inspectPath = options.inspectPath ?? lstat;
  const readText = options.readText ?? readBoundedUtf8FileStrict;

  async function checkPath(path: string, file: string, expect: 'file' | 'directory'): Promise<boolean> {
    const normalized = resolve(path);
    const inside = relative(root, normalized);
    if (inside.startsWith(`..${sep}`) || inside === '..') throw new InvalidSource('unsafe-path', file);
    const segments = normalized.slice(parse(normalized).root.length).split(sep).filter(Boolean);
    let component = parse(normalized).root;
    for (const [index, segment] of segments.entries()) {
      component = join(component, segment);
      let metadata;
      try {
        metadata = await withTimeout(inspectPath(component), timeoutMs, options.signal);
      } catch (error) {
        if (isMissing(error) && index === segments.length - 1) return false;
        if (error instanceof LocalFileSafetyError && error.problem === 'timed-out') throw new InvalidSource('timed-out', file);
        throw new InvalidSource('unsafe-path', file);
      }
      if (metadata.isSymbolicLink()) throw new InvalidSource('unsafe-path', file);
      if (index < segments.length - 1 && !metadata.isDirectory()) throw new InvalidSource('unsafe-path', file);
      if (index === segments.length - 1 && !(expect === 'directory' ? metadata.isDirectory() : metadata.isFile())) {
        throw new InvalidSource(expect === 'file' ? 'unsafe-file' : 'unsafe-path', file);
      }
    }
    return true;
  }

  async function readTextFile(file: string, maxBytes: number, required = false): Promise<string | undefined> {
    const path = join(root, file);
    if (!await checkPath(path, file, 'file')) {
      if (required) throw new InvalidSource('missing-file', file);
      return undefined;
    }
    let contents: string;
    try {
      contents = await readText(path, { maxBytes, timeoutMs, signal: options.signal });
      if (!await checkPath(path, file, 'file')) throw new InvalidSource('missing-file', file);
    } catch (error) {
      if (error instanceof InvalidSource) throw error;
      if (error instanceof LocalFileSafetyError) {
        const problem = error.problem === 'too-large' || error.problem === 'invalid-encoding' || error.problem === 'timed-out'
          ? error.problem : 'unsafe-file';
        throw new InvalidSource(problem, file);
      }
      throw new InvalidSource('unsafe-file', file);
    }
    return contents;
  }

  async function readJson(file: string, required = false): Promise<unknown | undefined> {
    const contents = await readTextFile(file, MAX_FILE_BYTES, required);
    if (contents === undefined) return undefined;
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new InvalidSource('invalid-json', file);
    }
  }

  function parseFile<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new InvalidSource('invalid-schema', file);
    return parsed.data;
  }

  try {
    if (!await checkPath(root, '.', 'directory')) return { kind: 'not-found' };
    const registryValue = await readJson('bots.json');
    const format = registryValue === undefined ? 'legacy-flat' : 'multi-bot-v1';
    const flatValue = registryValue === undefined ? await readJson('config.json') : undefined;
    if (registryValue === undefined && flatValue === undefined) return { kind: 'not-found' };
    const registry = registryValue === undefined
      ? undefined : parseFile(registrySchema, registryValue, 'bots.json');
    const flat = flatValue === undefined ? undefined : parseFile(configSchema, flatValue, 'config.json');
    const entries = registry?.bots ?? (flat === undefined ? [] : [{ name: 'default', appId: flat.accounts.app.id, tenant: flat.accounts.app.tenant, active: true }]);
    if (entries.length === 0) return { kind: 'not-found' };
    if (registry?.current !== undefined && !entries.some((bot) => bot.appId === registry.current)) {
      throw new InvalidSource('invalid-schema', 'bots.json');
    }
    if (new Set(entries.map((bot) => bot.appId)).size !== entries.length) throw new InvalidSource('invalid-schema', 'bots.json');
    if (format === 'multi-bot-v1' && entries.length > 0 && !await checkPath(join(root, 'bots'), 'bots', 'directory')) {
      throw new InvalidSource('missing-file', 'bots');
    }

    const bots: SourceBot[] = [];
    const activeConfigured = entries.some((bot) => bot.active !== undefined);
    let groups = 0;
    let sessions = 0;
    let settings = 0;
    for (const entry of entries) {
      const base = format === 'legacy-flat' ? '' : join('bots', entry.appId);
      if (base && !await checkPath(join(root, base), base, 'directory')) throw new InvalidSource('missing-file', base);
      const configFile = join(base, 'config.json');
      const config = parseFile(configSchema, base ? await readJson(configFile, true) : flatValue, configFile);
      if (config.accounts.app.id !== entry.appId || config.accounts.app.tenant !== entry.tenant) {
        throw new InvalidSource('invalid-schema', configFile);
      }
      const projectFile = join(base, 'projects.json');
      const sessionFile = join(base, 'sessions.json');
      const commentFile = join(base, 'comment-instructions.md');
      const rawProjects = await readJson(projectFile);
      const rawSessions = await readJson(sessionFile);
      const commentInstructions = await readTextFile(commentFile, 1024 * 1024);
      const projects = rawProjects === undefined ? [] : parseFile(projectStoreSchema, rawProjects, projectFile).projects;
      const boundSessions = rawSessions === undefined ? [] : parseFile(sessionStoreSchema, rawSessions, sessionFile).sessions;
      if (groups + projects.length > 1_024) throw new InvalidSource('too-large', projectFile);
      if (sessions + boundSessions.length > MAX_SESSIONS) throw new InvalidSource('too-large', sessionFile);
      if (new Set(boundSessions.map((session) => session.threadId)).size !== boundSessions.length) {
        throw new InvalidSource('invalid-schema', sessionFile);
      }
      const sessionsByChat = new Map<string, number>();
      for (const session of boundSessions) {
        sessionsByChat.set(session.chatId, (sessionsByChat.get(session.chatId) ?? 0) + 1);
      }
      const projectSummaries: SourceProject[] = projects.map((project) => {
        const projectSettingNames = projectSettings.filter((key) => project[key] !== undefined);
        return Object.freeze({
          name: project.name,
          chatId: project.chatId,
          sessionCount: sessionsByChat.get(project.chatId) ?? 0,
          settingCount: projectSettingNames.length,
          settings: Object.freeze(projectSettingNames),
        });
      });
      const settingNames = listSettings(config.preferences, configFile);
      if (commentInstructions !== undefined) settingNames.push('comment-instructions.md');
      const sourceSessions: SourceSession[] = boundSessions.map((session) => {
        const sessionId = session.sessionId ?? session.codexThreadId;
        if (sessionId === undefined) throw new InvalidSource('invalid-schema', sessionFile);
        return Object.freeze({
          threadId: session.threadId,
          chatId: session.chatId,
          sessionId,
          backend: session.backend ?? 'codex-appserver',
          settings: Object.freeze([...(session.model === undefined ? [] : ['model']), ...(session.effort === undefined ? [] : ['effort'])]),
        });
      });
      const sessionSettingCount = sourceSessions.reduce((total, session) => total + session.settings.length, 0);
      bots.push(Object.freeze({
        appId: entry.appId,
        name: 'botName' in entry && typeof entry.botName === 'string' && entry.botName ? entry.botName : entry.name,
        tenant: entry.tenant,
        enabled: activeConfigured ? entry.active === true : entry.appId === registry?.current,
        projects: Object.freeze(projectSummaries),
        sessions: Object.freeze(sourceSessions),
        sessionCount: boundSessions.length,
        settingCount: settingNames.length,
        settings: Object.freeze(settingNames),
      }));
      groups += projects.length;
      sessions += boundSessions.length;
      settings += settingNames.length + sessionSettingCount
        + projectSummaries.reduce((total, project) => total + project.settingCount, 0);
    }
    return Object.freeze({
      kind: 'ready',
      format,
      ...(format === 'legacy-flat' ? { currentAppId: entries[0]?.appId } : registry?.current === undefined ? {} : { currentAppId: registry.current }),
      bots: Object.freeze(bots),
      counts: Object.freeze({ bots: bots.length, groups, sessions, settings }),
    });
  } catch (error) {
    if (error instanceof InvalidSource) return { kind: 'invalid', problem: error.problem, file: error.file };
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function listSettings(value: unknown, file: string): string[] {
  if (value === undefined) return [];
  const pending: Array<{ value: unknown; path: string }> = [];
  let enqueued = 0;
  let pathCharacters = 0;
  function enqueue(value: unknown, key: string, parent?: string): void {
    if (enqueued === MAX_SETTING_NODES) throw new InvalidSource('too-large', file);
    const length = key.length + (parent === undefined ? 0 : parent.length + 1);
    if (pathCharacters + length > MAX_SETTING_PATH_CHARACTERS) throw new InvalidSource('too-large', file);
    enqueued += 1;
    pathCharacters += length;
    const path = parent === undefined ? key : `${parent}.${key}`;
    pending.push({ value, path });
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child: unknown = Reflect.get(value, key);
      if (key === 'access' && typeof child === 'object' && child !== null && !Array.isArray(child)) {
        for (const name in child) {
          if (Object.hasOwn(child, name) && name !== 'ownerOpenId' && name !== 'admins') {
            enqueue(Reflect.get(child, name), name, 'access');
          }
        }
      } else {
        enqueue(child, key);
      }
    }
  } else {
    enqueue(value, 'preferences');
  }
  const names: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (Array.isArray(current.value) || typeof current.value !== 'object' || current.value === null) {
      names.push(current.path);
    } else {
      let empty = true;
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;
        empty = false;
        enqueue(Reflect.get(current.value, key), key, current.path);
      }
      if (empty) names.push(current.path);
    }
  }
  return names.sort();
}
