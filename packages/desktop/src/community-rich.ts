import {createHash} from 'node:crypto';
import {z} from 'zod';
import {decodeRichRecipeContent, verifyRichRecipeRelease, recipeRichManifestObjectSchema, recipeRichReleaseSchema,
  recipePublicSchema, recipeRoleDraftSchema, recipeSummarySchema, type RecipeDetail, type RecipeDraft, type CommunityResponses} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';

const uuid = z.string().uuid();
const creator = z.object({authorId:uuid,displayName:z.string().min(1).max(60).refine(value=>value===value.trim()&&!/[@\p{Cc}]/u.test(value))}).strict();
const access = z.enum(['direct','coded']);
const revision = z.number().int().positive().max(2147483647);
export const richCloudDetailSchema = z.object({recipeId: uuid, versionId: uuid, revision, public: recipePublicSchema,
  format: z.literal('rich-v2'), state: z.enum(['listed','withdrawn']), visibility: z.enum(['intro','full']),
  creator, hasDisplayLogo: z.boolean(), owned: z.boolean(), acquired: z.boolean(),
  manifest: recipeRichManifestObjectSchema.optional(), release: recipeRichReleaseSchema.optional()}).strict();
const draft = z.object({format: z.literal('rich-v2'), draftId: uuid, recipeId: uuid.nullable(), revision, access,
  sourceIntentId: uuid, manifest: recipeRichManifestObjectSchema, logicalBytes: z.number().int().positive().max(1048576),
  retainedCandidateBytes: z.number().int().nonnegative(), sourceManifest: recipeRichManifestObjectSchema.nullable()}).strict();
