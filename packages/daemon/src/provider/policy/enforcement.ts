import type { Grant, HostFacts, Os, ProbeId, ProviderId, ReadScope, Tier } from '../model';
import { BASH_OFF_NOTICE, refusalMessage } from './messages.zh';

export type Mechanism = 'os-sandbox' | 'tool-gate' | 'launch-args' | 'provider-gate';
export type Proof =
  | { kind: 'live'; probe: ProbeId; os: Os; provenFor: string }
  | { kind: 'doc'; ref: string };

export type RefuseReason =
  | 'read-scope-unenforceable' | 'tier-unenforceable' | 'sandbox-dependency-missing'
  | 'unverified-combination' | 'windows-sandbox-not-ready' | 'sandbox-not-confirmed'
  | 'provider-not-installed' | 'not-logged-in' | 'custom-command-unset' | 'custom-command-invalid'
  | 'owned-work-unverified';

export type NativeSettings =
  | { family: 'codex'; sandbox: 'danger-full-access' }
  | { family: 'codex'; sandbox: 'read-only'; sandboxPolicy: { type: 'readOnly'; networkAccess: boolean } }
  | { family: 'codex'; sandbox: 'workspace-write'; sandboxPolicy: { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeSlashTmp: true; excludeTmpdirEnvVar: true } }
  | { family: 'codex'; sandbox: 'profile'; profile: 'feishu'; rootAccess: 'read' | 'write'; network: boolean }
  | { family: 'claude'; mode: 'bypass'; permissionMode: 'bypassPermissions'; allowDangerouslySkipPermissions: true }
  | { family: 'claude'; mode: 'gated'; permissionMode: 'default'; tools: string[]; sandbox: Record<string, unknown> | null; managedSettings: Record<string, unknown>; shell: 'sandboxed' | 'off' }
  | { family: 'acp'; bypass: boolean }
  | { family: 'pi'; tools?: string[] };

export type Cell =
  | { mode: 'enforced'; mechanisms: Mechanism[]; native: NativeSettings; proof: Proof; loss?: 'bash-off' }
  | { mode: 'refuse'; reason: RefuseReason };

export type CellKey = `${ProviderId}:${Tier}:${ReadScope | '-'}:${Os}`;
export type EnforcementTable = Readonly<Partial<Record<CellKey, Cell>>>;

export interface EnforcementPlan {
  readonly provider: ProviderId;
  readonly grant: Grant;
  readonly readableRoots: string[] | 'unrestricted';
  readonly writableRoots: string[] | 'unrestricted';
  readonly native: NativeSettings;
  readonly notices: string[];
}

export type Refusal = { reason: RefuseReason; message: string; hint: string };
export type PlanResult = { ok: true; plan: EnforcementPlan } | { ok: false; refusal: Refusal };

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isCompleteProof(proof: Proof | undefined): proof is Proof {
  if (!proof) return false;
  if (proof.kind === 'doc') return typeof proof.ref === 'string' && proof.ref.trim().length > 0;
  return proof.kind === 'live' && typeof proof.probe === 'string' && proof.probe.trim().length > 0
    && (proof.os === 'darwin' || proof.os === 'linux' || proof.os === 'win32')
    && typeof proof.provenFor === 'string' && PLAIN_VERSION.test(proof.provenFor);
}

function isUnrestricted(native: NativeSettings): boolean {
  const keys = Object.keys(native);
  switch (native.family) {
    case 'codex':
      return native.sandbox === 'danger-full-access'
        && keys.every(key => key === 'family' || key === 'sandbox');
    case 'claude':
      return native.mode === 'bypass' && native.permissionMode === 'bypassPermissions'
        && native.allowDangerouslySkipPermissions === true
        && keys.every(key => ['family', 'mode', 'permissionMode', 'allowDangerouslySkipPermissions'].includes(key));
    case 'acp':
      return native.bypass === true && keys.every(key => key === 'family' || key === 'bypass');
    case 'pi':
      return keys.every(key => key === 'family');
  }
}

function isProofAllowed(key: CellKey, cell: Extract<Cell, { mode: 'enforced' }>): boolean {
  if (!isCompleteProof(cell.proof)) return false;
  const [, tier, scope] = key.split(':');
  if (tier === 'full') {
    return scope === '-' && cell.mechanisms.length === 0 && isUnrestricted(cell.native);
  }
  if (cell.proof.kind === 'live') return true;
  return (tier === 'qa' || tier === 'write') && scope === 'unrestricted'
    && cell.mechanisms.length === 1 && cell.mechanisms[0] === 'launch-args'
    && cell.native.family === 'pi' && cell.native.tools !== undefined && cell.native.tools.length > 0
    && cell.native.tools.every(tool => ['read', 'grep', 'find', 'ls'].includes(tool))
    && Object.keys(cell.native).every(key => key === 'family' || key === 'tools');
}

export function auditTable(table: EnforcementTable): CellKey[] {
  const failures: CellKey[] = [];
  for (const key of Object.keys(table).sort()) {
    const cell = table[key as CellKey];
    if (cell?.mode === 'enforced' && !isProofAllowed(key as CellKey, cell)) failures.push(key as CellKey);
  }
  return failures;
}

function sameNativeFamily(provider: ProviderId, native: NativeSettings): boolean {
  return native.family === provider;
}

