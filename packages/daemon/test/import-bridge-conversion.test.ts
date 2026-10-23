import { describe, expect, it } from 'vitest';
import { convertBridgeSnapshot, idleTimeoutMigrationMessage, type BridgeSnapshot } from '../src/import/bridge/conversion';
import { getRunIdleTimeoutMs, isAdmin } from '../src/config/schema';
import { groupPermission, resolveExecution } from '../src/config/execution';
import { noMentionOf, sessionModeOf, stricterTier } from '../src/project/registry';
import { isRetiredKey, sessionTitleJobKey } from '../src/bot/session-store';

// Entirely synthetic values; no source files, credentials, services, or native sessions.
function snapshot(): BridgeSnapshot {
  return {
    destinationSecretsGetter: '/synthetic/v1/secrets-getter',
    registry: { version: 1, current: 'synthetic_a', bots: ['a', 'b'].map(s => ({
      appId: `synthetic_${s}`, name: `synthetic_${s}`, tenant: 'feishu', createdAt: 1, active: true,
    })) },
    bots: ['a', 'b'].map(s => ({
      appId: `synthetic_${s}`, config: { accounts: { app: { id: `synthetic_${s}`, tenant: 'feishu', secret: { kind: 'legacy-keystore', id: `app-synthetic_${s}` } } },
        preferences: { access: { ownerOpenId: `owner_${s}`, admins: [`admin_${s}`] } } },
      projects: { version: 1, projects: [{ name: `group_${s}`, chatId: `chat_${s}`, cwd: `/synthetic/${s}`, blank: true, createdAt: 1 }] },
      sessions: { version: 2, sessions: [{ threadId: `topic_${s}`, chatId: `chat_${s}`, cwd: `/synthetic/${s}`,
        sessionId: `native_${s}`, backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 2 }] },
      commentInstructions: `instructions_${s}`, outboundFilesPresent: true,
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
    expect(result.bots.map(b => b.entry.appId)).toEqual(source.registry.bots.map(b => b.appId));
    for (const [index, bot] of result.bots.entries()) {
      const suffix = index === 0 ? 'a' : 'b';
      expect(bot.appId).toBe(`synthetic_${suffix}`);
      expect(bot.config.accounts.app.secret).toEqual({ source: 'exec', provider: 'bridge', id: `app-synthetic_${suffix}` });
      expect(bot.entry).toEqual({ appId: `synthetic_${suffix}`, tenant: 'feishu', desiredName: `synthetic_${suffix}`, active: true });
      expect(isAdmin(bot.config, `admin_${suffix}`)).toBe(true);
      expect(isAdmin(bot.config, suffix === 'a' ? 'admin_b' : 'admin_a')).toBe(false);
      expect(bot.personalInstructions).toBe('inherit-native');
      expect(bot.commentInstructions).toBe(`instructions_${suffix}`);
      expect(bot.copy).toEqual(['comment-instructions.md', 'outbound-files/**']);
      expect(bot.sessions.titleJobs).toEqual([]);
    }
  });
  it('pins old defaults with the actual V1 execution and rule resolvers', () => {
    const bot = converted(snapshot()).bots[0];
    expect(bot).toBeDefined();
    const group = bot?.projects.projects[0];
    expect(group).toMatchObject({ cwd: '/synthetic/a', blank: true, kind: 'multi', noMention: true, mode: 'full', network: false, backend: 'codex-appserver' });
    expect(resolveExecution({ bot: { defaults: { backend: 'claude-agent', permission: 'qa', network: true } }, group })).toMatchObject({ backend: 'codex-appserver', permission: 'full', network: true });
    if (group) expect(sessionModeOf(group)).toBe('multi');
  });
  it('preserves a legacy read-only/network-on pair for groupPermission to read as custom', () => {
    const source = snapshot();
    Object.assign(source.bots[0]?.projects.projects[0] ?? {}, { mode: 'qa', network: true });
    const group = converted(source).bots[0]?.projects.projects[0];
    expect(group).toMatchObject({ mode: 'qa', network: true });
    if (!group) throw new Error('fixture');
    expect(groupPermission(group)).toEqual({ tier: 'qa', custom: { sandbox: 'read-only', network: true },
      legacy: true, effect: { mode: 'qa', network: true } });
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
    expect(converted(source).bots[0]?.notes).toContainEqual({ kind: 'automatic-compaction', appId: 'synthetic_a', chatId: 'chat_a', message: '旧版关闭的自动压缩已改为开启。' });
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
      expect(result.bots[0]?.notes.filter(n => n.kind === 'permission-merged')).toMatchObject(mode === guestMode ? [] : [{ kind: 'permission-merged', appId: 'synthetic_a', chatId: 'chat_a', mode: stricterTier(mode, guestMode) }]);
      expect(result.bots[1]?.notes).toEqual([]);
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
    expect(first.notes).toEqual(timeout === 120 ? [{ kind: 'idle-timeout-default', appId: 'synthetic_a', message: idleTimeoutMigrationMessage }] : []);
    expect(result.bots[1]?.notes).toEqual([]);
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
    expect(bot?.notes.filter(n => n.kind !== 'retired-sessions')).toEqual([]);
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
    expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-title-job-key' }] });
    bot.sessions.titleJobs.push({ ...job, key: sessionTitleJobKey(job.backend, job.sessionId) });
    expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [
      { botIndex: 0, code: 'invalid-title-job-key' }, { botIndex: 0, code: 'duplicate-title-job-host' },
    ] });
  });
  it('rejects title job references for a different native backend or session', () => {
    for (const key of [sessionTitleJobKey('claude-agent', 'native_a'), sessionTitleJobKey('codex-appserver', 'other_native')]) {
      const source = snapshot();
      Object.assign(source.bots[0]?.sessions.sessions[0] ?? {}, { titleJobKey: key });
      expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-session-title-job-reference' }] });
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
    expect(converted(source).bots[0]?.notes).toContainEqual({ kind: 'retired-sessions', appId: 'synthetic_a', count: 2, message: '旧版访客及未接管的管理员会话记录已保留为停用记录，未覆盖其他会话。' });
  });
  it('rejects a valid unsuffixed key collision instead of overwriting it', () => {
    const source = snapshot();
    const bot = source.bots[0];
    if (!bot) throw new Error('fixture');
    Object.assign(bot.projects.projects[0] ?? {}, { mode: 'full', guestMode: 'qa' });
    const row = bot.sessions.sessions[0];
    if (!row) throw new Error('fixture');
    bot.sessions.sessions.push({ ...row, threadId: 'topic_a#admin', sessionId: 'other_native' });
    expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'session-key-conflict' }] });
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
      expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-schema' }] });
    }
    const source = snapshot(); Object.assign(source.bots[0]?.config.preferences ?? {}, { runIdleTimeoutSeconds: 'off' });
    expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-schema' }] });
  });
  it('rejects accessors without executing them, including passthrough fields', () => {
    const source = snapshot(); let calls = 0;
    Object.defineProperty(source.bots[0]?.config ?? {}, 'surprise', { enumerable: true, get() { calls++; throw new Error('secret'); } });
    expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', issues: [{ code: 'not-json-data' }] });
    expect(calls).toBe(0);
  });
  it.each(['legacy-keystore', 'plaintext'] as const)('plans %s without receiving or returning plaintext', kind => {
    const source = snapshot();
    const bot = source.bots[0]; if (!bot) throw new Error('fixture');
    bot.config.accounts.app.secret = kind === 'plaintext' ? { kind } : { kind, id: 'synthetic_old_key' };
    const result = converted(source).bots[0];
    expect(result?.secret).toEqual(bot.config.accounts.app.secret);
    expect(result?.config.accounts.app.secret).toEqual({ source: 'exec', provider: 'bridge', id: 'app-synthetic_a' });
    expect(result?.config.secrets?.providers?.bridge).toEqual({ source: 'exec', command: '/synthetic/v1/secrets-getter', args: [] });
  });
  it.each(['env', 'file', 'exec'] as const)('keeps legal external %s references without resolving them', sourceKind => {
    const source = snapshot(); const bot = source.bots[0]; if (!bot) throw new Error('fixture');
    const ref = { source: sourceKind, provider: 'synthetic_provider', id: 'synthetic_external' };
    bot.config.accounts.app.secret = { kind: 'external', reference: ref };
    bot.config.secrets = { providers: { synthetic_provider: { source: sourceKind, command: '/synthetic/external-getter', path: '/synthetic/external' } } };
    const result = converted(source).bots[0];
    expect(result?.secret).toEqual({ kind: 'external', reference: ref });
    expect(result?.config.accounts.app.secret).toEqual(ref);
    expect(result?.config.secrets).toEqual(bot.config.secrets);
  });
  it('rejects plaintext input and keeps the other valid bot attributed', () => {
    const source = snapshot();
    Object.assign(source.bots[0]?.config.accounts.app ?? {}, { secret: 'synthetic-sensitive-sentinel' });
    const result = convertBridgeSnapshot(source);
    expect(result.kind).toBe('invalid');
    expect(result.bots).toHaveLength(2);
    expect(result.bots[0]).toMatchObject({ kind: 'invalid', appId: 'synthetic_a', issues: [{ botIndex: 0, code: 'invalid-schema' }] });
    expect(result.bots[1]).toMatchObject({ kind: 'converted', entry: { appId: 'synthetic_b' } });
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-sentinel');
  });
  it('takes legacy active defaults from current and leaves allocation to s61', () => {
    const source = snapshot(); source.registry.bots.forEach(b => { delete b.active; });
    const result = converted(source);
    expect(result.bots.map(b => b.entry.active)).toEqual([true, false]);
    for (const bot of result.bots) for (const key of ['name', 'createdAt', 'registrationId', 'directory']) expect(bot.entry).not.toHaveProperty(key);
  });
  it('copies only existing approved relative resources, never comments or runtime state', () => {
    const source = snapshot(); const bot = source.bots[0]; if (!bot) throw new Error('fixture');
    bot.commentInstructions = null; bot.outboundFilesPresent = false;
    expect(converted(source).bots[0]?.copy).toEqual([]);
    expect(converted(snapshot()).bots[0]?.copy).toEqual(['comment-instructions.md', 'outbound-files/**']);
  });
  it('returns explicit structural errors for bad top-level data without throwing', () => {
    expect(convertBridgeSnapshot(null)).toMatchObject({ kind: 'invalid', bots: [], issues: [{ code: 'invalid-top-level' }] });
  });

  it('rejects invalid external references/providers per bot without returning their contents', () => {
    const source = snapshot(); const bot = source.bots[0]; if (!bot) throw new Error('fixture');
    bot.config.accounts.app.secret = { kind: 'external', reference: { source: 'exec', provider: 'missing', id: 'synthetic-reference-sentinel' } };
    const result = convertBridgeSnapshot(source);
    expect(result).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-external-provider' }] });
    expect(JSON.stringify(result)).not.toContain('synthetic-reference-sentinel');
    expect(result.bots[1]).toMatchObject({ kind: 'converted', appId: 'synthetic_b' });
  });
  it.each(['relative/getter', '/synthetic/\0getter'])('rejects an unsafe destination getter path', destinationSecretsGetter => {
    const source = snapshot(); source.destinationSecretsGetter = destinationSecretsGetter;
    expect(convertBridgeSnapshot(source)).toMatchObject({ kind: 'invalid', bots: [], issues: [{ code: 'invalid-destination-getter' }] });
  });
  it('reports a missing bot snapshot without hiding the available converted bot', () => {
    const source = snapshot(); source.bots.pop();
    const result = convertBridgeSnapshot(source);
    expect(result.kind).toBe('invalid');
    expect(result.bots[0]).toMatchObject({ kind: 'converted', appId: 'synthetic_a' });
    expect(result.bots[1]).toMatchObject({ kind: 'invalid', appId: 'synthetic_b', issues: [{ code: 'missing-bot-snapshot' }] });
  });

  it('rejects a plaintext descriptor carrying a value instead of a source-only marker', () => {
    const source = snapshot();
    Object.assign(source.bots[0]?.config.accounts.app ?? {}, { secret: { kind: 'plaintext', value: 'synthetic-plaintext-sentinel' } });
    const result = convertBridgeSnapshot(source);
    expect(result).toMatchObject({ kind: 'invalid', issues: [{ botIndex: 0, code: 'invalid-schema' }] });
    expect(JSON.stringify(result)).not.toContain('synthetic-plaintext-sentinel');
  });
  it('returns safe errors for hostile reflection traps instead of throwing', () => {
    const source = new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-hidden'); } });
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', bots: [], issues: [{ code: 'not-json-data' }] });
  });

  it('retains valid sibling previews while a damaged registry entry blocks all consumption', () => {
    const source = snapshot();
    Object.assign(source.registry.bots[0] ?? {}, { tenant: 'synthetic-invalid-sentinel' });
    const result = convertBridgeSnapshot(source);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('Expected blocked conversion');
    expect(result.issues).toContainEqual({ botIndex: 0, code: 'invalid-registry-entry' });
    expect(result.bots[0]).toMatchObject({ kind: 'invalid', appId: 'synthetic_a' });
    expect(result.bots[1]).toMatchObject({ kind: 'converted', entry: { appId: 'synthetic_b' } });
    expect(JSON.stringify(result)).not.toContain('synthetic-invalid-sentinel');
  });
  it('distinguishes an untrusted registry structure from top-level and destination errors', () => {
    const source = snapshot();
    Object.assign(source, { registry: { version: 'synthetic-invalid-sentinel' } });
    expect(convertBridgeSnapshot(source)).toEqual({ kind: 'invalid', bots: [], issues: [{ code: 'invalid-registry' }] });
  });

});
