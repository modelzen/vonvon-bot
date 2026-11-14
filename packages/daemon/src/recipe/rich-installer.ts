import { isDeepStrictEqual } from 'node:util';
import {
  recipeRichInstallAuthorizationSchema,
  recipeRichInstallRedemptionSchema,
  verifyRichRecipeRelease,
  type RecipeInstallReply,
} from '@vonvon/protocol';
import { z } from 'zod';
import { requireRichRegistry } from '../config/bots';
import { botDir } from '../config/paths';
import type { RecipeInstallerOptions } from './installer';
import { stageRichRecipeGeneration } from './rich-generation';
import { richInstallProof, type RichProofStage } from './rich-install-proof';
import {
  prepareRich,
  expireRich,
  editRichJournal,
  readRichJournal,
  richStatus,
  type RichRequest,
  type RichJournal,
  type Activation,
} from './rich-runtime';
import type { RecipeStore } from './store';
import { sha256 } from './manifest';
export type RichBotOp =
  | { kind: 'richActivate'; activation: Activation }
  | { kind: 'richSetup'; request: Extract<RichRequest, { type: 'richSetup' }> };
export interface RichPorts {
  brokerOrigin: string;
  bot: (botId: string, op: RichBotOp) => Promise<unknown>;
}
export class RichInstaller {
  private turns = new Map<string, Promise<RecipeInstallReply>>();
  constructor(
    private options: RecipeInstallerOptions,
    private origin: string,
    private ports: RichPorts,
    private budget: RecipeStore,
  ) {}
  async request(req: RichRequest): Promise<RecipeInstallReply> {
    if (req.type === 'richPrepare') {
      const result = await prepareRich(
        req,
        this.options.device.keypair.publicKey,
        (bot, chat) => this.options.isInChat(bot.appId, chat, bot),
        this.budget.reserveRichBudget.bind(this.budget),
      );
      if (result.kind === 'richPrepared') await requireRichRegistry();
      return result;
    }
    if (req.type === 'richSetup')
      return (await this.ports.bot(req.botId, { kind: 'richSetup', request: req })) as RecipeInstallReply;
    if (req.type === 'richStatus' || req.type === 'richCancel' || req.type === 'richIssuing') {
      return editRichJournal(req.botId, req.operationId, (op) => {
        expireRich(op, Date.now());
        if (op.status === 'prepared' && op.issuerState === 'unissued') {
          if (req.type === 'richIssuing') op.issuerState = 'issuing';
          if (req.type === 'richCancel') {
            op.settled = true;
            op.status = 'rejected';
            op.reason = '主人已取消';
          }
        }
        return richStatus(op);
      });
    }
    if (req.type === 'richReconcile') {
      const op = await readRichJournal(req.botId, req.operationId);
      if (op.status !== 'prepared' || op.issuerState !== 'issuing') return richStatus(op);
      const result = z
        .object({ operationId: z.string().uuid(), unredeemable: z.boolean() })
        .strict()
        .parse(JSON.parse((await this.send(op, 'unredeemable', { accountId: op.account }, 4096, false)).toString('utf8')));
      if (result.operationId !== op.id) throw new Error('配方服务回执不一致');
      return editRichJournal(req.botId, op.id, (j) => {
        if (result.unredeemable && j.status === 'prepared' && j.issuerState === 'issuing' && !j.authorization) {
          j.status = 'rejected';
          j.reason = '云端确认无法首次兑换';
          j.settled = true;
        }
        return richStatus(j);
      });
    }
    const prior = this.turns.get(req.operationId);
    const run = (prior ?? Promise.resolve()).catch(() => undefined).then(() => this.commit(req));
    this.turns.set(req.operationId, run);
    try {
      return await run;
    } finally {
      if (this.turns.get(req.operationId) === run) this.turns.delete(req.operationId);
    }
  }
  private async post(op: RichJournal, stage: RichProofStage, path: string, max: number, object = false): Promise<Buffer> {
    const auth = op.authorization!;
    const body = {
      ticket: auth.ticket,
      nonce: op.nonce,
      proof: richInstallProof(this.options.device, auth, stage),
      ...(stage === 'redeem' ? {} : { outcome: stage }),
    };
    return this.send(op, path, body, max, object);
  }
  private async send(op: RichJournal, path: string, body: object, max: number, object: boolean): Promise<Buffer> {
    const response = await (this.options.fetch ?? fetch)(
      `${object ? this.ports.brokerOrigin : this.origin}/v2/operations/${op.id}/${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`配方服务尚未确认 (${response.status})`);
    }
    const chunks: Uint8Array[] = [];
    let count = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if ((count += chunk.value.length) > max) throw new Error('配方响应超过预期');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }
  private async commit(req: Extract<RichRequest, { type: 'richCommit' }>): Promise<RecipeInstallReply> {
    const { operationId: id, botId } = req;
    if (req.authorization)
      await editRichJournal(botId, id, (j) => {
        const a = recipeRichInstallAuthorizationSchema.parse(req.authorization),
          {
            operationId,
            accountId,
            deadline: _deadline,
            serverPublicKey: _server,
            ticket: _ticket,
            status: _status,
            ...intent
          } = a;
        if (
          operationId !== j.id ||
          accountId !== j.account ||
          !isDeepStrictEqual(intent, j.intent) ||
          (j.authorization && !isDeepStrictEqual({ ...j.authorization, status: a.status }, a))
        )
          throw new Error('授权与本机准备不符');
        if (j.issuerState === 'unissued' || (j.status === 'rejected' && !j.authorization))
          throw new Error('本机未开始授权或准备已取消');
        j.authorization ??= a;
        j.issuerState = 'authorized';
      });
    let op = await readRichJournal(botId, id);
    if (op.settled) return richStatus(op);
    if (!op.authorization) throw new Error('尚未取得安装授权');
    if (op.status === 'prepared' || op.status === 'redeemed') {
      const r = recipeRichInstallRedemptionSchema.parse(
        JSON.parse((await this.post(op, 'redeem', 'redeem', 12000)).toString('utf8')),
      );
      const { release, manifest, status, ...binding } = r;
      const { ticket: _ticket, status: _status, ...expected } = op.authorization;
      if (
        status !== 'redeemed' ||
        !isDeepStrictEqual(binding, expected) ||
        !isDeepStrictEqual({ release, manifest, accountId: r.accountId }, op.preview)
      )
        throw new Error('云端兑换与本机预览不一致');
      await editRichJournal(botId, id, (j) => {
        if (j.status === 'prepared') j.status = 'redeemed';
      });
      const bytes = async (d: { bytes: number; sha256: string; objectId: string }) => {
        const data = await this.post(op, 'redeem', `objects/${d.objectId}`, d.bytes, true);
        if (data.byteLength !== d.bytes || sha256(data) !== d.sha256) throw new Error('配方对象校验失败');
        return data;
      };
      await requireRichRegistry();
      const manifestBytes = await bytes(manifest);
      await verifyRichRecipeRelease(release, manifestBytes);
      const staged = await stageRichRecipeGeneration({
        botDataRoot: botDir(botId),
        installationId: op.install,
        generationId: op.staging,
        release,
        canonicalUTF8: manifestBytes,
        readMember: async (_r, d) => bytes(d),
      });
      await this.ports.bot(botId, { kind: 'richActivate', activation: { generation: staged.pointer, operationId: id } });
      op = await readRichJournal(botId, id);
    }
    if (op.status === 'applied' || op.status === 'rejected') {
      const result = z
        .object({
          operationId: z.string().uuid(),
          status: z.enum(['applied', 'rejected']),
          disposition: z.enum(['blocked', 'recorded', 'settled']),
        })
        .strict()
        .parse(JSON.parse((await this.post(op, op.status, 'complete', 4096)).toString('utf8')));
      if (result.operationId !== op.id || result.status !== op.status) throw new Error('配方完成回执不一致');
      await editRichJournal(botId, id, (j) => {
        if (j.status !== result.status) throw new Error('本机结果不一致');
        j.settled = true;
      });
    }
    return richStatus(await readRichJournal(botId, id));
  }
}
