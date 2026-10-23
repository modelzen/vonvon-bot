import { PermissionInputError, permissionTiers, type PermissionTable } from './types';

function noCustom(): never {
  throw new PermissionInputError('这个 provider 没有高级设置。');
}
export function genericTable(backend: string): PermissionTable {
  return {
    backend,
    tiers: env => permissionTiers(env),
    strength: () => '这个 provider 没有说明它能挡到什么程度。',
    parseCustom: noCustom,
    matchTier: () => undefined,
    effect: noCustom,
    describe: noCustom,
    fromLegacy: () => undefined,
  };
}
