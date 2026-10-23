import type { Grant, Os, ProbeId, ProviderId, ReadScope, Tier } from '../model';

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