function codexNative(grant: Grant, scaffold: NativeSettings): NativeSettings | undefined {
  if (scaffold.family !== 'codex') return undefined;
  if (grant.tier === 'full') return scaffold.sandbox === 'danger-full-access' ? scaffold : undefined;
  if (grant.readScope === 'project') {
    if (scaffold.sandbox !== 'profile' || scaffold.profile !== 'feishu') return undefined;
    return { family: 'codex', sandbox: 'profile', profile: 'feishu', rootAccess: grant.tier === 'qa' ? 'read' : 'write', network: grant.network };
  }
  if (grant.tier === 'qa') {
    if (scaffold.sandbox !== 'read-only') return undefined;
    return { family: 'codex', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: grant.network } };
  }
  if (scaffold.sandbox !== 'workspace-write') return undefined;
  return { family: 'codex', sandbox: 'workspace-write', sandboxPolicy: {
    type: 'workspaceWrite', writableRoots: [grant.root], networkAccess: grant.network,
    excludeSlashTmp: true, excludeTmpdirEnvVar: true,
  } };
}

function claudeTools(grant: Exclude<Grant, { tier: 'full' }>, bash: boolean): string[] {
  const tools = ['Read', 'Grep', 'Glob', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent'];
  if (grant.tier === 'write') tools.push('Edit', 'Write', 'NotebookEdit');
  if (grant.network) tools.push('WebFetch', 'WebSearch');
  if (bash) tools.push('Bash');
  return tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function claudeNative(grant: Grant, os: Os, host: HostFacts, scaffold: NativeSettings): NativeSettings | undefined {
  if (scaffold.family !== 'claude') return undefined;
  if (grant.tier === 'full') return scaffold.mode === 'bypass' ? scaffold : undefined;
  if (scaffold.mode !== 'gated') return undefined;

  const bash = os === 'darwin' ? host.commandSandbox === 'seatbelt'
    : os === 'linux' && host.commandSandbox === 'bwrap';
  let sandbox: Record<string, unknown> | null = null;
  if (bash) {
    const scaffoldFilesystem = isRecord(scaffold.sandbox) ? scaffold.sandbox.filesystem : undefined;
    const denyRead = isRecord(scaffoldFilesystem) ? scaffoldFilesystem.denyRead : undefined;
    if (grant.readScope === 'project' && (!Array.isArray(denyRead) || denyRead.length === 0 || !denyRead.every(path => typeof path === 'string'))) return undefined;
    const filesystem: Record<string, unknown> = grant.readScope === 'project'
      ? { denyRead, allowRead: [grant.root] } : {};
    if (grant.tier === 'qa') filesystem.denyWrite = [grant.root];
    else filesystem.allowWrite = [grant.root];
    sandbox = {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, filesystem,
      ...(grant.network ? {} : { network: { allowedDomains: [], strictAllowlist: true } }),
    };
  }
  return {
    family: 'claude', mode: 'gated', permissionMode: 'default', tools: claudeTools(grant, bash),
    sandbox, managedSettings: scaffold.managedSettings, shell: bash ? 'sandboxed' : 'off',
  };
}

export function planEnforcement(
  table: EnforcementTable, provider: ProviderId, grant: Grant, os: Os, host: HostFacts,
): PlanResult {
  const refuse = (reason: RefuseReason, detail?: string): PlanResult => ({
    ok: false,
    refusal: refusalMessage(reason, { provider, os, tier: grant.tier, detail, installHint: host.installed[provider]?.hint }),
  });
  if (host.os !== os) return refuse('unverified-combination', '主机系统与请求系统不一致');
  const key: CellKey = `${provider}:${grant.tier}:${grant.tier === 'full' ? '-' : grant.readScope}:${os}`;
  const cell = table[key];
  if (!cell) return refuse('unverified-combination', '未登记权限单元');
  if (cell.mode === 'refuse') return refuse(cell.reason);
  if (!isProofAllowed(key, cell)) return refuse('unverified-combination', '权限单元缺少有效证明');
  if (!sameNativeFamily(provider, cell.native)) return refuse('unverified-combination', '权限单元与提供方不匹配');

  const install = host.installed[provider];
  if (!install?.installed) return refuse('provider-not-installed');
  if (install.auth === 'logged-out') return refuse('not-logged-in');
  if (install.auth !== 'ok') return refuse('unverified-combination', '登录状态未确认');
  if (cell.proof.kind === 'live') {
    if (cell.proof.os !== os || !install.version || !PLAIN_VERSION.test(install.version)
      || cell.proof.provenFor !== install.version) return refuse('unverified-combination', '已安装版本没有匹配的实机证明');
  }
  if (provider === 'codex' && grant.tier !== 'full' && os === 'win32' && host.windowsSandboxReady !== true) {
    return refuse('windows-sandbox-not-ready', host.windowsSandboxReady === false ? '未就绪' : '状态未知');
  }

  const native = provider === 'codex' ? codexNative(grant, cell.native)
    : provider === 'claude' ? claudeNative(grant, os, host, cell.native) : cell.native;
  if (!native) return refuse('unverified-combination', '权限单元缺少匹配的原生配置');
  const readableRoots = grant.tier === 'full' || grant.readScope === 'unrestricted' ? 'unrestricted' : [grant.root];
  const writableRoots = grant.tier === 'full' ? 'unrestricted' : grant.tier === 'qa' ? [] : [grant.root];
  const notices = native.family === 'claude' && native.mode === 'gated' && native.shell === 'off' ? [BASH_OFF_NOTICE] : [];
  return { ok: true, plan: structuredClone({ provider, grant, readableRoots, writableRoots, native, notices }) };
}
