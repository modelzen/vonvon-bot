import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SessionProfile } from '../src/agent/session-profile';
import {
  executionSessionProfile,
  botBackendId,
  groupBackendId,
  resolveCommentsExecution,
  resolveExecution,
  resolveModelPreference,
  type GroupLayer,
} from '../src/config/execution';
import type { AppPreferences } from '../src/config/schema';

// s36d2: one resolver for what a session runs with (product.md 3.2). A group's tier, network and
// backend are its own (old rows: full access, no network, Codex); the bot defaults are for places
// with no group; the bot's model counts only on the bot's own backend.

const CODEX = 'codex-appserver';
const CLAUDE = 'claude-agent';
const group = (extra: Partial<GroupLayer> = {}): GroupLayer => ({ cwd: '/work/g', ...extra });
const bot = (extra: AppPreferences = {}): AppPreferences => ({
  defaults: { permission: 'write', network: true },
  ...extra,
});

describe('a group', () => {
  it('keeps full access and no network on an old row, whatever the bot default says', () => {
    const r = resolveExecution({ bot: bot({ defaults: { permission: 'qa', network: true, backend: CLAUDE } }), group: group() });
    expect(r.permission).toBe('full');
    expect(r.network).toBe(false);
    expect(r.sources).toMatchObject({ permission: 'builtin', network: 'builtin' });
  });

  it('uses its own tier and network', () => {
    const r = resolveExecution({ bot: bot(), group: group({ mode: 'qa', network: true }) });
    expect(r).toMatchObject({ permission: 'qa', network: true, sources: { permission: 'group', network: 'group' } });
  });

  it('runs Codex when it has no backend, even with a Claude bot default', () => {
    const r = resolveExecution({ bot: bot({ defaults: { backend: CLAUDE } }), group: group() });
    expect(r.backend).toBe(CODEX);
    expect(r.sources.backend).toBe('builtin');
    expect(resolveExecution({ group: group() }).backend).toBe(CODEX);
  });

  it('uses its own backend, and falls back to Codex for one no longer in the catalog', () => {
    expect(resolveExecution({ bot: bot(), group: group({ backend: CLAUDE }) })).toMatchObject({ backend: CLAUDE, sources: { backend: 'group' } });
    expect(groupBackendId({ backend: 'claude-sdk' })).toBe(CODEX);
    expect(groupBackendId(undefined)).toBe(CODEX);
  });

  it("works in its own directory only, without the bot's other workspaces", () => {
    const b = bot({ directories: { workspaces: { primary: '/bot', additional: ['/bot/extra'] } } });
    expect(resolveExecution({ bot: b, group: group() }).workspaces).toEqual({ primary: '/work/g', additional: [] });
    const own = group({ directories: { workspaces: { primary: '/work/g', additional: ['/work/more'] } } });
    expect(resolveExecution({ bot: b, group: own }).workspaces).toEqual({ primary: '/work/g', additional: ['/work/more'] });
  });

  it("inherits the bot's repositories unless it set its own; [] clears them", () => {
    const b = bot({ directories: { repositories: ['/repo/a'] } });
    expect(resolveExecution({ bot: b, group: group() })).toMatchObject({ repositories: ['/repo/a'], sources: { repositories: 'bot' } });
    expect(resolveExecution({ bot: b, group: group({ directories: { repositories: [] } }) })).toMatchObject({ repositories: [], sources: { repositories: 'group' } });
    expect(resolveExecution({ bot: b, group: group({ directories: { repositories: ['/repo/b'] } }) }).repositories).toEqual(['/repo/b']);
    expect(resolveExecution({ group: group() }).repositories).toEqual([]);
  });

  it('takes 运行中来了消息 from the group, else the bot, else steer, not by backend', () => {
    expect(resolveExecution({ bot: bot({ pendingPolicy: 'queue' }), group: group() }).pendingPolicy).toBe('queue');
    expect(resolveExecution({ bot: bot({ pendingPolicy: 'queue' }), group: group({ pendingPolicy: 'steer' }) }).pendingPolicy).toBe('steer');
    expect(resolveExecution({ bot: bot(), group: group() })).toMatchObject({ pendingPolicy: 'steer', sources: { pendingPolicy: 'builtin' } });
    // A Claude thread queues by itself (supportsSteer); the setting stays what the group says.
    expect(resolveExecution({ bot: bot(), group: group({ backend: CLAUDE }) }).pendingPolicy).toBe('steer');
  });
});

