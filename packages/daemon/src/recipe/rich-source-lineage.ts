import type { RecipeRichContent, RecipeRichOriginEdge } from '@vonvon/protocol';
import type { Project } from '../project/registry';
import { localRecipeItems } from './rich-settings';
import type { LocalRecipeItem } from './rich-merge';
import { sha256 } from './manifest';
import { openRichRecipeGeneration } from './rich-generation';
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
export async function nativeRichSourceItems(row: Project, botDataRoot: string): Promise<(LocalRecipeItem & ItemSource)[]> {
  const active = row.richRecipe;
  if (!active) return [];
  if (row.bindingIncarnation !== active.bindingIncarnation) throw new Error('配方来源群绑定已改变');
  await openRichRecipeGeneration({ ...active.pointer, expected: active.pointer, botDataRoot });
  return localRecipeItems(row, []).map((item) => {
    const source = active.sources[item.itemId];
    if (!source?.parents.length) throw new Error('配方条目缺少来源');
    return structuredClone({ ...item, ...source });
  });
}
