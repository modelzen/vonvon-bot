import { cardDisplayConfigSchema, recipeRichSettingSchema, type CardDisplayBlock } from '@vonvon/protocol';
import { sessionModeOf, storedMode, type Project } from '../project/registry';
import { supplementOf } from '../bot/context-assembly';
import type { LocalRecipeItem } from './rich-merge';
const inertBlock = ({ itemId: _id, originId: _origin, parentItemId: _parent, ...block }: Record<string, unknown>) => ({
  ...block,
  source: 'builtin',
  script: '',
  language: 'node',
  sample: '{}',
});
const nativePresentation = new Set([
  'voiceEnabled',
  'showToolCalls',
  'showModel',
  'completionMode',
  'longTaskMinutes',
  'completionTemplate',
]);
export function localRecipeItems(row: Project, incoming: LocalRecipeItem[]): LocalRecipeItem[] {
  const previous = row.richRecipe?.resolved.filter(item => item.kind !== 'memories') ?? [],
    present = new Set(previous.map((i) => i.itemId));
  const all = [
    ...previous,
    ...incoming.filter((item) => !present.has(item.itemId) && (item.kind === 'role' || item.kind === 'settings')),
  ];
  const card = all.find((i) => i.kind === 'settings' && i.value.field === 'presentation.cardDisplay'),
    native = row.presentation?.cardDisplay;
  const blocks = [...previous, ...incoming.filter((i) => !present.has(i.itemId))].filter(
    (i) => i.kind === 'cardBlock' && i.value.parentItemId === card?.itemId,
  );
  const liveBlock = (id: unknown) => native?.blocks.find((b) => b.id === id);
  const matched = (b: CardDisplayBlock) => blocks.find((i) => i.value.id === b.id);
  const portable = (b: CardDisplayBlock) => {
    const { source: _s, script: _cmd, language: _l, sample: _x, ...rest } = b;
    return rest;
  };
  for (const block of blocks) if (!all.some((i) => i.itemId === block.itemId) && liveBlock(block.value.id)) all.push(block);
  return all.flatMap((item): LocalRecipeItem[] => {
    const was = present.has(item.itemId),
      field = item.value.field;
    let value: unknown;
    if (item.kind === 'role') {
      const text = supplementOf(row);
      return text || was ? [{ ...item, value: { text } }] : [];
    }
    if (item.kind === 'cardBlock') {
      const b = liveBlock(item.value.id);
      if (!b) return [];
      if (b.source === 'script') throw new Error('本机同名卡片块包含脚本，请先在原生设置调整其名称');
      return [{ ...item, value: { ...portable(b), parentItemId: card?.itemId } }];
    }
    if (item.kind !== 'settings') return [item];
    if (field === 'presentation.cardDisplay')
      value =
        native === undefined
          ? undefined
          : native === null
            ? null
            : {
                ...native,
                blocks: native.blocks.flatMap((b) => {
                  const match = matched(b);
                  return match ? [match.itemId] : [];
                }),
              };
    else if (field === 'sessionMode') value = row.kind ? sessionModeOf(row) : undefined;
    else if (field === 'response.noMention') value = row.noMention;
    else if (field === 'run.pendingPolicy') value = row.pendingPolicy ?? (was ? 'default' : undefined);
    else if (typeof field === 'string' && field.startsWith('presentation.') && nativePresentation.has(field.slice(13)))
      value = row.presentation?.[field.slice(13) as keyof NonNullable<Project['presentation']>];
    else return was ? [item] : [];
    return value === undefined ? [] : [{ ...item, value: { field, value } }];
  });
}
export function applyNativeRecipeFields(row: Project, resolved: LocalRecipeItem[], previous: LocalRecipeItem[]) {
  for (const item of previous)
    if (!resolved.some((n) => n.itemId === item.itemId)) {
      if (item.kind === 'role') row.supplement = '';
      const field = item.value.field;
      if (field === 'sessionMode') {
        delete row.kind;
        delete row.smart;
      }
      if (field === 'response.noMention') delete row.noMention;
      if (field === 'run.pendingPolicy') delete row.pendingPolicy;
      if (field === 'presentation.cardDisplay' && row.presentation?.cardDisplay) {
        const ids = new Set(previous.filter((i) => i.kind === 'cardBlock').map((i) => i.value.id));
        row.presentation.cardDisplay = {
          ...row.presentation.cardDisplay,
          blocks: row.presentation.cardDisplay.blocks.filter((b) => !ids.has(b.id)),
        };
        continue;
      }
      if (typeof field === 'string' && field.startsWith('presentation.') && row.presentation)
        delete row.presentation[field.slice(13) as keyof typeof row.presentation];
    }
  for (const item of resolved) {
    if (item.kind === 'role') {
      const text = String(item.value.text);
      if ([...text].length > 5000) throw new Error('补充职责最多 5000 字');
      row.supplement = text;
      continue;
    }
    if (item.kind !== 'settings') continue;
    if (item.value.field === 'presentation.cardDisplay') {
      const raw = item.value.value as { blocks: string[] } | null;
      const blocks = raw?.blocks.map((id) => {
        const block = resolved.find((n) => n.itemId === id && n.kind === 'cardBlock');
        if (!block) throw new Error('卡片块冲突未解决');
        return inertBlock(block.value);
      });
      const managed = new Set([...previous, ...resolved].filter((i) => i.kind === 'cardBlock').map((i) => i.value.id));
      const localOnly = row.presentation?.cardDisplay?.blocks.filter((b) => !managed.has(b.id)) ?? [];
      const combined = [...(blocks ?? []), ...localOnly];
      (row.presentation ??= {}).cardDisplay =
        raw || localOnly.length ? cardDisplayConfigSchema.parse({ version: 1, ...raw, blocks: combined }) : null;
      continue;
    }
    const setting = recipeRichSettingSchema.parse({ itemId: item.itemId, originId: item.originId, ...item.value });
    switch (setting.field) {
      case 'sessionMode':
        delete row.smart;
        Object.assign(row, storedMode(setting.value));
        break;
      case 'response.noMention':
        row.noMention = setting.value;
        break;
      case 'run.pendingPolicy':
        if (setting.value === 'default') delete row.pendingPolicy;
        else row.pendingPolicy = setting.value;
        break;
      default:
        if (setting.field.startsWith('presentation.') && nativePresentation.has(setting.field.slice(13)))
          Object.assign((row.presentation ??= {}), { [setting.field.slice(13)]: setting.value });
    }
  }
}
