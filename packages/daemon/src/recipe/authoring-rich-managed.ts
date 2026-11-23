import {recipeRichContentSchema,type RecipeRichContent,type RecipeRichOriginEdge} from '@vonvon/protocol';
import type {SourceEvidence} from './authoring-rich-snapshot';
import {itemsOf} from './authoring-rich-snapshot';

export interface ManagedSourceItem {
  kind:'settings'|'rules'|'skills'|'files'|'tasks'|'memories'|'setup'|'role'|'cardBlock';
  itemId:string;originId:string;value:Record<string,unknown>;parents:RecipeRichOriginEdge[];authorId:string;access:'direct'|'coded';
}
export function applyManagedInventory(content:RecipeRichContent,evidence:Map<string,SourceEvidence>,managed:ManagedSourceItem[],account:string){
  const blocks=new Map(managed.filter(m=>m.kind==='cardBlock').map(b=>[b.itemId,b]));
  for(const item of managed){
    const {kind,itemId,originId,parents}=item;
    const from:SourceEvidence=!parents.length||item.access==='coded'&&item.authorId!==account?{kind:'unresolved'}:{kind:'managed',parents};
    evidence.set(itemId,from);
    if(kind==='cardBlock')continue;
    const data=structuredClone(item.value);
    for(const key of ['text','instruction'])if(typeof data[key]==='string')data[key]={kind:'inline',value:data[key]};
    if(kind==='settings'&&data.field==='presentation.cardDisplay'&&data.value && typeof data.value==='object'&&'blocks' in data.value){
      const ids=data.value.blocks;
      if(!Array.isArray(ids))throw new Error('配方卡片来源无效。');
      data.value={...data.value,blocks:ids.map(id=>{
        const b=blocks.get(id);
        if(!b||b.value.parentItemId!==itemId)throw new Error('配方卡片来源无效。');
        const {parentItemId:_,...value}=b.value;
        return {...value,itemId:b.itemId,originId:b.originId};
      })};
    }
    const raw={...data,itemId,originId};
    if(kind==='role'){
      content.role=recipeRichContentSchema.shape.role.unwrap().parse(raw);
    }else{
      if(kind==='settings')content.settings=content.settings.filter(s=>s.field!==data.field);
      if(kind==='rules'&&data.purpose!=='work')content.rules=content.rules.filter(r=>r.purpose!==data.purpose);
      const insert=<K extends Exclude<ManagedSourceItem['kind'],'role'|'cardBlock'>>(k:K)=>{
        const item=recipeRichContentSchema.shape[k].element.parse(raw) as RecipeRichContent[K][number];
        (content[k] as RecipeRichContent[K][number][]).push(item);
      };
      insert(kind);
    }
  }
  const present=new Set(itemsOf(content).map(i=>i.itemId));
  for(const id of evidence.keys())if(!present.has(id))evidence.delete(id);
}
