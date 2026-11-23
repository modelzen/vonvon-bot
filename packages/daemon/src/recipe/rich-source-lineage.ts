import type { RecipeRichContent, RecipeRichOriginEdge } from '@vonvon/protocol';
import type { Project } from '../project/registry';
import { localRecipeItems } from './rich-settings';
import type { LocalRecipeItem } from './rich-merge';
import { sha256 } from './manifest';
import { openRichRecipeGenerationMetadata } from './rich-generation';
import type { ManagedSourceSelection } from './authoring-rich-managed';
export const canonicalLocal = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : child,
  );
export interface ItemSource {
  parents: RecipeRichOriginEdge[];
  authorId: string;
  access: 'direct' | 'coded';
}
export function releasedItemSources(
  content: RecipeRichContent,
  release: { versionId: string; authorId: string; access: 'direct' | 'coded' },
): Record<string, ItemSource> {
  const entries = [
    ...(content.role ? [content.role] : []),
    ...content.settings,
    ...content.rules,
    ...content.skills,
    ...content.files,
    ...content.tasks,
    ...content.memories,
    ...content.setup,
    ...content.settings.flatMap((s) => (s.field === 'presentation.cardDisplay' ? (s.value?.blocks ?? []) : [])),
  ];
  return Object.fromEntries(
    entries.map((item) => [
      item.itemId,
      {
        parents: [{ versionId: release.versionId, itemId: item.itemId, baselineSha256: sha256(canonicalLocal(item)) }],
        authorId: release.authorId,
        access: release.access,
      },
    ]),
  );
}
export async function nativeRichSourceItems(row: Project, botDataRoot: string, selection?: ManagedSourceSelection): Promise<(LocalRecipeItem & ItemSource)[]> {
  const active = row.richRecipe;
  if (!active) return [];
  if (row.bindingIncarnation !== active.bindingIncarnation) throw new Error('配方来源群绑定已改变');
  const index = await openRichRecipeGenerationMetadata({ ...active.pointer, expected: active.pointer, botDataRoot });
  const metadata: LocalRecipeItem[] = [
    ...index.skills.map(({itemId,originId,...value})=>({kind:'skills' as const,itemId,originId,value})),
    ...index.files.map(({itemId,originId,...value})=>({kind:'files' as const,itemId,originId,value})),
  ];
  const stored = active.resolved.filter(item=>item.kind==='skills'||item.kind==='files').map(item=>{
    const {text:_,...value}=item.value;
    return {kind:item.kind,itemId:item.itemId,originId:item.originId,value};
  });
  const ordered = (items:LocalRecipeItem[])=>items.sort((a,b)=>a.itemId<b.itemId?-1:a.itemId>b.itemId?1:0);
  if(canonicalLocal(ordered(stored))!==canonicalLocal(ordered([...metadata])))throw new Error('配方技能来源已改变');
  const texts = selection ? await index.readFiles(selection.fileIds) : new Map<string,string>();
  const items = selection ? localRecipeItems(row,[]).flatMap(item=>{
    if(item.kind==='files'){
      const text=texts.get(item.itemId);
      if(text===undefined)return [];
      if(item.value.text!==text)throw new Error('配方文件来源已改变');
    }
    if(item.kind==='memories'||item.kind==='tasks'&&!selection.includeTasks)return [];
    return [item];
  }) : metadata;
  return items.map((item) => {
    const source = active.sources[item.itemId];
    if (!source?.parents.length) throw new Error('配方条目缺少来源');
    return structuredClone({ ...item, ...source });
  });
}
