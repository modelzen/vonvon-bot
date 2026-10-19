import { mkdtemp, mkdir, symlink, rm, access as fsAccess } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAccess, decide, fileHook, inside, ownAsk, permissionOptions, resolveReal, within, type PathFs, type ToolCall } from '../src/agent/claude-agent/permission';
const cwd = '/v/Work';
const tier = (mode: 'qa' | 'write' | 'full', network = false) => claudeAccess(mode, network, cwd, cwd);
const call = (toolName: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ToolCall => ({ toolName, input, extra });
const fsx: PathFs = {
  realpath: async p => p,
  lstat: async () => ({}),
  stat: async p => ({ dev: 1, ino: p === cwd ? 10 : 11 }),
};
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe('Claude permission tiers', () => {
  it('full and undefined retain historical unrestricted mode', () => {
    expect(permissionOptions(tier('full'))).toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    expect(claudeAccess(undefined, undefined, cwd, cwd)).toEqual({ mode: 'full', network: false, cwd, realCwd: cwd });
  });
  it('write uses acceptEdits and a mandatory sandbox with a file hook', () => {
    const opts = permissionOptions(tier('write'));
    expect(opts).toMatchObject({ permissionMode: 'acceptEdits', allowDangerouslySkipPermissions: true,
      sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
      disallowedTools: ['WebFetch', 'WebSearch'], hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', timeout: 10 }] } });
    expect(opts.sandbox?.filesystem).toBeUndefined();
    expect(opts.sandbox?.network).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(permissionOptions(tier('write', true)).allowedTools).toEqual(['WebFetch', 'WebSearch']);
    expect(permissionOptions(tier('write', true)).disallowedTools).toBeUndefined();
  });
  it('qa leaves write tools available for meaningful denials and denies both cwd identities', () => {
    expect(permissionOptions(tier('qa'))).toMatchObject({ permissionMode: 'default', sandbox: { filesystem: { denyWrite: [cwd] } }, disallowedTools: ['WebFetch', 'WebSearch'] });
    expect(permissionOptions(claudeAccess('qa', false, '/alias', cwd)).sandbox?.filesystem?.denyWrite).toEqual(['/alias', cwd]);
  });
});
describe('callback decision table', () => {
  it.each(['qa', 'write', 'full'] as const)('%s handles the three plan/question tools before rules', async mode => {
    for (const [tool, ask] of [['AskUserQuestion', 'choices'], ['ExitPlanMode', 'confirmation']] as const) {
      expect(await decide(tier(mode), call(tool, {}, { decisionReasonType: 'rule' }), 'callback')).toEqual({ kind: 'ask', ask });
    }
    expect(await decide(tier(mode), call('EnterPlanMode'), 'callback')).toEqual({ kind: 'allow' });
  });
  it.each(['qa', 'write'] as const)('%s gates network including loopback', async mode => {
    for (const tool of ['SandboxNetworkAccess', 'WebFetch', 'WebSearch']) {
      for (const host of ['example.com', '127.0.0.1']) {
        expect(await decide(tier(mode), call(tool, { host }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('关了网络') });
        expect(await decide(tier(mode, true), call(tool, { host }), 'callback')).toEqual({ kind: 'allow' });
      }
    }
  });
  it.each(['qa', 'write'] as const)('%s refuses every explicit ask rule, across tool categories', async mode => {
    for (const tool of ['Bash', 'Write', 'Read', 'mcp__probe__ping', 'Agent', 'WebFetch', 'SandboxNetworkAccess']) {
      expect(await decide(tier(mode, true), call(tool, { file_path: `${cwd}/f` }, { decisionReasonType: 'rule' }), 'callback', fsx))
        .toMatchObject({ kind: 'deny', message: expect.stringContaining('要人确认') });
    }
    expect(ownAsk(call('Read', {}, { decisionReasonType: 'rule' }))).toBe('rule');
    for (const extra of [{}, { decisionReasonType: 'workingDir' }, { decisionReasonType: 'safetyCheck' }]) expect(ownAsk(call('Read', {}, extra))).toBe('other');
  });
  it.each(['qa', 'write'] as const)('%s allows ordinary MCP and outside reads; Bash stays sandboxed', async mode => {
    for (const tool of ['Read', 'mcp__probe__pong', 'Agent', 'Bash']) expect(await decide(tier(mode), call(tool, { file_path: '/elsewhere/f' }), 'callback')).toEqual({ kind: 'allow' });
    expect(await decide(tier(mode), call('Bash', { dangerouslyDisableSandbox: true }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('沙箱') });
    expect(await decide(tier(mode), call('Bash', {}, { decisionReasonType: 'safetyCheck' }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('要人确认') });
  });
  it.each(['Bash', 'Write', 'Read', 'mcp__x__y', 'SandboxNetworkAccess'])('full asks permission for %s', async tool => {
    expect(await decide(tier('full'), call(tool), 'callback')).toEqual({ kind: 'ask', ask: 'permission' });
  });
  it('checks writes and reports missing input', async () => {
    expect(await decide(tier('write'), call('Write', { file_path: `${cwd}/f` }), 'callback', fsx)).toEqual({ kind: 'allow' });
    expect(await decide(tier('qa'), call('Write', { file_path: `${cwd}/f` }), 'callback', fsx)).toMatchObject({ kind: 'deny', message: expect.stringContaining('只读') });
    expect(await decide(tier('write'), call('Write', { file_path: '/elsewhere/f' }), 'callback', fsx)).toMatchObject({ kind: 'deny', message: expect.stringContaining('工作区以外') });
    expect(await decide(tier('write'), call('Write'), 'callback', fsx)).toMatchObject({ kind: 'deny', message: expect.stringContaining('出错') });
  });
});
it('file hook rejects writes even when settings would skip callback; failures deny', async () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${cwd}/f` }, tool_use_id: 'tool', session_id: 'session', transcript_path: '', cwd } as const;
  const options = { signal: new AbortController().signal };
  expect(await fileHook(tier('qa'), fsx)(input, 'tool', options)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('只读') } });
  expect(await fileHook(tier('write'), fsx)(input, 'tool', options)).toEqual({});
  expect(await fileHook(tier('write'), fsx)({ ...input, tool_input: { file_path: '/elsewhere/f' } }, 'tool', options)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(await fileHook(tier('write'), { ...fsx, realpath: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } })(input, 'tool', options)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('出错') } });
});
it('compares literal boundaries without confusing siblings', () => {
  expect(inside('/a/b', '/a/bc')).toBe(false);
  expect(inside('/a/b', '/a/b')).toBe(true);
  expect(inside('/a/b', '/a/c')).toBe(false);
  expect(inside('/A/B', '/a/b/x', true)).toBe(true);
  expect(inside('/A/B', '/a/b/x')).toBe(false);
});
it('uses directory identity for case aliases and propagates errors', async () => {
  let calls = 0;
  const identityFs: PathFs = { ...fsx, stat: async p => {
    calls++;
    if (p === '/v/WORK/new') throw Object.assign(new Error(), { code: 'ENOENT' });
    return { dev: 1, ino: p === '/v/WORK' || p === cwd ? 10 : 11 };
  } };
  expect(await within(cwd, `${cwd}/a/f`, identityFs)).toBe(true);
  expect(calls).toBe(0);
  expect(await within(cwd, '/v/work/f', identityFs)).toBe(false);
  expect(await within(cwd, '/v/WORK/new/f', identityFs)).toBe(true);
  expect(await within(cwd, '/elsewhere/x', identityFs)).toBe(false);
  await expect(within(cwd, '/elsewhere/x', { ...fsx, stat: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } })).rejects.toMatchObject({ code: 'EACCES' });
});
it('resolves real filesystem paths, aliases, missing suffixes and dangling links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 's31-path-')); dirs.push(dir);
  const work = join(dir, 'Work'); const outside = join(dir, 'work');
  await mkdir(work); await mkdir(join(outside, 'sub'), { recursive: true });
  await symlink(work, join(dir, 'wORK'));
  await symlink(join(outside, 'sub'), join(work, 'link'));
  await symlink(join(outside, 'new.txt'), join(work, 'dl'));
  await symlink(join(outside, 'nodir'), join(work, 'dd'));
  await symlink('loop', join(work, 'loop'));
  const a = claudeAccess('write', false, work, work);
  for (const path of [join(outside, 'f'), `${work}/link/../x`, `${work}/new/../x`, `${work}/dl`, `${work}/dd/sub/f`]) {
    expect(await decide(a, call('Write', { file_path: path }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('工作区以外') });
  }
  for (const path of [join(dir, 'wORK/f'), `${work}/new/f`, `${work}/new2/f`]) expect(await decide(a, call('Write', { file_path: path }), 'callback')).toEqual({ kind: 'allow' });
  await expect(decide(a, call('Write', { file_path: `${work}/loop/f` }), 'callback')).rejects.toMatchObject({ code: 'ELOOP' });
  await expect(fsAccess(join(outside, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const native = await import('node:fs/promises');
  expect(await resolveReal('new/f', work, native)).toBe(`${work}/new/f`);
});
