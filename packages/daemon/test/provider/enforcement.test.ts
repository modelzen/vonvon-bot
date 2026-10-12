import { describe, expect, it } from 'vitest';
import type { Grant, HostFacts, Os, ProviderId } from '../../src/provider/model';
import { auditTable, planEnforcement, type Cell, type CellKey, type EnforcementTable, type Mechanism, type NativeSettings, type Proof } from '../../src/provider/policy/enforcement';
import { BASH_OFF_NOTICE, MCP_OFF_NOTICE } from '../../src/provider/policy/messages.zh';
import { PROOFS } from '../../src/provider/policy/proofs';

const root = '/work/project';
const grants = {
  full: { tier: 'full', root, network: false },
  qaProject: { tier: 'qa', readScope: 'project', root, network: false },
  qaUnrestricted: { tier: 'qa', readScope: 'unrestricted', root, network: false },
  writeProject: { tier: 'write', readScope: 'project', root, network: true },
  writeUnrestricted: { tier: 'write', readScope: 'unrestricted', root, network: false },
} satisfies Record<string, Grant>;

function host(os: Os = 'darwin', provider: ProviderId = 'codex', overrides: Partial<HostFacts> = {}): HostFacts {
  return { os, commandSandbox: os === 'darwin' ? 'seatbelt' : 'none', installed: {
    [provider]: { installed: true, version: '1.2.3', auth: 'ok' },
  }, ...overrides };
}

function key(provider: ProviderId, grant: Grant, os: Os = 'darwin'): CellKey {
  return `${provider}:${grant.tier}:${grant.tier === 'full' ? '-' : grant.readScope}:${os}`;
}

function live(native: NativeSettings, os: Os = 'darwin'): Cell {
  const full = (native.family === 'codex' && native.sandbox === 'danger-full-access')
    || (native.family === 'claude' && native.mode === 'bypass');
  return { mode: 'enforced', mechanisms: full ? [] : ['os-sandbox'], native,
    proof: { kind: 'live', probe: 'test.canary', os, provenFor: '1.2.3' } };
}

function table(provider: ProviderId, grant: Grant, cell: Cell, os: Os = 'darwin'): EnforcementTable {
  return { [key(provider, grant, os)]: cell };
}

const codex = {
  full: { family: 'codex', sandbox: 'danger-full-access' },
  profileRead: { family: 'codex', sandbox: 'profile', profile: 'feishu', rootAccess: 'read', network: true },
  profileWrite: { family: 'codex', sandbox: 'profile', profile: 'feishu', rootAccess: 'write', network: false },
  readOnly: { family: 'codex', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } },
  workspace: { family: 'codex', sandbox: 'workspace-write', sandboxPolicy: {
    type: 'workspaceWrite', writableRoots: ['/wrong'], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true,
  } },
} satisfies Record<string, NativeSettings>;

const claudeFull = { family: 'claude', mode: 'bypass', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true } satisfies NativeSettings;
const claudeGated = { family: 'claude', mode: 'gated', permissionMode: 'default', tools: ['Bash'],
  sandbox: { filesystem: { denyRead: ['/Users/other', '/Volumes'] } },
  managedSettings: { allowManagedPermissionRulesOnly: true, allowManagedMcpServersOnly: true },
  shell: 'sandboxed' } satisfies NativeSettings;

