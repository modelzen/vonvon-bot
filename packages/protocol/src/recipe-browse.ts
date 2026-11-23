import {z} from 'zod';
import {recipePublicSchema, publicDisplayNameSchema} from './desktop-community.js';
import {recipeRichSettingSchema, type RecipeRichContent} from './recipe-rich.js';

const id = z.string().uuid();
const boundedText = (points: number) => z.string().refine(value => Array.from(value).length <= points && !/[\u0000-\u001f\u007f]/u.test(value) &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value));
export const recipeBrowsePreviewSchema = z.object({
  settings: recipeRichSettingSchema.array().max(32),
  skills: z.object({itemId: id, name: boundedText(1000), description: boundedText(400)}).strict().array().max(16),
  ruleCount: z.number().int().min(0).max(32), taskCount: z.number().int().min(0).max(32),
  omittedSettingCount: z.number().int().min(0).max(32).optional(),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 65536, 'Browse preview is too large');
export type RecipeBrowsePreview = z.infer<typeof recipeBrowsePreviewSchema>;

export const recipeBrowseDetailSchema = z.object({
  recipeId: id, versionId: id, revision: z.number().int().positive().max(2147483647),
  format: z.enum(['rich-v2', 'role-v1']), public: z.lazy(() => recipePublicSchema),
  creator: z.object({authorId: id, displayName: z.lazy(() => publicDisplayNameSchema)}).strict(),
  owned: z.boolean(), acquired: z.boolean(), state: z.enum(['listed', 'withdrawn', 'deleted']),
  hasDisplayLogo: z.boolean(), preview: recipeBrowsePreviewSchema.optional(), previewUnavailable: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.preview && value.previewUnavailable) ctx.addIssue({code: 'custom', message: 'Preview cannot be both available and unavailable'});
});
export type RecipeBrowseDetail = z.infer<typeof recipeBrowseDetailSchema>;

export function recipeSkillDescription(text: string): string {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(0, 8192));
  if (!frontmatter) return '';
  const lines = frontmatter[1]!.split(/\r?\n/);
  const index = lines.findIndex(line => /^description[ \t]*:/.test(line));
  if (index < 0) return '';
  let value = lines[index]!.replace(/^description[ \t]*:[ \t]*/, '').trim();
  if (/^[>|][-+]?\s*$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(index + 1)) {if (line && !/^\s/.test(line)) break; block.push(line.trim());}
    value = block.join(' ');
  } else if (value.startsWith('"') && value.endsWith('"')) {
    try {const decoded: unknown = JSON.parse(value); value = typeof decoded === 'string' ? decoded : '';} catch {return '';}
  } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, ' ')).slice(0, 400).join('');
}

export function buildRecipeBrowsePreview(content: RecipeRichContent, descriptions: Readonly<Record<string, string>> = {}): RecipeBrowsePreview {
  let omittedSettingCount = 0;
  const settings: RecipeRichContent['settings'] = [];
  for (const setting of content.settings) {
    if (new TextEncoder().encode(JSON.stringify(setting)).length > 4096 ||
        new TextEncoder().encode(JSON.stringify([...settings, setting])).length > 32768) omittedSettingCount++;
    else settings.push(setting);
  }
  const skills = content.skills.map(skill => {
    const file = content.files.find(file => file.itemId === skill.entryFileId);
    const description = descriptions[skill.itemId] ?? (file?.text.kind === 'inline' ? recipeSkillDescription(file.text.value) : '');
    return {itemId: skill.itemId, name: skill.name.replace(/[\u0000-\u001f\u007f]/gu, ' '), description};
  });
  const value = () => ({settings, skills, ruleCount: content.rules.length, taskCount: content.tasks.length, ...(omittedSettingCount ? {omittedSettingCount} : {})});
  while (settings.length && new TextEncoder().encode(JSON.stringify(value())).length > 65536) {settings.pop(); omittedSettingCount++;}
  return recipeBrowsePreviewSchema.parse(value());
}
