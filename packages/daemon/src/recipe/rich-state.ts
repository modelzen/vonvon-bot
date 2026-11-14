import type { RecipeGenerationPointer } from './rich-generation';
import type { LocalRecipeItem } from './rich-merge';
export interface RichRecipeState {
  pointer: RecipeGenerationPointer;
  bindingIncarnation: string;
  resolved: LocalRecipeItem[];
  sources: Record<string, import('./rich-source-lineage').ItemSource>;
  choices: Record<string, 'local' | 'incoming'>;
  setup: Record<string, { kind: 'acknowledged' | 'observed'; contract: string; at: number }>;
  ignoredVersionId?: string;
  installedAt: number;
  receipt: string;
}
