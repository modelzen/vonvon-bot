import { describe, expect, it } from 'vitest';
import { convertBridgeSnapshot, idleTimeoutMigrationMessage, type BridgeSnapshot } from '../src/import/bridge/conversion';
import { getRunIdleTimeoutMs, isAdmin } from '../src/config/schema';
import { resolveExecution } from '../src/config/execution';
import { noMentionOf, sessionModeOf, stricterTier } from '../src/project/registry';
import { isRetiredKey, sessionTitleJobKey } from '../src/bot/session-store';

// Entirely synthetic values; no source files, credentials, services, or native sessions.
function snapshot(): BridgeSnapshot {
  return {
    registry: { version: 1, current: 'synthetic_a', bots: ['a', 'b'].map(s => ({
      appId: `synthetic_${s}`, name: `synthetic_${s}`, tenant: 'feishu', createdAt: 1, active: true,
    })) },
    bots: ['a', 'b'].map(s => ({
      appId: `synthetic_${s}`, config: { accounts: { app: { id: `synthetic_${s}`, tenant: 'feishu', secret: 'synthetic-only' } },
        preferences: { access: { ownerOpenId: `owner_${s}`, admins: [`admin_${s}`] } } },
      projects: { version: 1, projects: [{ name: `group_${s}`, chatId: `chat_${s}`, cwd: `/synthetic/${s}`, blank: true, createdAt: 1 }] },
      sessions: { version: 2, sessions: [{ threadId: `topic_${s}`, chatId: `chat_${s}`, cwd: `/synthetic/${s}`,
        sessionId: `native_${s}`, backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 2 }] },
      commentInstructions: `instructions_${s}`, sentFiles: [{ name: 'synthetic.json', data: {
        messageId: `message_${s}`, chatId: `chat_${s}`, cwd: `/synthetic/${s}`, mode: 'full', replyInThread: true,
        files: [{ path: `/synthetic/${s}/file.txt`, label: 'file', size: 2, mtimeMs: 1, ino: 1, dev: 1,
          fileKey: `sent_${s}`, occurrences: [{ elementId: 'element', label: 'file' }] }],
      } }],
    })),
  };
}
function converted(input: unknown) {
  const result = convertBridgeSnapshot(input);
  expect(result.kind).toBe('converted');
  if (result.kind !== 'converted') throw new Error('Expected conversion');
  return result;
}
function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}
describe('bridge conversion (new pure boundary contract)', () => {
  it('keeps both applications, local administrators, native inheritance and per-bot resources', () => {
    const source = snapshot();
    const result = converted(source);
    expect(result.registry).toEqual(source.registry);
    for (const [index, bot] of result.bots.entries()) {
      const suffix = index === 0 ? 'a' : 'b';
      expect(bot.appId).toBe(`synthetic_${suffix}`);
      expect(bot.config.accounts.app).toEqual(source.bots[index]?.config.accounts.app);
      expect(isAdmin(bot.config, `admin_${suffix}`)).toBe(true);
      expect(isAdmin(bot.config, suffix === 'a' ? 'admin_b' : 'admin_a')).toBe(false);
      expect(bot.personalInstructions).toBe('inherit-native');
      expect(bot.commentInstructions).toBe(`instructions_${suffix}`);
      expect(bot.sentFiles).toEqual(source.bots[index]?.sentFiles);
      expect(bot.sessions.titleJobs).toEqual([]);
    }
  });
  it('pins old defaults with the actual V1 execution and rule resolvers', () => {
    const bot = converted(snapshot()).bots[0];
    expect(bot).toBeDefined();
    const group = bot?.projects.projects[0];
    expect(group).toMatchObject({ cwd: '/synthetic/a', blank: true, kind: 'multi', noMention: true, mode: 'full', network: false, backend: 'codex-appserver' });
    expect(resolveExecution({ bot: { defaults: { backend: 'claude-agent', permission: 'qa', network: true } }, group })).toMatchObject({ backend: 'codex-appserver', permission: 'full', network: false });
    if (group) expect(sessionModeOf(group)).toBe('multi');
  });
  it.each(['multi', 'single'] as const)('retains rule %s and all explicit group overrides', kind => {
    const source = snapshot();
    Object.assign(source.bots[0]?.projects.projects[0] ?? {}, { kind, noMention: false, origin: 'joined', addedBy: 'synthetic_adder',
      mode: 'write', network: true, allowedUsers: ['synthetic_allowed'], backend: 'claude-agent', defaultModel: 'synthetic-model',
      defaultEffort: 'high', defaultModelCustom: true, pendingPolicy: 'queue', autoCompact: false });
    const group = converted(source).bots[0]?.projects.projects[0];
    expect(group).toMatchObject({ kind, noMention: false, origin: 'joined', mode: 'write', network: true,
      allowedUsers: ['synthetic_allowed'], backend: 'claude-agent', defaultModel: 'synthetic-model', defaultEffort: 'high', pendingPolicy: 'queue' });
    expect(group).not.toHaveProperty('autoCompact');
    if (group) { expect(sessionModeOf(group)).toBe(kind); expect(noMentionOf(group)).toBe(false); }
  });
  for (const mode of ['qa', 'write', 'full'] as const) for (const guestMode of ['qa', 'write', 'full'] as const) {
    it(`merges ${mode}/${guestMode} using stricterTier and records only split groups`, () => {
      const source = snapshot();
      Object.assign(source.bots[0]?.projects.projects[0] ?? {}, { mode, guestMode });
      const record = source.bots[0]?.sessions.sessions[0];
      if (!record) throw new Error('fixture');
      record.threadId = 'topic_a#admin';
      const result = converted(source);
      expect(result.bots[0]?.sessions.sessions[0]?.threadId).toBe(mode === guestMode ? 'topic_a#admin' : 'topic_a');
      expect(result.bots[0]?.projects.projects[0]?.mode).toBe(stricterTier(mode, guestMode));
      expect(result.bots[0]?.projects.projects[0]).not.toHaveProperty('guestMode');
      expect(result.bots[0]?.differences).toEqual(mode === guestMode ? [] : [{ kind: 'permission-merged', chatId: 'chat_a', mode: stricterTier(mode, guestMode) }]);
      expect(result.bots[1]?.differences).toEqual([]);
    });
  }
  it.each([120, 42, 0, undefined])('converts timeout %s; 0 is also the old off encoding', timeout => {
    const source = snapshot();
    const preferences = source.bots[0]?.config.preferences;
    if (!preferences) throw new Error('fixture');
    if (timeout !== undefined) preferences.runIdleTimeoutSeconds = timeout;
    const result = converted(source);
    const first = result.bots[0];
    if (!first) throw new Error('fixture');
    expect(first.config.preferences?.runIdleTimeoutSeconds).toBe(timeout === 120 ? undefined : timeout);
    expect(getRunIdleTimeoutMs(first.config)).toBe(timeout === 0 ? undefined : timeout === undefined || timeout === 120 ? 600000 : timeout * 1000);
    expect(first.differences).toEqual(timeout === 120 ? [{ kind: 'idle-timeout-default', message: idleTimeoutMigrationMessage }] : []);
    expect(result.bots[1]?.differences).toEqual([]);
    expect(getRunIdleTimeoutMs(result.bots[1]?.config ?? first.config)).toBe(600000);
  });
  it.each([['single', false], ['multi', true]] as const)('resolves joined %s omitted noMention through the actual helper', (kind, expected) => {
    const source = snapshot();
    Object.assign(source.bots[0]?.projects.projects[0] ?? {}, { kind, origin: 'joined' });
    const group = converted(source).bots[0]?.projects.projects[0];
    expect(group?.noMention).toBe(expected);
    if (group) expect(noMentionOf(group)).toBe(expected);
  });
  it('drops null guestMode without moving an admin session', () => {
    const source = snapshot();
    Object.assign(source.bots[0]?.projects.projects[0] ?? {}, { mode: 'write', guestMode: null });
    Object.assign(source.bots[0]?.sessions.sessions[0] ?? {}, { threadId: 'topic_a#admin' });
    const bot = converted(source).bots[0];
    expect(bot?.projects.projects[0]?.mode).toBe('write');
    expect(bot?.projects.projects[0]).not.toHaveProperty('guestMode');
    expect(bot?.sessions.sessions[0]?.threadId).toBe('topic_a#admin');
    expect(bot?.differences).toEqual([]);
  });
  it('keeps backend, model and native identity independent of changed group defaults', () => {
    const source = snapshot();
    Object.assign(source.bots[0]?.sessions.sessions[0] ?? {}, { backend: 'claude-agent', model: 'claude-synthetic', effort: 'high' });
    const result = converted(source);
    expect(result.bots[0]?.sessions.sessions[0]).toMatchObject({ backend: 'claude-agent', model: 'claude-synthetic', sessionId: 'native_a', cwd: '/synthetic/a' });
    expect(result.bots[1]?.sessions.sessions[0]).toMatchObject({ backend: 'codex-appserver', sessionId: 'native_b' });
  });
  it('retains the original v3 title ledger without scheduling new jobs', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    const job = { key: sessionTitleJobKey('claude-agent', 'native_title'), backend: 'claude-agent' as const, sessionId: 'native_title', cwd: '/synthetic/a',
      phase: 'done' as const, attempts: 1, createdAt: 1, updatedAt: 2, writeAttempted: true, finalTitle: 'synthetic' };
    bot.sessions.version = 3;
    bot.sessions.titleJobs = [job];
    expect(converted(source).bots[0]?.sessions.titleJobs).toEqual([job]);
  });
  it('retains an in-progress title job and matching binding exactly', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    const key = sessionTitleJobKey('codex-appserver', 'native_a');
    const job = { key, backend: 'codex-appserver' as const, sessionId: 'native_a', cwd: '/synthetic/a',
      phase: 'applying' as const, attempts: 2, createdAt: 1, updatedAt: 4, claimId: 'synthetic_claim',
      leaseUntil: 100, writeAttempted: true, candidate: 'synthetic candidate' };
    bot.sessions.version = 3;
    bot.sessions.titleJobs = [job];
    Object.assign(bot.sessions.sessions[0] ?? {}, { titleJobKey: key });
    const output = converted(source).bots[0];
    expect(output?.sessions.titleJobs).toEqual([job]);
    expect(output?.sessions.sessions[0]?.titleJobKey).toBe(key);
  });
  it('rejects noncanonical ledger keys and multiple keys for the same native host', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    const job = { key: 'incorrect', backend: 'claude-agent' as const, sessionId: 'native_title', cwd: '/synthetic/a',
      phase: 'pending' as const, attempts: 0, createdAt: 1, updatedAt: 2 };
    bot.sessions.version = 3;
    bot.sessions.titleJobs = [job];
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-title-job-key' }] });
    bot.sessions.titleJobs.push({ ...job, key: sessionTitleJobKey(job.backend, job.sessionId) });
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [
      { botIndex: 0, code: 'invalid-title-job-key' }, { botIndex: 0, code: 'duplicate-title-job-host' },
    ] });
  });
  it('rejects title job references for a different native backend or session', () => {
    for (const key of [sessionTitleJobKey('claude-agent', 'native_a'), sessionTitleJobKey('codex-appserver', 'other_native')]) {
      const source = snapshot();
      Object.assign(source.bots[0]?.sessions.sessions[0] ?? {}, { titleJobKey: key });
      expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-session-title-job-reference' }] });
    }
  });
  it('converts v1 native id without inventing a backend or changing cwd', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    bot.sessions = { version: 1, sessions: [{ threadId: 'topic_a', chatId: 'chat_a', cwd: '/synthetic/a', codexThreadId: 'old_native', summary: '', createdAt: 1, updatedAt: 1 }] };
    expect(converted(source).bots[0]?.sessions.sessions[0]).toMatchObject({ sessionId: 'old_native', backend: 'codex-appserver' });
  });
  it('adopts live admin keys, preserves guest and detached records as retired', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    Object.assign(bot.projects.projects[0] ?? {}, { mode: 'full', guestMode: 'qa' });
    const base = bot.sessions.sessions[0];
    if (!base) throw new Error('fixture');
    bot.sessions.sessions = [{ ...base, threadId: 'topic_a#admin' }, { ...base, threadId: 'topic_a#guest', sessionId: 'guest_native' },
      { ...base, threadId: 'parked#admin', detached: true, sessionId: 'parked_native' }];
    const rows = converted(source).bots[0]?.sessions.sessions;
    expect(rows?.map(s => s.threadId)).toEqual(['topic_a', 'topic_a#guest', 'parked#admin']);
    expect(isRetiredKey(rows?.[1]?.threadId ?? '')).toBe(true);
    expect(rows?.[2]?.detached).toBe(true);
  });
  it('rejects a valid unsuffixed key collision instead of overwriting it', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    Object.assign(bot.projects.projects[0] ?? {}, { mode: 'full', guestMode: 'qa' });
    const row = bot.sessions.sessions[0];
    if (!row) throw new Error('fixture');
    bot.sessions.sessions.push({ ...row, threadId: 'topic_a#admin', sessionId: 'other_native' });
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [{ botIndex: 0, code: 'session-key-conflict' }] });
    expect(bot.sessions.sessions.map(s => s.sessionId)).toEqual(['native_a', 'other_native']);
  });
  it('is repeatable and never mutates frozen nested input', () => {
    const source = snapshot();
    Object.assign(source.bots[0]?.config.preferences ?? {}, { runIdleTimeoutSeconds: 120 });
    freeze(source);
    const before = JSON.stringify(source);
    expect(converted(source)).toEqual(converted(source));
    expect(JSON.stringify(source)).toBe(before);
  });
  it.each([null, {}, { registry: {} }, 'invalid'])('rejects missing snapshot structure', source => {
    expect(convertBridgeSnapshot(source).kind).toBe('invalid');
  });
  it('rejects duplicate identities, groups, session keys and mismatched config', () => {
    for (const mutate of [
      (s: BridgeSnapshot) => { s.registry.bots.push({ ...s.registry.bots[0]! }); },
      (s: BridgeSnapshot) => { s.bots[0]!.projects.projects.push({ ...s.bots[0]!.projects.projects[0]! }); },
      (s: BridgeSnapshot) => { s.bots[0]!.sessions.sessions.push({ ...s.bots[0]!.sessions.sessions[0]! }); },
      (s: BridgeSnapshot) => { s.bots[0]!.config.accounts.app.id = 'mismatched'; },
    ]) { const source = snapshot(); mutate(source); expect(convertBridgeSnapshot(source).kind).toBe('invalid'); }
  });
  it('rejects illegal permission/backend/off values and never leaks rejected secrets', () => {
    for (const changes of [{ mode: 'unknown' }, { backend: 'invented' }, { guestMode: 'full-access' }]) {
      const source = snapshot(); Object.assign(source.bots[0]?.projects.projects[0] ?? {}, changes);
      expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [{ code: 'invalid-schema' }] });
    }
    const source = snapshot(); Object.assign(source.bots[0]?.config.preferences ?? {}, { runIdleTimeoutSeconds: 'off' });
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [{ code: 'invalid-schema' }] });
  });
  it('rejects accessors without executing them, including passthrough fields', () => {
    const source = snapshot(); let calls = 0;
    Object.defineProperty(source.bots[0]?.config ?? {}, 'surprise', { enumerable: true, get() { calls++; throw new Error('secret'); } });
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', issues: [{ code: 'not-json-data' }] });
    expect(calls).toBe(0);
  });
});
