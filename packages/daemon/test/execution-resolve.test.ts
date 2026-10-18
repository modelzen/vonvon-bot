import { describe, expect, it } from 'vitest';
import {
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