describe('pure enforcement plans', () => {
  it.each([
    ['full', grants.full, codex.full, 'unrestricted', 'unrestricted', codex.full],
    ['qa project', grants.qaProject, codex.profileRead, [root], [], { family: 'codex', sandbox: 'profile', profile: 'feishu', rootAccess: 'read', network: false }],
    ['qa unrestricted', grants.qaUnrestricted, codex.readOnly, 'unrestricted', [], { family: 'codex', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
    ['write project', grants.writeProject, codex.profileWrite, [root], [root], { family: 'codex', sandbox: 'profile', profile: 'feishu', rootAccess: 'write', network: true }],
    ['write unrestricted', grants.writeUnrestricted, codex.workspace, 'unrestricted', [root], { family: 'codex', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }],
  ] as const)('derives %s roots and concrete native settings from the grant', (_name, grant, scaffold, reads, writes, native) => {
    const result = planEnforcement(table('codex', grant, live(scaffold)), 'codex', grant, 'darwin', host());
    expect(result).toEqual({ ok: true, plan: { provider: 'codex', grant, readableRoots: reads, writableRoots: writes, native, notices: [] } });
  });

  it('keeps full network unrestricted for the agent', () => {
    const result = planEnforcement(table('codex', grants.full, live(codex.full)), 'codex', grants.full, 'darwin', host());
    expect(result.ok && result.plan.native).toEqual(codex.full);
    expect(grants.full.network).toBe(false);
  });

  it('detaches a plan from its grant and the next plan from table mutation through the first', () => {
    const grant = { ...grants.writeProject };
    const scaffold = structuredClone(claudeGated);
    const cells = table('claude', grant, live(scaffold));
    const first = planEnforcement(cells, 'claude', grant, 'darwin', host('darwin', 'claude'));
    if (!first.ok || first.plan.native.family !== 'claude' || first.plan.native.mode !== 'gated') throw new Error('missing gated plan');
    first.plan.grant.root = '/edited-plan';
    first.plan.native.managedSettings.allowManagedPermissionRulesOnly = false;
    const filesystem = first.plan.native.sandbox?.filesystem;
    if (!filesystem || typeof filesystem !== 'object' || !('denyRead' in filesystem) || !Array.isArray(filesystem.denyRead)) throw new Error('missing read denies');
    filesystem.denyRead.pop();
    expect.soft(grant).toEqual(grants.writeProject);
    expect.soft(scaffold.managedSettings).toEqual({ allowManagedPermissionRulesOnly: true, allowManagedMcpServersOnly: true });
    expect.soft(scaffold.sandbox.filesystem.denyRead).toEqual(['/Users/other', '/Volumes']);
    const second = planEnforcement(cells, 'claude', grants.writeProject, 'darwin', host('darwin', 'claude'));
    expect.soft(second).toMatchObject({ ok: true, plan: { grant: grants.writeProject, native: {
      managedSettings: { allowManagedPermissionRulesOnly: true },
      sandbox: { filesystem: { denyRead: ['/Users/other', '/Volumes'] } },
    } } });
    grant.root = '/edited-input';
    scaffold.managedSettings.allowManagedMcpServersOnly = false;
    expect.soft(first.plan.grant.root).toBe('/edited-plan');
    expect.soft(first.plan.native.managedSettings.allowManagedMcpServersOnly).toBe(true);
  });

  it('uses Claude gated tools, read-deny scaffold and Bash sandbox on macOS', () => {
    const result = planEnforcement(table('claude', grants.writeProject, live(claudeGated)), 'claude', grants.writeProject, 'darwin', host('darwin', 'claude'));
    expect(result).toMatchObject({ ok: true, plan: {
      readableRoots: [root], writableRoots: [root], notices: [], native: {
        family: 'claude', mode: 'gated', permissionMode: 'default', shell: 'sandboxed',
        tools: ['Read', 'Grep', 'Glob', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Bash'],
        sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
          filesystem: { denyRead: ['/Users/other', '/Volumes'], allowRead: [root], allowWrite: [root] } },
      },
    } });
  });

  it.each(['linux', 'win32'] as const)('runs the live-proven Claude file gate with Bash off on %s', os => {
    const result = planEnforcement(table('claude', grants.qaProject, live(claudeGated, os), os), 'claude', grants.qaProject, os, host(os, 'claude'));
    expect(result).toMatchObject({ ok: true, plan: { readableRoots: [root], writableRoots: [], notices: [BASH_OFF_NOTICE],
      native: { family: 'claude', mode: 'gated', shell: 'off', sandbox: null } } });
    if (result.ok && result.plan.native.family === 'claude' && result.plan.native.mode === 'gated') {
      expect(result.plan.native.tools).not.toContain('Bash');
    }
  });

  it('keeps the independent MCP notice text available for the later configuration-aware consumer', () => {
    expect(MCP_OFF_NOTICE).toBe('此档位已停用你配置的 MCP 服务器，完全访问下可用。');
  });

  it('retains missing and explicit refusal reasons, including matrix refusals', () => {
    const missing = planEnforcement({}, 'codex', grants.qaProject, 'darwin', host());
    expect(missing).toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    const cases = [
      ['codex', grants.qaProject, 'linux', 'read-scope-unenforceable'],
      ['codex', grants.writeProject, 'linux', 'read-scope-unenforceable'],
      ['claude', grants.qaProject, 'linux', 'unverified-combination'],
    ] as const;
    for (const [provider, grant, os, reason] of cases) {
      const result = planEnforcement(table(provider, grant, { mode: 'refuse', reason }, os), provider, grant, os, host(os, provider));
      expect(result).toMatchObject({ ok: false, refusal: { reason } });
      if (!result.ok) {
        expect(result.refusal.message).toMatch(/[\u3400-\u9fff]/u);
        expect(result.refusal.hint).toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('refuses missing installation, logged-out or unknown authentication', () => {
    const cell = table('codex', grants.qaUnrestricted, live(codex.readOnly));
    expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'darwin', host('darwin', 'codex', { installed: {} })))
      .toMatchObject({ ok: false, refusal: { reason: 'provider-not-installed' } });
    for (const [auth, reason] of [['logged-out', 'not-logged-in'], ['unknown', 'unverified-combination']] as const) {
      const facts = host('darwin', 'codex', { installed: { codex: { installed: true, version: '1.2.3', auth } } });
      expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'darwin', facts))
        .toMatchObject({ ok: false, refusal: { reason } });
    }
  });

  it('requires the exact installed version and OS of a live probe', () => {
    const base = live(codex.readOnly);
    const cell = table('codex', grants.qaUnrestricted, base);
    for (const version of [undefined, '1.2.4', '^1.2.3', '1.2.3-beta.1']) {
      const facts = host('darwin', 'codex', { installed: { codex: { installed: true, version, auth: 'ok' } } });
      expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'darwin', facts))
        .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    }
    expect(planEnforcement(table('codex', grants.qaUnrestricted, live(codex.readOnly, 'linux')), 'codex', grants.qaUnrestricted, 'darwin', host()))
      .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'darwin', host('linux')))
      .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'darwin', host()).ok).toBe(true);
  });

  it('requires Windows sandbox readiness for restricted Codex cells', () => {
    const cell = table('codex', grants.qaUnrestricted, live(codex.readOnly, 'win32'), 'win32');
    expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'win32', host('win32')))
      .toMatchObject({ ok: false, refusal: { reason: 'windows-sandbox-not-ready' } });
    expect(planEnforcement(cell, 'codex', grants.qaUnrestricted, 'win32', host('win32', 'codex', { windowsSandboxReady: true })).ok).toBe(true);
  });

  it('does not fill missing Claude project deny-read paths or change a mismatched native family', () => {
    const noDeny = { ...claudeGated, sandbox: { filesystem: {} } } satisfies NativeSettings;
    expect(planEnforcement(table('claude', grants.qaProject, live(noDeny)), 'claude', grants.qaProject, 'darwin', host('darwin', 'claude')))
      .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    expect(planEnforcement(table('codex', grants.qaProject, live(claudeFull)), 'codex', grants.qaProject, 'darwin', host()))
      .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
  });
});