describe('the model a new session starts from', () => {
  it("is the group's default on the group's backend", () => {
    const g = group({ backend: CLAUDE, defaultModel: 'opus', defaultEffort: 'high', defaultModelCustom: true });
    expect(resolveModelPreference({ bot: bot(), group: g }, CLAUDE)).toEqual({ model: 'opus', effort: 'high', custom: true, source: 'group' });
  });

  it("is not the group's default on another backend (an old session on the record's backend)", () => {
    const g = group({ backend: CLAUDE, defaultModel: 'opus', defaultModelCustom: true });
    expect(resolveModelPreference({ bot: bot(), group: g }, CODEX)).toBeUndefined();
  });

  it("is the bot's default only on the bot's own backend", () => {
    const b = bot({ defaults: { backend: CLAUDE, model: { kind: 'custom', id: 'sonnet-x', effort: 'high' } } });
    expect(resolveModelPreference({ bot: b, group: group({ backend: CLAUDE }) }, CLAUDE)).toEqual({ model: 'sonnet-x', effort: 'high', custom: true, source: 'bot' });
    expect(resolveModelPreference({ bot: b, group: group() }, CODEX)).toBeUndefined();
    expect(resolveExecution({ bot: b, group: group() }).model).toBeUndefined();
  });

  it("counts a bot model with no backend for Codex, and marks a listed one as not hand-typed", () => {
    const b = bot({ defaults: { model: { kind: 'catalog', id: 'gpt-x' } } });
    expect(resolveExecution({ bot: b, group: group() }).model).toEqual({ model: 'gpt-x', effort: undefined, custom: false, source: 'bot' });
    expect(resolveModelPreference({ bot: b }, CLAUDE)).toBeUndefined();
  });

  it("prefers the group's default over the bot's", () => {
    const b = bot({ defaults: { model: { kind: 'catalog', id: 'gpt-x' } } });
    expect(resolveModelPreference({ bot: b, group: group({ defaultModel: 'gpt-y' }) }, CODEX)?.model).toBe('gpt-y');
  });

  it('is none when nothing is set', () => {
    expect(resolveModelPreference({ bot: bot(), group: group() }, CODEX)).toBeUndefined();
  });

  it("counts on the backend a group runs on when its own id left the catalog or has spaces", () => {
    const old = group({ backend: 'claude-sdk', defaultModel: 'kimi-x', defaultModelCustom: true });
    expect(resolveModelPreference({ group: old }, groupBackendId(old))).toEqual({ model: 'kimi-x', effort: undefined, custom: true, source: 'group' });
    expect(resolveExecution({ group: old }).model?.model).toBe('kimi-x');
    expect(resolveModelPreference({ group: group({ backend: ' claude-agent ', defaultModel: 'opus' }) }, CLAUDE)?.model).toBe('opus');
  });
});

describe('no group (私聊 from s49, 云文档)', () => {
  it('uses the bot defaults: read-write, network on, its backend and workspaces', () => {
    const r = resolveExecution({ bot: { directories: { workspaces: { primary: '/bot', additional: ['/bot/x'] } } } });
    expect(r).toMatchObject({ permission: 'write', network: true, backend: CODEX, workspaces: { primary: '/bot', additional: ['/bot/x'] } });
    const set = resolveExecution({ bot: bot({ defaults: { permission: 'full', network: false, backend: CLAUDE } }) });
    expect(set).toMatchObject({ permission: 'full', network: false, backend: CLAUDE, sources: { permission: 'bot', network: 'bot', backend: 'bot' } });
    expect(resolveExecution({}).workspaces).toEqual({ primary: undefined, additional: [] });
  });

  it("falls back to Codex for a bot default backend no longer in the catalog", () => {
    expect(botBackendId(bot({ defaults: { backend: 'claude-sdk' } }))).toBe(CODEX);
  });

  it("then takes the bot's model on Codex, for a group, no group and 云文档评论", () => {
    const b = bot({ defaults: { backend: 'claude-sdk', model: { kind: 'catalog', id: 'gpt-x' } } });
    expect(resolveExecution({ bot: b }).model?.model).toBe('gpt-x');
    expect(resolveExecution({ bot: b, group: group() }).model?.model).toBe('gpt-x');
    expect(resolveCommentsExecution(b).model?.model).toBe('gpt-x');
  });
});

describe('云文档评论', () => {
  it('runs on the comment backend, else the bot default, else Codex', () => {
    expect(resolveCommentsExecution(bot({ comments: { backend: CLAUDE } }))).toMatchObject({ backend: CLAUDE, source: 'comments' });
    expect(resolveCommentsExecution(bot({ defaults: { backend: CLAUDE } }))).toMatchObject({ backend: CLAUDE, source: 'bot' });
    expect(resolveCommentsExecution(undefined)).toMatchObject({ backend: CODEX, source: 'builtin' });
    expect(resolveCommentsExecution(bot({ comments: { backend: 'claude-sdk' }, defaults: { backend: CLAUDE } })).backend).toBe(CLAUDE);
  });

  it("takes the comment model, else the bot's when it is for the same backend", () => {
    const b = bot({ defaults: { backend: CLAUDE, model: { kind: 'catalog', id: 'sonnet', effort: 'low' } } });
    expect(resolveCommentsExecution(b).model).toEqual({ model: 'sonnet', effort: 'low', custom: false, source: 'bot' });
    expect(resolveCommentsExecution({ ...b, comments: { backend: CODEX } }).model).toBeUndefined();
    expect(resolveCommentsExecution({ ...b, comments: { model: 'opus', effort: 'high' } }).model).toEqual({ model: 'opus', effort: 'high', custom: false, source: 'comments' });
  });
});

