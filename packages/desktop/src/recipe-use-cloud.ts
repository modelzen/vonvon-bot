import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  recipeAuthorizationSchema,
  recipeManifestSchema,
  recipeLatestSchema,
  type RecipeManifest,
} from '@vonvon/protocol';
import type { NativeAccount } from './account-session.js';
import type { RecipeJournalRow } from './recipe-use-journal.js';

export class RecipeUseError extends Error {}
export class Unredeemable extends Error {}
export const changed = () => new RecipeUseError('账号或设备连接已改变。请重新打开配方，核对原操作。');
const invalid = () => new RecipeUseError('安装回执与预览不一致。请重新核对。');
const uuid = z.string().uuid();
const previewSchema = z
  .object({
    accountId: uuid,
    recipeId: uuid,
    versionId: uuid,
    manifest: z.string().min(1).max(80000),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type InstallPreview = z.infer<typeof previewSchema> & { content: RecipeManifest };
type Operation = Extract<RecipeJournalRow, { stage: 'operation' }>;
export interface RecipeAccountLease {
  accountId: string;
  signal: AbortSignal;
  check(): void;
}
export function recipeCloud(account: NativeAccount, lease: RecipeAccountLease) {
  async function read(path: string, body?: object) {
    lease.check();
    const response = await account.request(
      lease.accountId,
      path,
      {
        signal: lease.signal,
        ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      },
      lease.check,
    );
    lease.check();
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        lease.check();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 100000) throw invalid();
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(raw);
    return { raw, ok: response.ok, status: response.status, code: code.success ? code.data.error.code : undefined };
  }
  function unwrap(reply: Awaited<ReturnType<typeof read>>) {
    lease.check();
    if (!reply.ok)
      throw new RecipeUseError(
        reply.status === 403
          ? '当前账号没有此版本的安装权。'
          : reply.status === 429
            ? '安装操作过多，请稍后继续原操作。'
            : '云端未确认操作，请稍后核对原操作。',
      );
    return reply.raw;
  }
  return {
    async latest(recipeId: string) {
      const reply = recipeLatestSchema.parse(unwrap(await read('/v2/recipes/' + recipeId + '/latest-install-version')));
      if (reply.recipeId !== recipeId) throw invalid();
      return reply;
    },
    async preview(recipeId: string, versionId: string) {
      const parsed = previewSchema.parse(unwrap(await read('/v1/versions/' + versionId + '/install-preview')));
      if (parsed.accountId !== lease.accountId || parsed.recipeId !== recipeId || parsed.versionId !== versionId)
        throw invalid();
      const bytes = Buffer.from(parsed.manifest, 'base64url');
      if (
        bytes.toString('base64url') !== parsed.manifest ||
        createHash('sha256').update(bytes).digest('hex') !== parsed.manifestSha256
      )
        throw invalid();
      const manifest = recipeManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (manifest.recipeId !== recipeId || manifest.versionId !== versionId) throw invalid();
      return { ...parsed, content: manifest };
    },
    async authorize(row: Operation) {
      const body = {
        purpose: 'installBoundRole' as const,
        versionId: row.versionId,
        manifestSha256: row.operation.sha,
        targetPublicKey: row.pk,
        nonceCommitment: row.operation.commitment,
        generation: 1 as const,
      };
      const result = await read('/v1/operations/' + row.operation.id + '/authorize', body);
      if (
        (result.status === 410 && result.code === 'operation_expired') ||
        (result.status === 409 && result.code === 'operation_cancelled')
      )
        throw new Unredeemable();
      const reply = recipeAuthorizationSchema.parse(unwrap(result));
      if (
        reply.accountId !== lease.accountId ||
        reply.operationId !== row.operation.id ||
        Object.entries(body).some(([k, v]) => reply[k as keyof typeof body] !== v)
      )
        throw invalid();
      return reply;
    },
    async cancel(row: Operation) {
      const res = await read('/v1/operations/' + row.operation.id + '/cancel', {});
      if (res.status === 410 && res.code === 'operation_expired') return 'expired' as const;
      const reply = z
        .object({ operationId: uuid, status: z.enum(['cancelled', 'in_progress', 'applied', 'rejected']) })
        .strict()
        .parse(unwrap(res));
      if (reply.operationId !== row.operation.id) throw invalid();
      return reply.status;
    },
  };
}
