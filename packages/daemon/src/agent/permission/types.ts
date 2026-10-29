import type { PermissionMode } from '../types';
import type { WindowsSandboxCapability } from '../codex-appserver/full-only';

export type Tier = PermissionMode;
export const TIER_NAMES: Record<Tier, string> = { qa: '只读', write: '工作区可写', full: '完全访问' };
export const TIER_SUMMARY: Record<Tier, string> = {
  qa: '能看工作区，不改文件，不联网。',
  write: '能改工作区里的文件，能联网。',
  full: '不限制，你这个账号能做的它都能做。',
};
/** 联网并进档位：只读不联网，工作区可写联网，完全访问不限制。 */
export const TIER_NETWORK: Record<Tier, boolean> = { qa: false, write: true, full: true };

export interface TierInfo {
  tier: Tier;
  /** 中文，最多五个字。 */
  name: string;
  summary: string;
  native: string;
  /** 有值时这一档不可用，展示原因。 */
  unavailable?: string;
}
/** vonvon 自己的功能只看效果，不依赖 provider 原生设置的细节。 */
export interface PermissionEffect { mode: Tier; network: boolean }
export interface TableEnv {
  platform: NodeJS.Platform;
  codexVersion?: string | null;
  codexWindowsSandbox?: WindowsSandboxCapability;
  fullOnly?: string;
  supportedModes?: readonly Tier[];
}
export class PermissionInputError extends Error {}
export interface NativeChoice { value: string; label: string; native: string; hint?: string }
export interface NativeField {
  key: string;
  label: string;
  native: string;
  kind: 'choice' | 'switch' | 'domains';
  choices?: NativeChoice[];
  hint?: string;
  showWhen?: { key: string; in: Array<string | boolean> };
}
export interface PermissionTable {
  backend: string;
  tiers(env: TableEnv): readonly [TierInfo, TierInfo, TierInfo];
  strength(env: TableEnv): string;
  fields(env: TableEnv): NativeField[];
  expand(tier: Tier): Record<string, unknown>;
  /** 校验自定义设置、补默认值，返回新对象；无效时抛 PermissionInputError。 */
  parseCustom(raw: unknown): Record<string, unknown>;
  matchTier(settings: Record<string, unknown>): Tier | undefined;
  effect(settings: Record<string, unknown>): PermissionEffect;
  /** 降级时旧版读到的效果，不能比自定义更宽。 */
  stored?(settings: Record<string, unknown>): PermissionEffect;
  describe(settings: Record<string, unknown>): string;
  fromLegacy(mode: Exclude<Tier, 'full'>, network: boolean): Record<string, unknown> | undefined;
}

/** 三张表共用档名、说明和可用性规则。 */
export function permissionTiers(env: TableEnv, native?: Record<Tier, string>): [TierInfo, TierInfo, TierInfo] {
  const row = (tier: Tier): TierInfo => ({
    tier, name: TIER_NAMES[tier], summary: TIER_SUMMARY[tier], native: native?.[tier] ?? '',
    ...(env.fullOnly && tier !== 'full'
      ? { unavailable: env.fullOnly }
      : env.supportedModes && !env.supportedModes.includes(tier)
        ? { unavailable: '这个 provider 没有这一档。' }
        : {}),
  });
  return [row('qa'), row('write'), row('full')];
}
