import type { RecipeInstallReply, RecipeInstallRequest } from '@vonvon/protocol';
import type { RecipeInstaller } from '../../recipe/installer';
import type { Principal } from '../principal';
import { RpcError } from '../errors';
import type { RpcOutcome } from '../rpc';

export async function recipeInstallRpc(installer: RecipeInstaller | undefined, principal: Principal, request: RecipeInstallRequest): Promise<RpcOutcome<RecipeInstallReply>> {
  if (principal.kind !== 'owner') throw new RpcError('permission_denied', '配方安装只能由主人在客户端发起');
  if (!installer) throw new RpcError('unsupported', '此设备尚未配置配方服务');
  const value = await installer.request(request);
  return request.type === 'status' ? {kind: 'read', value} : {kind: 'mutation', reply: () => value};
}
