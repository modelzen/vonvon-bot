import {RichInstaller,type RichPorts} from './rich-installer';
import { z } from 'zod';
import { recipeRedemptionSchema, type RecipeAuthorization, type RecipeInstallReply, type RecipeInstallRequest } from '@vonvon/protocol';
import type { DeviceIdentity } from '../remote/device';
import { parseManifest } from './manifest';
import { installProof } from './proof';
import { RecipeStore, type RecipeStoreOptions } from './store';
import type { RecipeOperation } from './types';

export interface RecipeInstallerOptions extends Omit<RecipeStoreOptions, 'targetPublicKey'> {
  rich?:RichPorts;
  apiOrigin: string;
  allowLoopbackForTests?: boolean;
  device: DeviceIdentity;
  fetch?: typeof fetch;
}
export function recipeApiOrigin(value: string, allowLoopbackForTests = false): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowLoopbackForTests && loopback && url.protocol === 'http:'))
    || (value !== url.origin && value !== url.origin + '/')) throw new Error('配方服务必须配置固定 HTTPS origin');
  return url.origin;
}
class RecipeServiceError extends Error {
  constructor(readonly status: number, readonly code?: string) {super(`配方服务暂未确认安装 (${status})`);}
}
export class RecipeInstaller {
  readonly store: RecipeStore;
  private readonly rich?:RichInstaller;
  private readonly origin: string;
  private readonly turns = new Map<string, Promise<RecipeInstallReply>>();
  constructor(private readonly options: RecipeInstallerOptions) {
    this.origin = recipeApiOrigin(options.apiOrigin, options.allowLoopbackForTests);
    this.store = new RecipeStore({...options, targetPublicKey: options.device.keypair.publicKey});
    if(options.rich)this.rich=new RichInstaller(options,this.origin,{...options.rich,brokerOrigin:recipeApiOrigin(options.rich.brokerOrigin,options.allowLoopbackForTests)},this.store);
  }
  private async post(operationId: string, action: 'redeem' | 'complete' | 'unredeemable', body: object): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.origin}/v1/operations/${operationId}/${action}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000),
    });
    if (!response.body) throw new Error('配方服务响应无效');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 100000) throw new Error('配方服务响应过大');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) {
      const error = z.object({error: z.object({code: z.string()})}).safeParse(payload);
      throw new RecipeServiceError(response.status, error.success ? error.data.error.code : undefined);
    }
    return payload;
  }
  private async reconcile(botId: string, operationId: string): Promise<RecipeInstallReply> {
    const operation = await this.store.get(botId, operationId);
    if (operation.status !== 'prepared' || operation.authorization || operation.issuerState !== 'issuing') return this.store.status(botId, operationId);
    const result = z.object({operationId: z.string().uuid(), unredeemable: z.boolean()}).strict()
      .parse(await this.post(operationId, 'unredeemable', {accountId: operation.accountId}));
    if (result.operationId !== operationId) throw new Error('配方服务回执不一致');
    return result.unredeemable ? this.store.rejectUnredeemed(botId, operationId, '云端确认无法首次兑换') : this.store.status(botId, operationId);
  }
  private credential(operation: RecipeOperation): {ticket: string; nonce: string; proof: string} {
    if (!operation.authorization || operation.targetPublicKey !== this.options.device.keypair.publicKey) throw new Error('配方授权不属于本机');
    return {ticket: operation.authorization.ticket, nonce: operation.nonce, proof: installProof(this.options.device, operation.authorization)};
  }
  private async complete(operation: RecipeOperation): Promise<void> {
    if (operation.cloudCompletion !== 'required' || !operation.authorization || (operation.status !== 'applied' && operation.status !== 'rejected')) return;
    const result = z.object({operationId: z.string().uuid(), status: z.enum(['applied', 'rejected'])}).strict()
      .parse(await this.post(operation.operationId, 'complete', {...this.credential(operation), outcome: operation.status}));
    if (result.operationId !== operation.operationId || result.status !== operation.status) throw new Error('配方服务回执不一致');
    await this.store.confirmCompletion(operation.bot.appId, operation.operationId);
  }
  private async commit(botId: string, operationId: string, authorization?: RecipeAuthorization): Promise<RecipeInstallReply> {
    const operation = await this.store.authorize(botId, operationId, authorization);
    if (operation.status === 'applied' || operation.status === 'rejected') {
      await this.complete(operation);
      return this.store.status(botId, operationId);
    }
    let raw: unknown;
    try {raw = await this.post(operationId, 'redeem', this.credential(operation));}
    catch (error) {
      if (operation.cloudCompletion === 'none' && error instanceof RecipeServiceError
        && ((error.status === 409 && error.code === 'operation_cancelled') || (error.status === 410 && error.code === 'operation_expired'))) {
        return this.store.rejectUnredeemed(botId, operationId, error.code === 'operation_cancelled' ? '云端已取消' : '安装授权已过期');
      }
      throw error;
    }
    const redeemed = recipeRedemptionSchema.parse(raw);
    const expected = operation.authorization!;
    for (const key of Object.keys(expected) as Array<keyof RecipeAuthorization>) {
      if (key !== 'status' && key !== 'ticket' && redeemed[key] !== expected[key]) throw new Error('配方兑换回执与本机准备不一致');
    }
    if (redeemed.manifest !== operation.manifest) throw new Error('配方兑换内容与预览不一致');
    parseManifest(redeemed.manifest, redeemed.manifestSha256);
    if (redeemed.status !== 'redeemed') throw new Error('配方服务已结束该操作，本机没有应用记录');
    await this.store.redeemed(botId, operationId);
    const applied = await this.store.apply(botId, operationId, this.options.isInChat);
    await this.complete(await this.store.get(botId, operationId));
    return applied;
  }
  async request(request: RecipeInstallRequest): Promise<RecipeInstallReply> {
    if(request.type==='richPrepare'||request.type==='richCommit'||request.type==='richStatus'||request.type==='richSetup'){if(!this.rich)throw new Error('此设备尚未启用完整配方');return this.rich.request(request);}
    if (request.type==='source' || request.type==='ignoreVersion') return this.store.source(request);
    if (request.type === 'createdGroup') return this.store.createdGroup(request.botId, request.requestId);
    if (request.type === 'prepare') return this.store.prepare(request);
    if (request.type === 'status') return this.store.status(request.botId, request.operationId);
    if (request.type === 'issuing') return this.store.issuing(request.botId, request.operationId);
    if (request.type === 'reconcile') return this.reconcile(request.botId, request.operationId);
    if (request.type === 'cancel') return this.store.cancel(request.botId, request.operationId);
    const key = `${request.botId}:${request.operationId}`;
    const prior = this.turns.get(key);
    const run = (prior ?? Promise.resolve()).catch(() => undefined).then(() => this.commit(request.botId, request.operationId, request.authorization));
    this.turns.set(key, run);
    try { return await run; }
    finally { if (this.turns.get(key) === run) this.turns.delete(key); }
  }
}