describe('proof audit', () => {
  it('starts with no registered proofs', () => expect(PROOFS).toEqual({}));

  it.each(['darwin', 'linux', 'win32'] as const)('accepts unrestricted documentary full cells on %s without an installed version', os => {
    for (const [provider, native] of [['codex', codex.full], ['claude', claudeFull]] as const) {
      const cell = { mode: 'enforced', mechanisms: [], native, proof: { kind: 'doc', ref: 'fixture.unrestricted-setting' } } satisfies Cell;
      const cells = table(provider, grants.full, cell, os);
      const facts = host(os, provider, { installed: { [provider]: { installed: true, auth: 'ok' } } });
      expect(auditTable(cells)).toEqual([]);
      expect(planEnforcement(cells, provider, grants.full, os, facts)).toEqual({ ok: true, plan: {
        provider, grant: grants.full, readableRoots: 'unrestricted', writableRoots: 'unrestricted', native, notices: [],
      } });
      for (const [installed, auth, reason] of [
        [false, 'ok', 'provider-not-installed'], [true, 'logged-out', 'not-logged-in'], [true, 'unknown', 'unverified-combination'],
      ] as const) {
        expect(planEnforcement(cells, provider, grants.full, os, host(os, provider, {
          installed: { [provider]: { installed, auth } },
        }))).toMatchObject({ ok: false, refusal: { reason } });
      }
    }
  });

  it('rejects full mechanisms and narrower native settings with documentary or live proof', () => {
    const proofs: Proof[] = [{ kind: 'doc', ref: 'fixture' }, { kind: 'live', probe: 'test.canary', os: 'darwin', provenFor: '1.2.3' }];
    const mechanisms: Mechanism[] = ['os-sandbox', 'tool-gate', 'provider-gate', 'launch-args'];
    for (const proof of proofs) {
      for (const [provider, unrestricted, restricted] of [
        ['codex', codex.full, [codex.profileRead, codex.profileWrite, codex.readOnly, codex.workspace]],
        ['claude', claudeFull, [claudeGated]],
      ] as const) {
        const invalid: Cell[] = [
          ...mechanisms.map(mechanism => ({ mode: 'enforced' as const, mechanisms: [mechanism], native: unrestricted, proof })),
          ...restricted.map(native => ({ mode: 'enforced' as const, mechanisms: [], native, proof })),
        ];
        for (const cell of invalid) {
          const cells = table(provider, grants.full, cell);
          expect(auditTable(cells)).toEqual([key(provider, grants.full)]);
          expect(planEnforcement(cells, provider, grants.full, 'darwin', host('darwin', provider)))
            .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
        }
      }
    }
  });

  it('rejects narrower fields attached to unrestricted discriminators and incomplete proofs', () => {
    const invalidNatives = [
      { ...codex.full, sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      { ...claudeFull, tools: ['Read'] },
      { ...claudeFull, permissionMode: 'default' },
      { ...claudeFull, allowDangerouslySkipPermissions: false },
      { ...claudeFull, managedSettings: { permissions: { deny: ['Write'] } } },
    ];
    for (const native of invalidNatives) {
      for (const proof of [{ kind: 'doc', ref: 'fixture' }, { kind: 'live', probe: 'test.canary', os: 'darwin', provenFor: '1.2.3' }]) {
        const cells = table(native.family, grants.full, { mode: 'enforced', mechanisms: [], native, proof } as unknown as Cell);
        expect(auditTable(cells)).toEqual([key(native.family, grants.full)]);
        expect(planEnforcement(cells, native.family, grants.full, 'darwin', host('darwin', native.family)))
          .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
      }
    }
    for (const proof of [undefined, { kind: 'doc', ref: '' }, { kind: 'doc', ref: '  ' },
      { kind: 'live', probe: '', os: 'darwin', provenFor: '1.2.3' },
      { kind: 'live', probe: 'fixture', os: 'darwin' },
    ]) {
      const cells = table('codex', grants.full, { mode: 'enforced', mechanisms: [], native: codex.full, proof } as unknown as Cell);
      expect(auditTable(cells)).toEqual(['codex:full:-:darwin']);
      expect(planEnforcement(cells, 'codex', grants.full, 'darwin', host()))
        .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    }
  });

  it('keeps every restricted current native variant ineligible for documentary launch-args proof', () => {
    for (const [provider, grant, native] of [
      ['codex', grants.qaProject, codex.profileRead], ['codex', grants.writeProject, codex.profileWrite],
      ['codex', grants.qaUnrestricted, codex.readOnly], ['codex', grants.writeUnrestricted, codex.workspace],
      ['claude', grants.qaProject, claudeGated], ['claude', grants.writeUnrestricted, claudeGated],
    ] as const) {
      for (const mechanisms of [['launch-args'], ['launch-args', 'os-sandbox'], ['launch-args', 'tool-gate'], ['launch-args', 'provider-gate']] satisfies Mechanism[][]) {
        const cells = table(provider, grant, { mode: 'enforced', mechanisms, native, proof: { kind: 'doc', ref: 'fixture' } });
        expect(auditTable(cells)).toEqual([key(provider, grant)]);
        expect(planEnforcement(cells, provider, grant, 'darwin', host('darwin', provider)))
          .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
      }
    }
  });

  it('rejects a documentary full native family mismatch', () => {
    const cells = table('codex', grants.full, { mode: 'enforced', mechanisms: [], native: claudeFull, proof: { kind: 'doc', ref: 'fixture' } });
    expect(planEnforcement(cells, 'codex', grants.full, 'darwin', host()))
      .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
  });

  it('detaches documentary full plans from their input and later plans', () => {
    const grant = { ...grants.full };
    const native = { ...claudeFull };
    const cells = table('claude', grant, { mode: 'enforced', mechanisms: [], native, proof: { kind: 'doc', ref: 'fixture' } });
    const first = planEnforcement(cells, 'claude', grant, 'darwin', host('darwin', 'claude'));
    if (!first.ok) throw new Error('missing full plan');
    first.plan.grant.root = '/changed-plan';
    expect(native).toEqual(claudeFull);
    expect(grant).toEqual(grants.full);
    const second = planEnforcement(cells, 'claude', grant, 'darwin', host('darwin', 'claude'));
    expect(second).toEqual({ ok: true, plan: { provider: 'claude', grant: grants.full,
      readableRoots: 'unrestricted', writableRoots: 'unrestricted', native: claudeFull, notices: [] } });
    grant.root = '/changed-input';
    expect(first.plan.grant.root).toBe('/changed-plan');
    expect(first.plan.native).not.toBe(native);
    if (!second.ok) throw new Error('missing second full plan');
    expect(second.plan.grant.root).toBe(root);
    expect(second.plan.native).not.toBe(first.plan.native);
  });

  it('reports missing, incomplete, or document proofs on every non-launch-args cell', () => {
    const invalid = {
      'codex:qa:project:darwin': { mode: 'enforced', mechanisms: ['os-sandbox'], native: codex.profileRead },
      'codex:qa:unrestricted:darwin': { mode: 'enforced', mechanisms: ['os-sandbox'], native: codex.readOnly, proof: { kind: 'live', probe: '', os: 'darwin', provenFor: '1.2.3' } },
      'codex:full:-:darwin': { mode: 'enforced', mechanisms: ['provider-gate'], native: codex.full, proof: { kind: 'doc', ref: 'design' } },
      'claude:qa:unrestricted:darwin': { mode: 'enforced', mechanisms: ['launch-args', 'provider-gate'], native: claudeGated, proof: { kind: 'doc', ref: 'fixture' } },
    } as unknown as EnforcementTable;
    expect(auditTable(invalid)).toEqual([
      'claude:qa:unrestricted:darwin', 'codex:full:-:darwin', 'codex:qa:project:darwin', 'codex:qa:unrestricted:darwin',
    ]);
  });

  it('rejects a native sandbox relabelled as launch-args without a live version proof', () => {
    const doc = { mode: 'enforced', mechanisms: ['launch-args'], native: codex.readOnly, proof: { kind: 'doc', ref: 'fixture' } } satisfies Cell;
    const acceptable = table('codex', grants.qaUnrestricted, doc);
    expect.soft(auditTable(acceptable)).toEqual(['codex:qa:unrestricted:darwin']);
    expect.soft(planEnforcement(acceptable, 'codex', grants.qaUnrestricted, 'darwin', host('darwin', 'codex', {
      installed: { codex: { installed: true, auth: 'ok' } },
    }))).toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
    const invalid = table('codex', grants.qaUnrestricted, { ...doc, mechanisms: ['launch-args', 'provider-gate'] });
    expect(planEnforcement(invalid, 'codex', grants.qaUnrestricted, 'darwin', host()))
      .toMatchObject({ ok: false, refusal: { reason: 'unverified-combination' } });
  });
});
