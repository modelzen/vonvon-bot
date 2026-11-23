import type { Principal } from '../principal';
import { RpcError } from '../errors';

export const INSTALL_RETIRED = '群配方安装已停用。请把配方版本交给 Bot，再告诉它要调整哪个群。';

export function recipeInstallRpc(principal: Principal): never {
  if (principal.kind !== 'owner') throw new RpcError('permission_denied', '只有主人才可操作配方资源。');
  throw new RpcError('unsupported', INSTALL_RETIRED);
}
