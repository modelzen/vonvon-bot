import {createHash} from 'node:crypto';
import {
  canonicalizeRichRecipeContent, recipeRichOriginEdgeSchema,
  type RecipeRichContent, type RecipeRichOriginEdge,
} from '@vonvon/protocol';
import {hasLocalPath} from './authoring-payload';
// @ts-expect-error The service and native writer use the same credential policy.
import {credentialField} from '../../../../services/recipe-api/src/credential-shapes.mjs';

export const richCollections = ['settings','rules','skills','files','tasks','memories','setup'] as const;
type RichCollection = typeof richCollections[number];
type Identity = {itemId: string; originId: string};
export type SourceEvidence =
  | {kind:'native'}
  | {kind:'managed'; parents: readonly RecipeRichOriginEdge[]}
  | {kind:'unresolved'};
export type RichOrigin = {kind:'accountClaim'} | ({kind:'releaseItem'} & RecipeRichOriginEdge)
  | {kind:'releaseItems'; parents:RecipeRichOriginEdge[]};
export type SnapshotFreeze = {
  format:'rich-v2'; content:RecipeRichContent; access:'direct'|'coded';
  origins:{itemId:string;source:RichOrigin}[]; sourceVersionId?:string;
};
export function wireJson(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(wireJson).join(',')+']';
  if (value && typeof value==='object') {
    const object=value as Record<string,unknown>;
    return '{'+Object.keys(object).sort().map(k=>JSON.stringify(k)+':'+wireJson(object[k])).join(',')+'}';
  }
  const json=JSON.stringify(value);
  if (json===undefined) throw new Error('配方内容不是可序列化的值。');
  return json;
}
export const wireDigest=(value:unknown)=>createHash('sha256').update(wireJson(value)).digest('hex');

export function itemsOf(content:RecipeRichContent): Identity[] {
  const items:Identity[] = Object.values(content.public);
  if(content.role) items.push(content.role);
  if(content.finalLogo) items.push(content.finalLogo);
  for(const key of richCollections) {
    items.push(...content[key]);
    if(key==='settings') for(const item of content.settings)
      if(item.field==='presentation.cardDisplay' && item.value) items.push(...item.value.blocks);
  }
  return items;
}
export interface AttestedSourceItem extends RecipeRichOriginEdge {access:'direct'|'coded';authorId:string}
function sourceOf(evidence:SourceEvidence|undefined,account:string,ownershipClaim:boolean,attested:ReadonlyMap<string,AttestedSourceItem>,logo:boolean):RichOrigin {
  if(evidence?.kind==='native' && ownershipClaim) return {kind:'accountClaim'};
  if(evidence?.kind!=='managed'||!evidence.parents.length||evidence.parents.length>64) throw new Error('所选内容缺少可核对的来源。');
  const seen=new Set<string>();
  const parents=evidence.parents.map(input=>{
    const edge=recipeRichOriginEdgeSchema.parse(input);
    const key=edge.versionId+':'+edge.itemId, remote=attested.get(key);
    if(seen.has(key) || !remote || remote.versionId!==edge.versionId || remote.itemId!==edge.itemId || remote.baselineSha256!==edge.baselineSha256 ||
        !['direct','coded'].includes(remote.access) || ((!remote.authorId || remote.authorId!==account) && (remote.access==='coded'||logo))) throw new Error('所选来源受限或已有变化。');
    seen.add(key);
    return edge;
  });
  return parents.length===1?{kind:'releaseItem',...parents[0]!}:{kind:'releaseItems',parents};
}
export function selectRichSnapshot(args:{
  inventory:RecipeRichContent; selected:readonly string[]; evidence:ReadonlyMap<string,SourceEvidence>;
  attested:ReadonlyMap<string,AttestedSourceItem>; account:string; ownershipClaim:boolean; access:'direct'|'coded'; sourceVersionId?:string;
}):SnapshotFreeze {
  const {inventory,selected}=args;
  const wanted=new Set(selected);
  if(wanted.size!==selected.length)throw new Error('所选内容重复。');
  const content=structuredClone(inventory);
  // Public metadata belongs to every draft. All optional fields, including child files and card blocks, need their own choice.
  if(content.role&&!wanted.has(content.role.itemId))delete content.role;
  if(content.finalLogo&&!wanted.has(content.finalLogo.itemId))delete content.finalLogo;
  function keep<K extends RichCollection>(key:K) {
    content[key]=content[key].filter(item=>wanted.has(item.itemId)) as RecipeRichContent[K];
  }
  for(const key of richCollections)keep(key);
  for(const setting of content.settings)if(setting.field==='presentation.cardDisplay'&&setting.value)
    setting.value.blocks=setting.value.blocks.filter(b=>wanted.has(b.itemId));
  for(const skill of content.skills)skill.fileIds=skill.fileIds.filter(id=>wanted.has(id));
  const ids=new Set(itemsOf(content).map(i=>i.itemId));
  if(selected.some(id=>!ids.has(id)))throw new Error('所选项目不存在，或缺少所属技能或卡片。');
  const referenced=new Set<string>();
  if(content.finalLogo)referenced.add(content.finalLogo.objectId);
  const texts=[...(content.role?[content.role.text]:[]),...content.rules.map(x=>x.text),...content.files.map(x=>x.text),
    ...content.memories.map(x=>x.text),...content.tasks.map(x=>x.instruction)];
  for(const t of texts)if(t.kind==='part')referenced.add(t.objectId);
  content.parts=content.parts.filter(p=>referenced.has(p.objectId));
  const doc=canonicalizeRichRecipeContent(content);
  if(hasLocalPath(doc.content) || credentialField({config:{role:doc.canonical}}))throw new Error('所选内容含本机路径或凭据。');
  const origins=itemsOf(doc.content).map(({itemId})=>({itemId,source:sourceOf(args.evidence.get(itemId),args.account,args.ownershipClaim,args.attested,content.finalLogo?.itemId===itemId)}));
  return {format:'rich-v2',content:doc.content,access:args.access,origins,...(args.sourceVersionId&&{sourceVersionId:args.sourceVersionId})};
}
