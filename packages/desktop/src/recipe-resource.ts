import {z} from 'zod';
import {
  acquisitionFailureSchema, exactResourceVersionSchema, openResourceSnapshot, recipeDetailSchema, recipeLatestSchema,
  resourceAcquireTaskSchema, resourceLatestSchema, resourceReadTaskSchema, roleResourceDigest,
  type AcquisitionOutcome, type ExactResourceVersion, type ResourceLatest, type VerifiedResourceSnapshot, type RecipeBrowseDetail,
} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {communityRequest, CommunityError} from './community-api.js';
import {boundedJson} from './community-response.js';
import {MissingRichRecipe, richCommunity, RichCommunityUnavailable} from './community-rich.js';

const invalid = () => new CommunityError('配方资料未通过完整性核对，请重新读取。');
const changed = () => new CommunityError('账号或设备连接已改变，请重新打开配方。', 'session_changed');

function access(account: NativeAccount, accountId: string, checkScope: () => void) {
  z.string().uuid().parse(accountId);
  const signal = account.lease?.(accountId);
  function check() {
    try {checkScope();} catch {throw changed();}
    const current = account.status();
    if (!signal || signal.aborted || current.kind !== 'signedIn' || current.accountId !== accountId ||
        account.lease?.(accountId) !== signal) throw changed();
  }
  check();
  // communityRequest uses this same request boundary, including the final pre-send check after token refresh.
  const guarded: NativeAccount = {...account, status: () => account.status(), onStatus: fn => account.onStatus(fn),
    async request(requestAccount, path, init, beforeSend) {
      check();
      if (requestAccount !== accountId) throw changed();
      const response = await account.request(accountId, path, {...init, signal}, async () => {
        if (beforeSend) await beforeSend();
        check();
      });
      check();
      return response;
    }};
  const rich = richCommunity(guarded, accountId, check);
  async function get(path: string) {
    const response = await guarded.request(accountId, path);
    if (!response.ok) {await response.body?.cancel(); throw invalid();}
    const value = await boundedJson(response, 2 * 1024 * 1024, check);
    check();
    return value;
  }
  async function metadata(target: ExactResourceVersion) {
    try {return {format: 'rich-v2' as const, detail: await rich.metadata(target.recipeId, target.versionId)};}
    catch (error) {check(); if (!(error instanceof MissingRichRecipe)) throw error;}
    const raw = await get(`/v1/recipes/${target.recipeId}/versions/${target.versionId}`);
    const detail = recipeDetailSchema.parse(raw);
    if (detail.recipeId !== target.recipeId || detail.versionId !== target.versionId || detail.format === 'rich-v2') throw invalid();
    return {format: 'role-v1' as const, detail};
  }
  return {guarded, check, get, metadata, rich};
}

export function recipeResourceReader(account: NativeAccount) {
  return {
    async previewExact(accountId: string, selected: ExactResourceVersion, check: () => void): Promise<RecipeBrowseDetail> {
      const target = exactResourceVersionSchema.parse(selected);
      const scope = access(account, accountId, check);
      const preview = await scope.rich.browse(target.recipeId, target.versionId);
      scope.check();
      if (!preview.owned && !preview.acquired) throw new CommunityError('请先获取这个版本。', 'not_acquired');
      return preview;
    },
    async readExact(accountId: string, selected: ExactResourceVersion, check: () => void): Promise<VerifiedResourceSnapshot> {
      const target = exactResourceVersionSchema.parse(selected);
      const scope = access(account, accountId, check);
      try {
        const source = await scope.metadata(target);
        scope.check();
        if (!source.detail.owned && !source.detail.acquired) throw new CommunityError('请先获取这个版本。', 'not_acquired');
        const base = {target, revision: source.detail.revision, public: source.detail.public};
        let snapshot: VerifiedResourceSnapshot;
        if (source.format === 'rich-v2') {
          const release = source.detail.release;
          if (!release || source.detail.visibility !== 'full') throw invalid();
          const loaded = await scope.rich.publishedMembers(source.detail);
          scope.check();
          if (loaded.content.memories.length) throw new CommunityError('该历史版本含有记忆，无法作为配方资源交付。');
          snapshot = {...base, format: source.format, release, contentSha256: release.contentSha256,
            canonical: loaded.canonical.toString('base64url'),
            members: Object.fromEntries(Array.from(loaded.members, ([id, bytes]) => [id, bytes.toString('base64url')]))};
        } else {
          const config = source.detail.config;
          if (!config) throw invalid();
          snapshot = {...base, format: source.format, config, contentSha256: await roleResourceDigest({...base, config})};
        }
        await openResourceSnapshot(snapshot);
        scope.check();
        return snapshot;
      } catch (error) {
        scope.check();
        if (error instanceof RichCommunityUnavailable) throw new CommunityError(error.state === 'blocked' ? '平台已停止分发这个版本。' : '该版本已撤下，当前账号没有读取资格。', error.state);
        if (error instanceof CommunityError) throw error;
        throw invalid();
      }
    },
    async latest(accountId: string, target: ExactResourceVersion, revision: number, check: () => void): Promise<ResourceLatest> {
      resourceReadTaskSchema.parse({kind: 'resourceLatest', target, revision});
      const scope = access(account, accountId, check);
      try {
        const raw = await scope.get(`/v2/recipes/${target.recipeId}/latest-install-version`);
        scope.check();
        const latest = recipeLatestSchema.parse(raw);
        if (latest.recipeId !== target.recipeId || !latest.format || !latest.access ||
            latest.revision < revision || (latest.versionId === target.versionId) !== (latest.revision === revision)) return {status: 'unknown'};
        return resourceLatestSchema.parse({status: latest.revision === revision ? 'current' : 'newer',
          target: {recipeId: latest.recipeId, versionId: latest.versionId}, revision: latest.revision,
          version: latest.version, format: latest.format, access: latest.access});
      } catch {scope.check(); return {status: 'unknown'};}
    },
    async acquireExact(accountId: string, selected: ExactResourceVersion, requestId: string, check: () => void): Promise<AcquisitionOutcome> {
      const {target} = resourceAcquireTaskSchema.parse({kind: 'resourceAcquire', target: selected, requestId});
      const scope = access(account, accountId, check);
      try {
        // The cloud write takes a versionId only. Verify the version belongs to this resource before sending it.
        const detail = await scope.rich.browse(target.recipeId,target.versionId);
        scope.check();
        if (!detail.owned && !detail.acquired && detail.public.access === 'coded') return {ok: false, error: {code: 'invalid_code'}};
        const value = await communityRequest<'acquire'>(scope.guarded, {type: 'acquire', accountId, versionId: target.versionId, requestId});
        scope.check();
        if (value.recipeId !== target.recipeId || value.versionId !== target.versionId || (!value.owned && !value.acquired)) throw invalid();
        return {ok: true, value};
      } catch (error) {
        scope.check();
        const failure = error instanceof CommunityError ? acquisitionFailureSchema.safeParse({code: error.code, retryAfter: error.retryAfter}) : undefined;
        return {ok: false, error: failure?.success ? failure.data : {code: 'unavailable'}};
      }
    },
  };
}
