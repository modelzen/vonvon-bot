import {decodeRichRecipeContent} from '@vonvon/protocol';
import {richCommunity, MissingRichRecipe,RichCommunityUnavailable} from './community-rich.js';
import {communityFailureMessages, communityRequestSchema, communityResponseSchemas, type CommunityRequest, type CommunityResponses} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';

const messages: Record<string, string> = communityFailureMessages;
export class CommunityError extends Error {
  constructor(message: string, readonly code = 'unavailable', readonly retryAfter?: number) {super(message);}
}
const fallback = '社区请求未完成，请稍后重试同一操作。';

function endpoint(r: Exclude<CommunityRequest, {type: 'shareLink'}>): {path: string; method?: string; body?: unknown; revision?: number} {
  switch (r.type) {
    case 'catalog': {const query = new URLSearchParams(); if (r.query) query.set('q', r.query); if (r.cursor) query.set('cursor', r.cursor); return {path: '/v1/community/recipes' + (query.size ? '?' + query : '')};}
    case 'detail': return {path: `/v1/recipes/${r.recipeId}/versions/${r.versionId}`};
    case 'library': return {path: '/v1/me/recipes' + (r.cursor ? '?cursor=' + r.cursor : '')};
    case 'drafts': return {path: '/v1/me/drafts'};
    case 'publications': return {path: '/v1/me/publications'};
    case 'draft': return {path: '/v1/drafts/' + r.draftId};
    case 'saveDraft': {
      const existing = r.target.kind === 'existing' ? r.target : undefined;
      const source = r.target.kind === 'new' ? r.target.source : undefined;
      return {path: '/v1/drafts' + (existing ? '/' + existing.draftId : ''), method: existing ? 'PATCH' : 'POST', revision: existing?.revision,
        body: {public: r.public, config: r.config, ...(source ? {recipeId: source.recipeId, sourceVersionId: source.versionId} : {})}};
    }
    case 'deleteDraft': return {path: '/v1/drafts/' + r.draftId, method: 'DELETE', revision: r.revision, body: {}};
    case 'publishDraft': return {path: `/v1/drafts/${r.draftId}/publish`, method: 'POST', revision: r.revision, body: {}};
    case 'acquire': return {path: `/v2/versions/${r.versionId}/${r.code ? 'redeem' : 'acquire'}`, method: 'POST', body: r.code ? {code: r.code} : {}};
    case 'codes': return {path: `/v1/versions/${r.versionId}/codes` + (r.cursor ? '?cursor=' + r.cursor : '')};
    case 'issueCodes': return {path: `/v1/versions/${r.versionId}/codes`, method: 'POST', body: {count: r.count}};
    case 'disableCode': return {path: `/v1/codes/${r.codeId}/disable`, method: 'POST', body: {}};
    case 'revealCode': return {path: `/v1/codes/${r.codeId}/reveal`, method: 'POST', body: {}};
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CommunityError(fallback);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new CommunityError(fallback);
      chunks.push(value);
    }
  } catch {await reader.cancel().catch(() => {}); throw new CommunityError(fallback);}
  finally {reader.releaseLock();}
  const content = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) {content.set(chunk, offset); offset += chunk.byteLength;}
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(content));} catch {throw new CommunityError(fallback);}
}

export async function communityRequest<T extends CommunityRequest['type']>(account: NativeAccount, raw: Extract<CommunityRequest, {type: T}>): Promise<CommunityResponses[T]> {
  const r = communityRequestSchema.parse(raw);
  if (r.type === 'shareLink') {
    try {return communityResponseSchemas.shareLink.parse({url: account.recipeLink!(r.recipeId, r.versionId)}) as CommunityResponses[T];} catch {throw new CommunityError(fallback);}
  }
  const initial = account.status();
  if (r.accountId && (initial.kind !== 'signedIn' || initial.accountId !== r.accountId)) throw new CommunityError('账号已切换，请重新打开社区。', 'session_changed');
  let changed = false;
  const unsubscribe = account.onStatus(next => {
    if (next.kind !== initial.kind || (next.kind === 'signedIn' && initial.kind === 'signedIn' && next.accountId !== initial.accountId)) changed = true;
  });
  try {
    const check = () => {if (changed) throw new CommunityError('账号已切换，请重新打开社区。', 'session_changed');};
    const rich = richCommunity(account, r.accountId, check);
    if (r.type === 'catalog') return await rich.catalog(r.query, r.cursor) as CommunityResponses[T];
    if (r.type === 'library') return await rich.library(r.cursor) as CommunityResponses[T];
    if (r.type === 'publications') return await rich.publications() as CommunityResponses[T];
    if (r.type === 'drafts') return await rich.drafts() as CommunityResponses[T];
    if (r.type === 'detail' || r.type === 'draft') {
      try {return (r.type === 'detail' ? await rich.detail(r.recipeId, r.versionId) : await rich.draft(r.draftId)) as CommunityResponses[T];}
      catch (error) {if (!(error instanceof MissingRichRecipe)) throw error;}
    }
    const e = endpoint(r);
    if(r.type==='publishDraft'&&(r.format||r.canonical)){
      if(r.format!=='rich-v2'||!r.canonical)throw new CommunityError(fallback);
      const bytes=Buffer.from(r.canonical,'base64url');if(bytes.toString('base64url')!==r.canonical)throw new CommunityError(fallback);
      decodeRichRecipeContent(bytes);e.path=`/v2/drafts/${r.draftId}/publish`;e.body={canonical:r.canonical};
    } else if (r.type === 'publishDraft' || r.type === 'deleteDraft') {
      try {
        const value = await rich.draft(r.draftId);
        if (value.revision !== r.revision) throw new CommunityError(messages.conflict, 'conflict');
        e.path = `/v2/drafts/${r.draftId}` + (r.type === 'publishDraft' ? '/publish' : '');
        e.body = r.type === 'publishDraft' ? {canonical: value.rich!.canonical} : {};
      } catch (error) {if (!(error instanceof MissingRichRecipe)) throw error;}
    }
    const headers: Record<string, string> = {};
    if ('requestId' in r) {headers['Idempotency-Key'] = r.requestId; headers['Content-Type'] = 'application/json';}
    if (e.revision) headers['If-Match'] = `"${e.revision}"`;
    let response: Response;
    try {
      response = r.accountId ? await account.request(r.accountId, e.path, {method: e.method ?? 'GET', headers, body: e.body === undefined ? undefined : JSON.stringify(e.body)})
        : await account.publicRequest!(e.path);
    } catch {throw new CommunityError(fallback);}
    const value = await boundedJson(response);
    if (changed) throw new CommunityError('账号已切换，请重新打开社区。', 'session_changed');
    if (!response.ok) {
      const code = typeof value === 'object' && value && 'error' in value && typeof value.error === 'object' && value.error && 'code' in value.error ? value.error.code : undefined;
      const known = typeof code === 'string' && Object.hasOwn(messages, code);
      const retry = response.headers.get('retry-after');
      const retryAfter = retry && /^[1-9][0-9]{0,12}$/.test(retry) && Number.isSafeInteger(Number(retry)) ? Number(retry) : undefined;
      throw new CommunityError(known ? messages[code] : fallback, known ? code : 'unavailable', retryAfter);
    }
    const parsed = communityResponseSchemas[r.type].safeParse(value);
    if (!parsed.success) throw new CommunityError(fallback);
    return parsed.data as CommunityResponses[T];
  } catch(error) {if(error instanceof RichCommunityUnavailable)throw new CommunityError(error.message,error.state);if (error instanceof CommunityError) throw error; throw new CommunityError(fallback);}
  finally {unsubscribe();}
}