describe('execution roots admission', () => {
  const fixtures: string[] = [];
  afterEach(async () => { for (const root of fixtures.splice(0)) await rm(root, { recursive: true }); });
  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'execution-roots-')));
    fixtures.push(root);
    const cwd = join(root, 'work');
    const extra = join(root, 'extra');
    const repo = join(root, 'repo');
    for (const path of [cwd, extra, repo]) await mkdir(path);
    execFileSync('git', ['init', '--quiet', repo]);
    return { root, cwd, extra, repo, dataDir: join(root, 'data') };
  }
  it.each(['qa', 'write', 'full'] as const)('admits canonical roots and preserves the existing %s profile fields', async permission => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    await symlink(f.extra, alias);
    const profile: SessionProfile = { instructions: 'existing instructions', env: { KEEP: 'yes' }, nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: [], mcpServers: [] };
    const execution = resolveExecution({ group: group({ cwd: f.cwd, mode: permission, directories: { workspaces: { primary: f.cwd, additional: [alias] }, repositories: [f.repo] } }) });
    const result = await executionSessionProfile({ ...f, execution, backend: CODEX, scope: 'group', profile });
    expect(result).toMatchObject({ instructions: expect.stringContaining(profile.instructions), env: profile.env, additionalRoots: [
      { path: f.extra, access: permission === 'qa' ? 'read' : 'write' },
      { path: f.repo, access: permission === 'qa' ? 'read' : 'write' },
    ] });
    expect(result?.instructions).toContain('AGENTS.md 或 CLAUDE.md');
    expect(result?.instructions.match(/AGENTS.md 或 CLAUDE.md/g)).toHaveLength(1);
  });
  it('rejects new non-Git repositories and data roots before provider delivery', async () => {
    const f = await fixture();
    const execution = resolveExecution({ group: group({ cwd: f.cwd, directories: { repositories: [f.extra] } }) });
    await expect(executionSessionProfile({ ...f, execution, backend: CODEX, scope: 'group' })).rejects.toThrow('expected local Git root');
    await mkdir(f.dataDir);
    execution.repositories = [];
    execution.workspaces.additional = [f.dataDir];
    await expect(executionSessionProfile({ ...f, execution, backend: CODEX, scope: 'group' })).rejects.toThrow('Invalid directory settings');
  });
  it('deduplicates across workspaces/repositories and excludes the real cwd without adding bot primary', async () => {
    const f = await fixture();
    const execution = resolveExecution({ bot: { directories: { workspaces: { primary: f.extra, additional: [f.repo] }, repositories: [f.repo] } } });
    const result = await executionSessionProfile({ ...f, execution, backend: CODEX, scope: 'group' });
    expect(result?.additionalRoots).toEqual([{ path: f.repo, access: 'write' }]);
    execution.workspaces.additional = [f.cwd];
    execution.repositories = [];
    expect(await executionSessionProfile({ ...f, execution, backend: CODEX, scope: 'group' })).toBeUndefined();
  });
  it('admits both providers and keeps ungrouped single-root profiles unchanged', async () => {
    const execution = resolveExecution({ group: group({ directories: { repositories: ['/missing/repo'] } }) });
    await expect(executionSessionProfile({ execution, cwd: '/missing', backend: CLAUDE, scope: 'group' })).rejects.toThrow();
    execution.repositories = [];
    await expect(executionSessionProfile({ execution, cwd: '/missing', backend: CODEX, scope: 'group' })).rejects.toThrow();
    expect(await executionSessionProfile({ execution, cwd: '/missing', backend: CODEX, scope: 'ungrouped' })).toBeUndefined();
  });
  it('rejects a group primary symlink into bot data even without extra roots', async () => {
    const f = await fixture();
    await mkdir(f.dataDir);
    const botData = join(f.dataDir, 'bots');
    await mkdir(botData);
    const alias = join(f.root, 'linked-work');
    await symlink(botData, alias);
    const execution = resolveExecution({ group: group({ cwd: f.cwd }) });
    await expect(executionSessionProfile({ ...f, execution, cwd: alias, backend: CODEX, scope: 'group' })).rejects.toThrow('Invalid directory settings');
    expect(await executionSessionProfile({ ...f, execution, cwd: alias, backend: CODEX, scope: 'ungrouped' })).toBeUndefined();
  });

});
