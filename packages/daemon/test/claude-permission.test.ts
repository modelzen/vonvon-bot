import { mkdtemp, mkdir, symlink, link, writeFile, rm, realpath, access as fsAccess } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAccess, decide, fileHook, guardPaths, guardRules, guardedName, inside, ownAsk, permissionOptions, resolveReal, resumeMode, within, type PathFs, type ToolCall } from '../src/agent/claude-agent/permission';
import { log } from '../src/core/logger';
const cwd = '/v/Work';
const tier = (mode: 'qa' | 'write' | 'full', network = false) => claudeAccess(mode, network, cwd, cwd);
const call = (toolName: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ToolCall => ({ toolName, input, extra });
const fsx: PathFs = {
  realpath: async p => p,
  lstat: async () => ({}),
  stat: async p => ({ dev: 1, ino: p === cwd ? 10 : [...p].reduce((n, c) => n * 31 + c.charCodeAt(0), 0) }),
};
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const nativeAccess = (native: Record<string, unknown>) => claudeAccess('full', true, cwd, cwd, undefined, native);
describe('Claude native permission boundaries', () => {
  it('uses literal absolute SDK rule prefixes and filesystem guards', () => {
    expect(guardRules(['/workspace'])).toEqual([
      'Edit(//workspace/.mcp.json)', 'Edit(//workspace/.claude/settings.json)',
      'Edit(//workspace/.claude/settings.local.json)', 'Edit(//workspace/.claude/skills/**)',
      'Edit(//workspace/.claude/commands/**)', 'Edit(//workspace/.claude/agents/**)',
      'Edit(//workspace/.codex/**)', 'Edit(//workspace/.agents/skills/**)',
    ]);
    expect(guardPaths(['/workspace'])).toEqual([
      '/workspace/.mcp.json', '/workspace/.claude/settings.json',
      '/workspace/.claude/settings.local.json', '/workspace/.claude/skills',
      '/workspace/.claude/commands', '/workspace/.claude/agents',
      '/workspace/.codex', '/workspace/.agents/skills',
    ]);
  });
  it.each(['plan', 'auto'] as const)('runs %s natively and resumes the appropriate mode after confirmation', permissionMode => {
    const access = nativeAccess({ permissionMode });
    expect(permissionOptions(access).permissionMode).toBe(permissionMode);
    expect(access).toMatchObject({ mode: 'write', network: false });
    expect(resumeMode(access)).toBe(permissionMode === 'plan' ? 'acceptEdits' : 'auto');
    expect(resumeMode(tier('qa'))).toBe('default');
  });
  it('rejects malformed native settings without logging their contents or trusting full access', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const access = nativeAccess({ permissionMode: 'private-invalid-mode', privateToken: 'private-value' });
    expect(access).toEqual({ mode: 'qa', network: false, cwd, realCwd: cwd });
    expect(permissionOptions(access).permissionMode).toBe('default');
    expect(warn.mock.calls).toEqual([['claude-native', 'invalid']]);
  });
  it('retains the sandbox but no filesystem restrictions for bypassPermissions', async () => {
    const access = nativeAccess({ permissionMode: 'bypassPermissions', sandbox: true });
    const options = permissionOptions(access);
    expect(options).toMatchObject({ permissionMode: 'bypassPermissions', sandbox: { enabled: true } });
    expect(options.sandbox?.filesystem).toBeUndefined();
    expect(access.network).toBe(true);
    expect(await decide(access, call('Write', { file_path: '/outside/x' }), 'hook', fsx)).toEqual({ kind: 'continue' });
  });
  it.each(['default', 'acceptEdits', 'plan', 'auto'] as const)('blocks all unsandboxed command tools for %s in both hook and callback', async permissionMode => {
    const access = nativeAccess({ permissionMode, sandbox: false });
    if (access.planState) access.planState.pending = false; // Also blocked after plan approval.
    const options = permissionOptions(access);
    expect(options.sandbox).toBeUndefined();
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Monitor', 'PowerShell']));
    const hook = options.hooks?.PreToolUse?.find(entry => entry.matcher === 'Bash|Monitor|PowerShell')?.hooks[0];
    expect(hook).toBeTypeOf('function');
    for (const tool of ['Bash', 'Monitor', 'PowerShell']) {
      const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'ls' }, tool_use_id: 'tool', session_id: 's', transcript_path: '', cwd } as const;
      expect(await hook?.(input, 'tool', { signal: new AbortController().signal }))
        .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('关了命令沙箱') } });
      expect(await decide(access, call(tool, { command: 'ls' }, { decisionReasonType: 'rule' }), 'callback'))
        .toMatchObject({ kind: 'deny', message: expect.stringContaining('关了命令沙箱') });
    }
  });
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('gates %s by the mutable plan phase and confines drafts to the plan directory', async tool => {
    const access = nativeAccess({ permissionMode: 'plan' });
    expect(access.planState).toEqual({ pending: true, directory: join(cwd, '.claude/plans') });
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    for (const origin of ['hook', 'callback'] as const) {
      const request = call(tool, { [key]: `${cwd}/a.txt` });
      expect(await decide(access, request, origin, fsx)).toMatchObject({ kind: 'deny', message: expect.stringContaining('现在是先出方案阶段') });
      expect(await decide(access, call(tool, { [key]: `${access.planState!.directory}/draft.md` }), origin, fsx)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
      expect(await decide(access, call(tool, { [key]: `${access.planState!.directory}-other/draft.md` }), origin, fsx)).toMatchObject({ kind: 'deny' });
      access.planState!.pending = false;
      expect(await decide(access, request, origin, fsx)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
      access.planState!.pending = true;
      expect(await decide(access, request, origin, fsx)).toMatchObject({ kind: 'deny' });
    }
    const hook = permissionOptions(access).hooks!.PreToolUse![0]!.hooks[0]!;
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { [key]: `${cwd}/a.txt` }, tool_use_id: 'tool', session_id: 's', transcript_path: '', cwd }, 'tool', { signal: new AbortController().signal }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '现在是先出方案阶段，方案确认前不能改文件、不能跑命令。先把方案写出来。' } });
  });
  it.each(['Bash', 'Monitor', 'PowerShell'])('rejects %s before plan approval even with the command sandbox enabled', async tool => {
    const access = nativeAccess({ permissionMode: 'plan' });
    const hook = permissionOptions(access).hooks!.PreToolUse!.find(entry => entry.matcher === 'Bash|Monitor|PowerShell')!.hooks[0]!;
    expect(await decide(access, call(tool, { command: 'touch a' }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('先出方案阶段') });
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'touch a' }, tool_use_id: 'tool', session_id: 's', transcript_path: '', cwd }, 'tool', { signal: new AbortController().signal }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
  it.each(['.claude', '.claude/plans'])('rejects a symlinked %s even into an authorized write root', async component => {
    for (const destination of ['work', 'outside']) {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 's31-plan-'))); dirs.push(dir);
      const work = join(dir, 'work'); const outside = join(dir, 'outside');
      await mkdir(work); await mkdir(outside);
      if (component.endsWith('/plans')) await mkdir(join(work, '.claude'));
      await symlink(join(dir, destination), join(work, component));
      const a = claudeAccess('write', false, work, work, [{ path: outside, access: 'write' }], { permissionMode: 'plan' });
      for (const origin of ['hook', 'callback'] as const) for (const path of [join(work, '.claude/plans/draft.md'), join(dir, destination, 'other.md')]) {
        expect(await decide(a, call('Write', { file_path: path }), origin)).toMatchObject({ kind: 'deny', message: expect.stringContaining('先出方案阶段') });
      }
    }
  });
  it('allows missing draft directories through a workspace alias but rejects escaping child links', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 's31-plan-'))); dirs.push(dir);
    const work = join(dir, 'work'); const alias = join(dir, 'alias'); const outside = join(dir, 'outside');
    await mkdir(work); await mkdir(outside); await symlink(work, alias);
    const a = claudeAccess('write', false, alias, work, [{ path: outside, access: 'write' }], { permissionMode: 'plan' });
    expect(a.planState?.directory).toBe(join(work, '.claude/plans'));
    for (const origin of ['hook', 'callback'] as const) for (const path of ['.claude/plans/draft.md', join(alias, '.claude/plans/draft.md'), join(work, '.claude/plans/draft.md')]) {
      expect(await decide(a, call('Write', { file_path: path }), origin)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
    }
    await mkdir(join(work, '.claude/plans'), { recursive: true });
    await symlink(outside, join(work, '.claude/plans/escape'));
    for (const origin of ['hook', 'callback'] as const) {
      expect(await decide(a, call('Write', { file_path: join(alias, '.claude/plans/escape/other.md') }), origin)).toMatchObject({ kind: 'deny' });
      expect(await decide(a, call('Write', { file_path: join(alias, '.claude/plans/draft.md') }), origin)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
    }
  });
  it.each(['off', 'all', 'domains'])('pre-allows only the daemon MCP server in auto with network %s, retaining network rules', network => {
    const options = permissionOptions(nativeAccess({ permissionMode: 'auto', network, ...(network === 'domains' ? { domains: ['example.com'] } : {}) }));
    expect(options.allowedTools).toEqual(network === 'domains' ? ['WebFetch(domain:example.com)', 'mcp__vonvon_bot'] : network === 'all' ? ['WebFetch', 'WebSearch', 'mcp__vonvon_bot'] : ['mcp__vonvon_bot']);
    expect(options.disallowedTools).toEqual([...(network === 'off' ? ['WebFetch', 'WebSearch'] : network === 'domains' ? ['WebSearch'] : []), ...guardRules([cwd])]);
  });
  it('does not add the Bash hook to unsandboxed bypassPermissions', () => {
    expect(permissionOptions(nativeAccess({ permissionMode: 'bypassPermissions', sandbox: false })).hooks).toBeUndefined();
  });
  it('applies strict sandbox domains and scoped WebFetch rules, with callback checks for every host', async () => {
    const access = nativeAccess({ permissionMode: 'acceptEdits', network: 'domains', domains: ['example.com', '*.npmjs.org'] });
    expect(permissionOptions(access)).toMatchObject({ sandbox: { network: { allowedDomains: ['example.com', '*.npmjs.org'], strictAllowlist: true } },
      allowedTools: ['WebFetch(domain:example.com)', 'WebFetch(domain:*.npmjs.org)'], disallowedTools: expect.arrayContaining(['WebSearch', ...guardRules([cwd])]) });
    for (const [host, allowed] of [['example.com', true], ['registry.npmjs.org', true], ['npmjs.org', false], ['example.org', false], ['example.com.evil.test', false]] as const) {
      for (const request of [call('SandboxNetworkAccess', { host }), call('WebFetch', { url: `https://${host}/` })]) {
        expect((await decide(access, request, 'callback')).kind).toBe(allowed ? 'allow' : 'deny');
      }
    }
    expect(await decide(access, call('WebFetch', { url: 'invalid' }), 'callback')).toMatchObject({ kind: 'deny' });
    expect(await decide(access, call('WebSearch'), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('不能搜索') });
  });
  it('uses a WebFetch hook to enforce domains even when broad allow rules skip the callback', async () => {
    const access = nativeAccess({ permissionMode: 'acceptEdits', network: 'domains', domains: ['example.com', '*.npmjs.org'] });
    const hook = permissionOptions(access).hooks?.PreToolUse?.find(entry => entry.matcher === 'WebFetch')?.hooks[0];
    expect(hook).toBeTypeOf('function');
    for (const [host, allowed] of [['example.com', true], ['registry.npmjs.org', true], ['example.org', false], ['npmjs.org', false]] as const) {
      const result = await hook?.({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: `https://${host}/` },
        tool_use_id: 'tool', session_id: 's', transcript_path: '', cwd }, 'tool', { signal: new AbortController().signal });
      expect(result).toEqual(allowed ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(`连不上 ${host}`) } });
    }
  });
  it.each([
    { permissionMode: 'plan' }, { permissionMode: 'default', sandbox: false },
    { permissionMode: 'acceptEdits', sandbox: false }, { permissionMode: 'auto', network: 'domains', domains: ['example.com'] },
    { permissionMode: 'bypassPermissions', sandbox: true },
  ])('always leaves daemon-owned MCP tools available, even with ask rules: %j', async native => {
    const access = nativeAccess(native);
    const request = call('mcp__vonvon_bot__settings_set', {}, { decisionReasonType: 'rule' });
    expect(await decide(access, request, 'callback')).toEqual({ kind: 'allow' });
    expect(await decide(access, request, 'hook')).toEqual({ kind: 'continue' });
    expect(await fileHook(access)({ hook_event_name: 'PreToolUse', tool_name: request.toolName, tool_input: {}, tool_use_id: 'tool', session_id: 's', transcript_path: '', cwd }, 'tool', { signal: new AbortController().signal })).toEqual({});
  });
});
describe('Claude permission tiers', () => {
  it('full and undefined retain historical unrestricted mode', () => {
    expect(permissionOptions(tier('full'))).toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    expect(claudeAccess(undefined, undefined, cwd, cwd)).toEqual({ mode: 'full', network: false, cwd, realCwd: cwd });
  });
  it('write uses acceptEdits and a mandatory sandbox with a file hook', () => {
    const opts = permissionOptions(tier('write'));
    expect(opts).toMatchObject({ permissionMode: 'acceptEdits', allowDangerouslySkipPermissions: true,
      sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
      disallowedTools: expect.arrayContaining(['WebFetch', 'WebSearch', ...guardRules([cwd])]), hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', timeout: 10 }] } });
    expect(opts.sandbox?.filesystem?.denyWrite).toEqual(guardPaths([cwd]));
    expect(opts.sandbox?.network).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(permissionOptions(tier('write', true)).allowedTools).toEqual(['WebFetch', 'WebSearch']);
    expect(permissionOptions(tier('write', true)).disallowedTools).toEqual(guardRules([cwd]));
  });
  it('qa leaves write tools available for meaningful denials and denies both cwd identities', () => {
    expect(permissionOptions(tier('qa'))).toMatchObject({ permissionMode: 'default', sandbox: { filesystem: { denyWrite: [cwd, ...guardPaths([cwd])] } }, disallowedTools: expect.arrayContaining(['WebFetch', 'WebSearch']) });
    expect(permissionOptions(claudeAccess('qa', false, '/alias', cwd)).sandbox?.filesystem?.denyWrite).toEqual(['/alias', cwd, ...guardPaths(['/alias', cwd])]);
  });
});
describe('callback decision table', () => {
  it.each(['qa', 'write', 'full'] as const)('%s refuses native mode decisions before tool-specific allowances', async mode => {
    for (const tool of ['Read', 'Bash', 'Write', 'ExitPlanMode']) expect(await decide(tier(mode), call(tool, { file_path: `${cwd}/f` }, { decisionReasonType: 'mode' }), 'callback', fsx)).toMatchObject({ kind: 'deny' });
    expect(await decide(tier(mode), call('mcp__vonvon_bot__settings_set', {}, { decisionReasonType: 'mode' }), 'callback')).toEqual({ kind: 'allow' });
  });
  it.each(['qa', 'write', 'full'] as const)('%s handles the three plan/question tools before rules', async mode => {
    for (const [tool, ask] of [['AskUserQuestion', 'choices'], ['ExitPlanMode', 'confirmation']] as const) {
      expect(await decide(tier(mode), call(tool, {}, { decisionReasonType: 'rule' }), 'callback')).toEqual({ kind: 'ask', ask });
    }
    expect(await decide(tier(mode), call('EnterPlanMode'), 'callback')).toEqual({ kind: 'allow' });
  });
  it.each(['qa', 'write'] as const)('%s gates network including loopback', async mode => {
    for (const tool of ['SandboxNetworkAccess', 'WebFetch', 'WebSearch']) {
      for (const host of ['example.com', '127.0.0.1']) {
        expect(await decide(tier(mode), call(tool, { host }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('这个群的权限不联网') });
        expect(await decide(tier(mode, true), call(tool, { host }), 'callback')).toEqual({ kind: 'allow' });
      }
    }
  });
  it('explains how a custom network-off write group can return to the networked write tier', async () => {
    expect(await decide(tier('write', false), call('SandboxNetworkAccess', { host: 'example.com' }), 'callback'))
      .toEqual({ kind: 'deny', message: '这个群的权限不联网，连不上 example.com。不要再试着联网，换个办法，或者停下来说明：要联网得请主人在群设置里重新选一次工作区可写，或者改成完全访问。' });
  });
  it.each([
    { mode: 'qa', network: false },
    { mode: 'write', network: true },
    { mode: 'qa', network: true },
  ] as const)('keeps vonvon settings tools available at $mode/network $network', async ({ mode, network }) => {
    const request = call('mcp__vonvon_bot__settings_set', { section: 'presentation', patch: {} });
    expect(await decide(tier(mode, network), request, 'callback')).toEqual({ kind: 'allow' });
    expect(await decide(tier(mode, network), request, 'hook')).toEqual({ kind: 'continue' });
  });
  it.each(['qa', 'write'] as const)('%s refuses every explicit ask rule, across tool categories', async mode => {
    for (const tool of ['Bash', 'Write', 'Read', 'mcp__probe__ping', 'Agent', 'WebFetch', 'SandboxNetworkAccess']) {
      expect(await decide(tier(mode, true), call(tool, { file_path: `${cwd}/f` }, { decisionReasonType: 'rule' }), 'callback', fsx))
        .toMatchObject({ kind: 'deny', message: expect.stringContaining(`这个群的权限是${mode === 'qa' ? '只读' : '工作区可写'}`) });
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
    expect(await decide(tier('qa'), call('Write', { file_path: `${cwd}/f` }), 'callback', fsx)).toMatchObject({ kind: 'deny', message: expect.stringContaining('权限是只读') });
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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 's31-path-'))); dirs.push(dir);
  const work = join(dir, 'Work'); const outside = join(dir, 'outside');
  await mkdir(work); await mkdir(join(outside, 'sub'), { recursive: true });
  await symlink(work, join(dir, 'workspace-alias'));
  await symlink(join(outside, 'sub'), join(work, 'link'));
  await symlink(join(outside, 'new.txt'), join(work, 'dl'));
  await symlink(join(outside, 'nodir'), join(work, 'dd'));
  await symlink('loop', join(work, 'loop'));
  const a = claudeAccess('write', false, work, work);
  for (const path of [join(outside, 'f'), `${work}/link/../x`, `${work}/new/../x`, `${work}/dl`, `${work}/dd/sub/f`]) {
    expect(await decide(a, call('Write', { file_path: path }), 'callback')).toMatchObject({ kind: 'deny', message: expect.stringContaining('工作区以外') });
  }
  for (const path of [join(dir, 'workspace-alias/f'), `${work}/new/f`, `${work}/new2/f`]) expect(await decide(a, call('Write', { file_path: path }), 'callback')).toEqual({ kind: 'allow' });
  await expect(decide(a, call('Write', { file_path: `${work}/loop/f` }), 'callback')).rejects.toMatchObject({ code: 'ELOOP' });
  await expect(fsAccess(join(outside, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const native = await import('node:fs/promises');
  expect(await resolveReal('new/f', work, native)).toBe(`${work}/new/f`);
});

it('checks case identities according to the actual filesystem', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 's31-case-'))); dirs.push(dir);
  const work = join(dir, 'Work'); const lower = join(dir, 'work');
  await mkdir(work);
  const caseSensitive = await mkdir(lower).then(() => true, (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  });
  const native = await import('node:fs/promises');
  const root = await native.stat(work); const sibling = await native.stat(lower);
  expect(root.dev === sibling.dev && root.ino === sibling.ino).toBe(!caseSensitive);
  const a = claudeAccess('write', false, work, work);
  expect(await decide(a, call('Write', { file_path: join(lower, 'f') }), 'callback'))
    .toMatchObject(caseSensitive ? { kind: 'deny', message: expect.stringContaining('工作区以外') } : { kind: 'allow' });
  expect(await within(work, join(lower, 'new/f'), native)).toBe(!caseSensitive);
  if (caseSensitive) {
    await symlink(work, join(dir, 'wORK'));
    expect(await decide(a, call('Write', { file_path: join(dir, 'wORK/f') }), 'callback')).toEqual({ kind: 'allow' });
  }
});


describe('Claude configuration and read isolation', () => {
  async function layout() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 's31b-permission-'))); dirs.push(dir);
    const work = join(dir, 'work'); const denied = join(dir, 'private'); const allowed = join(denied, 'skills');
    await mkdir(work); await mkdir(allowed, { recursive: true });
    return { dir, work, denied, allowed };
  }
  it('generates guards for both workspace paths and leaves allowed instruction files writable', async () => {
    const { dir, work } = await layout();
    const alias = join(dir, 'alias'); await symlink(work, alias);
    const a = claudeAccess('write', false, alias, work);
    const opts = permissionOptions(a);
    expect(opts.sandbox?.filesystem?.denyWrite).toEqual(guardPaths([alias, work]));
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(guardRules([alias, work])));
    for (const path of ['.mcp.json', '.MCP.JSON', '.claude/settings.json', '.claude/skills/a', '.codex/config.toml', '.agents/skills/a', '.claude']) {
      for (const origin of ['hook', 'callback'] as const) {
        expect(await decide(a, call('Write', { file_path: join(alias, path) }), origin)).toMatchObject({ kind: 'deny', message: expect.stringContaining('自动加载的配置') });
      }
    }
    for (const path of ['CLAUDE.md', 'AGENTS.md', '.claude/rules/r.md']) {
      expect(await decide(a, call('Write', { file_path: join(work, path) }), 'callback')).toEqual({ kind: 'allow' });
    }
    expect(guardedName([work], join(work, '.codex-extra/file'))).toBeUndefined();
  });
  it('rejects symbolic and hard links to configuration files', async () => {
    const { work } = await layout();
    await writeFile(join(work, '.mcp.json'), '{}');
    await symlink(join(work, '.mcp.json'), join(work, 'symbolic'));
    await link(join(work, '.mcp.json'), join(work, 'hard'));
    for (const mode of ['qa', 'write'] as const) for (const origin of ['hook', 'callback'] as const) {
      for (const path of ['symbolic', 'hard']) {
        expect(await decide(claudeAccess(mode, false, work, work), call('Edit', { file_path: join(work, path) }), origin)).toMatchObject({ kind: 'deny', message: expect.stringContaining('自动加载的配置') });
      }
    }
  });
  it('uses expanded sandbox lists but coarse read checks for both hooks and callbacks', async () => {
    const { work, denied, allowed } = await layout();
    await writeFile(join(denied, 'secret'), 'secret'); await writeFile(join(allowed, 'SKILL.md'), 'skill');
    const credential = join(work, '../local-credential'); const secrets = join(work, '../secrets.enc');
    await writeFile(credential, 'private'); await writeFile(secrets, 'encrypted');
    await symlink(join(denied, 'secret'), join(work, 'escape'));
    await link(join(denied, 'secret'), join(work, 'hard'));
    for (const mode of ['qa', 'write'] as const) {
      const a = claudeAccess(mode, false, work, work);
      a.read = { deny: [denied, credential], allow: [work, allowed] };
      a.sandboxRead = { deny: [join(denied, 'secret')], allow: [work, allowed] };
      expect(permissionOptions(a).sandbox?.filesystem?.denyRead).toEqual(a.sandboxRead.deny);
      expect(permissionOptions(a).hooks?.PreToolUse?.some(entry => entry.matcher === 'Read|Glob|Grep|LS|NotebookRead')).toBe(true);
      for (const origin of ['hook', 'callback'] as const) {
        for (const path of [join(denied, 'new/secret'), join(work, 'escape'), join(work, 'hard'), credential]) {
          expect(await decide(a, call('Read', { file_path: path }), origin)).toMatchObject({ kind: 'deny', message: expect.stringContaining('读不到') });
        }
        for (const path of [join(allowed, 'SKILL.md'), join(work, 'x'), secrets, '/etc/hosts']) {
          expect(await decide(a, call('Read', { file_path: path }), origin)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
        }
      }
      const unrestricted = claudeAccess(mode, false, work, work);
      expect(await decide(unrestricted, call('Read', { file_path: join(work, 'hard') }), 'callback')).toEqual({ kind: 'allow' });
      const result = await fileHook(a)({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(work, 'escape') }, tool_use_id: 'tool', session_id: 's', transcript_path: '', cwd: work }, 'tool', { signal: new AbortController().signal });
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }
  });
  it('checks Glob traversal roots without treating Grep content patterns as paths', async () => {
    const { dir, work, denied } = await layout();
    const a = claudeAccess('write', false, work, work);
    a.read = { deny: [denied], allow: [work] };
    for (const origin of ['hook', 'callback'] as const) {
      for (const input of [
        { pattern: `${denied}/**/*.json` },
        { pattern: '../private/**/*.json' },
        { pattern: '**/*.json', path: denied },
        { pattern: `${dir}/**/*.json` },
        { pattern: '**/../private/*.json' },
        { pattern: '{../vh,zz}/bots/**' },
        { pattern: '{../vh/bots,zz}/**' },
        { pattern: 'safe..name/*.json' },
      ]) expect(await decide(a, call('Glob', input), origin)).toMatchObject({ kind: 'deny' });
      for (const input of [{ pattern: '**/*.ts' }, { pattern: '*.ts', path: work }]) {
        expect(await decide(a, call('Glob', input), origin)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
      }
      expect(await decide(a, call('Grep', { pattern: `${denied}/**/../secret` }), origin)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
      expect(await decide(a, call('Grep', { pattern: 'PRIVATE', path: dir }), origin)).toMatchObject({ kind: 'deny' });
      expect(await decide(a, call('Grep', { pattern: 'ordinary', path: work }), origin)).toEqual({ kind: origin === 'hook' ? 'continue' : 'allow' });
    }
  });
  it('does not apply read scope or guards after native mode resolves to full', async () => {
    const a = nativeAccess({ permissionMode: 'bypassPermissions', sandbox: true });
    a.read = { deny: [cwd], allow: [] };
    expect(permissionOptions(a).sandbox?.filesystem).toBeUndefined();
    expect(await decide(a, call('Read', { file_path: join(cwd, '.mcp.json') }), 'hook')).toEqual({ kind: 'continue' });
  });
});
