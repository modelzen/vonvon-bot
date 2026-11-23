// Frozen from f1997d47c16f533f784aab5abe99cda0479c652f:packages/daemon/src/recipe/rich-merge.ts; only relative imports adjusted.
import { isDeepStrictEqual as equal } from 'node:util';
import type { RecipeRichContent, RecipeRichText } from '@vonvon/protocol';

type Collection = 'settings' | 'rules' | 'skills' | 'files' | 'tasks' | 'memories' | 'setup';
type Portable = RecipeRichContent[Collection][number] | NonNullable<RecipeRichContent['role']>;
type Identity = Pick<Portable, 'itemId' | 'originId'>;
export type LocalRecipeItem = Identity & { kind: Collection | 'role' | 'cardBlock'; value: Record<string, unknown> };
export type RecipeSnapshot = readonly LocalRecipeItem[];
export type RecipeItemChoices = Readonly<Record<string, 'local' | 'incoming'>>;
const collections: Collection[] = ['settings', 'rules', 'skills', 'files', 'tasks', 'memories', 'setup'];

export function recipeSnapshot(content: RecipeRichContent, resolve: (value: RecipeRichText) => string): LocalRecipeItem[] {
  const items: LocalRecipeItem[] = [];
  function add(kind: LocalRecipeItem['kind'], { itemId, originId, ...fields }: Identity & Record<string, unknown>) {
    items.push({ kind, itemId, originId, value: fields });
  }
  if (content.role) add('role', { ...content.role, text: resolve(content.role.text) });
  for (const kind of collections)
    for (const entry of content[kind]) {
      if ('text' in entry) add(kind, { ...entry, text: resolve(entry.text) });
      else if ('instruction' in entry) add(kind, { ...entry, instruction: resolve(entry.instruction) });
      else if ('field' in entry && entry.field === 'presentation.cardDisplay' && entry.value) {
        const { blocks, ...value } = entry.value;
        add(kind, { ...entry, value: { ...value, blocks: blocks.map((block) => block.itemId) } });
        for (const block of blocks) add('cardBlock', { ...block, parentItemId: entry.itemId });
      } else add(kind, entry);
    }
  return items;
}

function byId(items: RecipeSnapshot) {
  const map = new Map(items.map((item) => [item.itemId, item]));
  if (map.size !== items.length) throw new Error('配方条目编号重复');
  return map;
}
export function mergeRecipeItems(
  base: RecipeSnapshot,
  local: RecipeSnapshot,
  incoming: RecipeSnapshot,
  choices: RecipeItemChoices = {},
): {
  resolved: LocalRecipeItem[];
  conflicts: { itemId: string; base?: LocalRecipeItem; local?: LocalRecipeItem; incoming?: LocalRecipeItem }[];
} {
  const [old, here, next] = [byId(base), byId(local), byId(incoming)] as const;
  const resolved: LocalRecipeItem[] = [],
    conflicts: ReturnType<typeof mergeRecipeItems>['conflicts'] = [];
  const used = new Set<string>();
  for (const id of new Set([...next.keys(), ...here.keys(), ...old.keys()])) {
    const b = old.get(id),
      l = here.get(id),
      n = next.get(id);
    const identities = [b, l, n].filter((v): v is LocalRecipeItem => !!v);
    if (identities.some((v) => v.kind !== identities[0]!.kind || v.originId !== identities[0]!.originId))
      throw new Error('配方条目来源或类型已改变');
    let value;
    if (equal(l, n) || equal(b, n)) value = l;
    else if (equal(b, l)) value = n;
    else if (Object.hasOwn(choices, id)) {
      used.add(id);
      value = choices[id] === 'incoming' ? n : l;
    } else {
      conflicts.push({ itemId: id, base: b, local: l, incoming: n });
      continue;
    }
    if (value) resolved.push(structuredClone(value));
  }
  if (Object.keys(choices).some((id) => !used.has(id))) throw new Error('配方冲突选择已过期，请重新预览');
  return { resolved, conflicts };
}
