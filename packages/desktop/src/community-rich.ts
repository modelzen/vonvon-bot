import {createHash} from 'node:crypto';
import {z} from 'zod';
import {decodeRichRecipeContent, verifyRichRecipeRelease, recipeRichManifestObjectSchema, recipeRichReleaseSchema,
  publicDisplayNameSchema, recipePublicSchema, recipeRoleDraftSchema, recipeSummarySchema, recipeBrowseDetailSchema, type RecipeBrowseDetail, type RecipeDetail, type RecipeDraft, type CommunityResponses} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';

const uuid = z.string().uuid();
const creator = z.object({authorId:uuid,displayName:publicDisplayNameSchema}).strict();
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
  async function read(path: string, cap: number, metadata = false): Promise<Buffer> {
    check();
    const response = accountId ? await account.request(accountId, path, {}, check) : await account.publicRequest!(path);
    check();
    if (!response.ok || !response.body) {await response.body?.cancel(); if (metadata && response.status === 404) throw new MissingRichRecipe(); throw fail();}
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {for (;;) {const {done, value} = await reader.read(); check(); if (done) break; if ((bytes += value.byteLength) > cap) throw fail(); chunks.push(value);}}
    finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  async function json(path: string, metadata = false) {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await read(path, 2097152, metadata))) as unknown;}
  async function object(path: string, descriptor: {objectId: string; bytes: number; sha256: string}) {
    const value = await read(path + descriptor.objectId, descriptor.bytes);
    if (value.byteLength !== descriptor.bytes || createHash('sha256').update(value).digest('hex') !== descriptor.sha256) throw fail();
    return value;
  }
  async function loadMembers(path: string, descriptor: z.infer<typeof recipeRichManifestObjectSchema>, release?: z.infer<typeof recipeRichReleaseSchema>) {
    const canonical = await object(path, descriptor);
    const parsed = release ? await verifyRichRecipeRelease(release, canonical) : decodeRichRecipeContent(canonical);
    check();
    const members = new Map<string, Buffer>();
    for (let offset = 0; offset < parsed.content.parts.length; offset += 8) {
      const loaded = await Promise.all(parsed.content.parts.slice(offset, offset + 8).map(async part =>
        ({objectId: part.objectId, bytes: await object(path, part)})));
      for (const member of loaded) members.set(member.objectId, member.bytes);
    }
    return {content: parsed.content, canonical, members};
  }
  function display(loaded: Awaited<ReturnType<typeof loadMembers>>) {
    const texts: Record<string, string> = {}; let logo: string | undefined;
    for (const part of loaded.content.parts) {
      const value = loaded.members.get(part.objectId)!;
      if (part.kind === 'text') texts[part.objectId] = new TextDecoder('utf-8', {fatal: true}).decode(value);
      else logo = 'data:image/webp;base64,' + value.toString('base64');
    }
    return {rich: {content: loaded.content, texts, canonical: loaded.canonical.toString('base64url')}, logo};
  }
  async function draftRead(draftId: string): Promise<RecipeDraft> {
    const value = draft.parse(await json('/v2/drafts/' + uuid.parse(draftId), true));
    if (value.draftId !== draftId) throw fail();
    const loaded = display(await loadMembers(`/v2/drafts/${draftId}/objects/`, value.manifest));
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
  async function metadata(recipeId: string, versionId: string) {
    const raw=await json(`/v2/recipes/${uuid.parse(recipeId)}/versions/${uuid.parse(versionId)}`, true);
    const unavailable=z.object({state:z.enum(['withdrawn','blocked']),versionId:uuid}).strict().safeParse(raw);
    if(unavailable.success){if(unavailable.data.versionId!==versionId)throw fail();throw new RichCommunityUnavailable(unavailable.data.state);}
    const value = richCloudDetailSchema.parse(raw);
    if (value.recipeId !== recipeId || value.versionId !== versionId) throw fail();
    const full = value.visibility === 'full';
    if(value.release&&(value.release.recipeId!==recipeId||value.release.versionId!==versionId||value.release.revision!==value.revision||value.release.access!==value.public.access||value.release.authorId!==value.creator.authorId))throw fail();
    if (full !== Boolean(value.manifest) || full !== Boolean(value.release)) throw fail();
    return value;
  }
  async function publishedMembers(value: z.infer<typeof richCloudDetailSchema>) {
    if (!value.manifest || !value.release) throw fail();
    const loaded = await loadMembers(`/v2/versions/${value.versionId}/objects/`, value.manifest, value.release);
    if ((['name','summary','overview','version'] as const).some(field => loaded.content.public[field].value !== value.public[field])) throw fail();
    return loaded;
  }
  return {
    metadata, publishedMembers,
    async browse(recipeId: string, versionId: string): Promise<RecipeBrowseDetail> {
      const path = `/v2/recipes/${uuid.parse(recipeId)}/versions/${uuid.parse(versionId)}/preview`;
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await read(path, 131072, true)));
      const unavailable = z.object({state: z.enum(['withdrawn', 'blocked']), versionId: uuid}).strict().safeParse(raw);
      if (unavailable.success) {
        if (unavailable.data.versionId !== versionId) throw fail();
        throw new RichCommunityUnavailable(unavailable.data.state);
      }
      const value = recipeBrowseDetailSchema.parse(raw);
      if (value.recipeId !== recipeId || value.versionId !== versionId) throw fail();
      return value;
    },
    async displayLogo(versionId: string): Promise<CommunityResponses['displayLogo']> {
      const bytes = await read(`/v2/versions/${uuid.parse(versionId)}/display-logo`, 131072);
      return {logo: 'data:image/webp;base64,' + bytes.toString('base64')};
    },
    async author(authorId: string, cursor?: string): Promise<CommunityResponses['author']> {
      const page = z.object({creator, items: recipeSummarySchema.array().max(50), nextCursor: uuid.nullable()}).strict().parse(await json(`/v2/authors/${uuid.parse(authorId)}/recipes` + (cursor ? '?cursor=' + encodeURIComponent(uuid.parse(cursor)) : '')));
      if (page.creator.authorId !== authorId || page.items.some(item => item.creator?.authorId !== authorId)) throw fail();
      return page;
    },
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
      return page;
    },
    async detail(recipeId: string, versionId: string): Promise<RecipeDetail> {
      const value = await metadata(recipeId, versionId);
      const loaded = value.visibility === 'full' ? display(await publishedMembers(value)) : undefined;
      let logo = loaded?.logo;
      if (!logo && value.hasDisplayLogo) logo = 'data:image/webp;base64,' + (await read(`/v2/versions/${versionId}/display-logo`, 131072)).toString('base64');
      return {recipeId, versionId, revision: value.revision, public: value.public, format: 'rich-v2', creator: value.creator,
        state: value.state, owned: value.owned, acquired: value.acquired, hasDisplayLogo: value.hasDisplayLogo, ...(loaded ? {rich: loaded.rich} : {}), ...(logo ? {logo} : {})};
    },
    draft: draftRead,
  };
}