const fail = () => new Error('配方资料未通过完整性核对，请重新读取。');
export class MissingRichRecipe extends Error {}
export class RichCommunityUnavailable extends Error {constructor(readonly state:'withdrawn'|'blocked'){super(state==='withdrawn'?'作者已撤下此版本，当前账号没有读取资格。':'此版本已被平台停止分发，本机已安装配置仍保留。');}}
export function richCommunity(account: NativeAccount, accountId: string | undefined, check: () => void) {
  async function read(path: string, cap: number, init?: RequestInit): Promise<Buffer> {
    check();
    const response = accountId ? await account.request(accountId, path, init ?? {}, check) : await account.publicRequest!(path);
    check();
    if (!response.ok || !response.body) {await response.body?.cancel(); if (response.status === 404) throw new MissingRichRecipe(); throw fail();}
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {for (;;) {const {done, value} = await reader.read(); check(); if (done) break; if ((bytes += value.byteLength) > cap) throw fail(); chunks.push(value);}}
    finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  async function json(path: string) {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await read(path, 2097152))) as unknown;}
  async function object(path: string, descriptor: {objectId: string; bytes: number; sha256: string}) {
    const value = await read(path + descriptor.objectId, descriptor.bytes);
    if (value.byteLength !== descriptor.bytes || createHash('sha256').update(value).digest('hex') !== descriptor.sha256) throw fail();
    return value;
  }
  async function view(path: string, descriptor: z.infer<typeof recipeRichManifestObjectSchema>, release?: z.infer<typeof recipeRichReleaseSchema>) {
    const canonical = await object(path, descriptor);
    const parsed = release ? await verifyRichRecipeRelease(release, canonical) : decodeRichRecipeContent(canonical);
    const texts: Record<string,string> = {}; let logo: string | undefined;
    for (const part of parsed.content.parts) {
      const value = await object(path, part);
      if (part.kind === 'text') texts[part.objectId] = new TextDecoder('utf-8', {fatal: true}).decode(value);
      else logo = 'data:image/webp;base64,' + value.toString('base64');
    }
    return {rich: {content: parsed.content, texts, canonical: canonical.toString('base64url')}, logo};
  }
  async function draftRead(draftId: string): Promise<RecipeDraft> {
    const value = draft.parse(await json('/v2/drafts/' + uuid.parse(draftId)));
    if (value.draftId !== draftId) throw fail();
    const loaded = await view(`/v2/drafts/${draftId}/objects/`, value.manifest);
    if(loaded.rich.content.parts.reduce((total,part)=>total+part.bytes,Buffer.from(loaded.rich.canonical,'base64url').byteLength)!==value.logicalBytes)throw fail();
    const fields = loaded.rich.content.public;
    return {draftId, recipeId: value.recipeId, revision: value.revision, format: 'rich-v2', sourceIntentId: value.sourceIntentId,
      public: {name: fields.name.value, summary: fields.summary.value, overview: fields.overview.value, version: fields.version.value, access: value.access},
      rich: loaded.rich, ...(loaded.logo?{logo:loaded.logo}:{})};
  }
  async function logo(item: z.infer<typeof recipeSummarySchema>) {
    if (!item.hasDisplayLogo) return item;
    try {const bytes = await read(`/v2/versions/${item.versionId}/display-logo`, 131072);
      return {...item, logo: 'data:image/webp;base64,' + bytes.toString('base64')};
    }catch{check();return item;}
  }
  async function logos(items:z.infer<typeof recipeSummarySchema>[]) {
    const result:z.infer<typeof recipeSummarySchema>[]=[];
    for(let index=0;index<items.length;index+=8)result.push(...await Promise.all(items.slice(index,index+8).map(logo)));
    return result;
  }
  return {
    async library(cursor?: string): Promise<CommunityResponses['library']> {
      const page=z.object({items: recipeSummarySchema.array().max(50), nextCursor: uuid.nullable()}).strict().parse(await json('/v2/me/recipes' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')));
      return {...page,items:await logos(page.items)};
    },
    async publications(): Promise<CommunityResponses['publications']> {
      const page=z.object({items: recipeSummarySchema.array().max(1000)}).strict().parse(await json('/v2/me/publications'));
      return {items:await logos(page.items)};
    },
    async drafts(): Promise<CommunityResponses['drafts']> {
      const role = recipeRoleDraftSchema.omit({format:true,rich:true,logo:true,sourceIntentId:true}).extend({format:z.literal('role-v1')});
      const rich = draft.extend({public: recipePublicSchema});
      const page = z.object({items: z.union([role,rich]).array().max(1000)}).strict().parse(await json('/v2/me/drafts'));
      return {items: page.items.map(item => item.format === 'rich-v2' ? {format:'rich-v2' as const,draftId:item.draftId,recipeId:item.recipeId,revision:item.revision,public:item.public} : (() => {const {format: _format, ...value} = item; return value;})())};
    },
    async catalog(query?: string, cursor?: string): Promise<CommunityResponses['catalog']> {
      const params = new URLSearchParams(); if (query) params.set('q', query); if (cursor) params.set('cursor', cursor);
      const page = z.object({heroKind:z.enum(['featured','latest']).nullable(),hero: recipeSummarySchema.nullable(), items: recipeSummarySchema.array().max(8), nextCursor: z.string().max(1600).nullable()}).strict().parse(await json('/v2/community/recipes?' + params));
      return {...page, hero: page.hero ? await logo(page.hero) : null, items: await Promise.all(page.items.map(logo))};
    },
    async detail(recipeId: string, versionId: string): Promise<RecipeDetail> {
      const raw=await json(`/v2/recipes/${uuid.parse(recipeId)}/versions/${uuid.parse(versionId)}`);
      const unavailable=z.object({state:z.enum(['withdrawn','blocked']),versionId:uuid}).strict().safeParse(raw);
      if(unavailable.success){if(unavailable.data.versionId!==versionId)throw fail();throw new RichCommunityUnavailable(unavailable.data.state);}
      const value = richCloudDetailSchema.parse(raw);
      if (value.recipeId !== recipeId || value.versionId !== versionId) throw fail();
      const full = value.visibility === 'full';
      if(value.release&&(value.release.recipeId!==recipeId||value.release.versionId!==versionId||value.release.revision!==value.revision||value.release.access!==value.public.access||value.release.authorId!==value.creator.authorId))throw fail();
      if (full !== Boolean(value.manifest && value.release)) throw fail();
      const loaded = full ? await view(`/v2/versions/${versionId}/objects/`, value.manifest!, value.release!) : undefined;
      if(loaded&&(['name','summary','overview','version'] as const).some(field=>loaded.rich.content.public[field].value!==value.public[field]))throw fail();
      let logo = loaded?.logo;
      if (!logo && value.hasDisplayLogo) logo = 'data:image/webp;base64,' + (await read(`/v2/versions/${versionId}/display-logo`, 131072)).toString('base64');
      return {recipeId, versionId, revision: value.revision, public: value.public, format: 'rich-v2', creator: value.creator,
        owned: value.owned, acquired: value.acquired, hasDisplayLogo: value.hasDisplayLogo, ...(loaded ? {rich: loaded.rich} : {}), ...(logo ? {logo} : {})};
    },
    draft: draftRead,
  };
}
