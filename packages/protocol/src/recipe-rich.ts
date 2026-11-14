import {z} from 'zod';
import {cardDisplayConfigSchema} from './card-display.js';
import {completionTemplateSchema} from './completion-template.js';
import {JUDGE_PROVIDER_IDS} from './decision-providers.js';
import {isPortableDocumentName} from './recipe-rich-filename.js';
import {hhmmSchema} from './schedule.js';
import {parseScheduleCron, resolveScheduleTimeZone} from './schedule-grammar.js';
import {judgeSectionSchema} from './settings.js';

export const RECIPE_RICH_LIMITS = Object.freeze({
  logicalBytes: 1048576, fileBytes: 131072, memoryBytes: 4096, logoBytes: 131072,
  readableBytes: 32768, rules: 32, tasks: 32, memories: 64, skills: 16, files: 64,
  setup: 8, settings: 32, parts: 194, depth: 16, nodes: 32768,
});
const utf8 = new TextEncoder();
export function recipeRichUtf8Bytes(value: string): number {return utf8.encode(value).byteLength;}
export function recipeRichIsUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const text = (maxBytes: number, maxPoints = maxBytes, minPoints = 0) => z.string()
  .refine(recipeRichIsUnicode, 'Invalid Unicode')
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Unsupported control character')
  .refine(value => recipeRichUtf8Bytes(value) <= maxBytes, 'Text byte limit exceeded')
  .refine(value => [...value].length >= minPoints && [...value].length <= maxPoints, 'Text code point limit exceeded');
const name = text(1000, 1000, 1).refine(value => value === value.trim(), 'Untrimmed identifier');
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/, 'UUID must be lowercase');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(2147483647);
const identity = {itemId: uuid, originId: uuid};

export const recipeRichPartDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({objectId: uuid, kind: z.literal('text'), sha256, bytes: z.number().int().min(0).max(RECIPE_RICH_LIMITS.fileBytes),
    mediaType: z.literal('text/plain;charset=utf-8')}).strict(),
  z.object({objectId: uuid, kind: z.literal('finalLogo'), sha256, bytes: z.number().int().positive().max(RECIPE_RICH_LIMITS.logoBytes),
    mediaType: z.literal('image/webp')}).strict(),
]);
export type RecipeRichPartDescriptor = z.infer<typeof recipeRichPartDescriptorSchema>;
export const recipeRichTextSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('inline'), value: text(RECIPE_RICH_LIMITS.fileBytes)}).strict(),
  z.object({kind: z.literal('part'), objectId: uuid}).strict(),
]);
export type RecipeRichText = z.infer<typeof recipeRichTextSchema>;

export const recipeRichOriginEdgeSchema = z.object({versionId: uuid, itemId: uuid, baselineSha256: sha256}).strict();
export const recipeRichOriginRecordSchema = z.object({
  originId: uuid, accountId: uuid,
  kind: z.enum(['publicText', 'role', 'setting', 'cardBlock', 'rule', 'skill', 'file', 'task', 'memory', 'setup', 'finalLogo']),
  sourceIntentId: uuid, sourceItemId: uuid, baselineSha256: sha256,
  parents: z.array(recipeRichOriginEdgeSchema).max(64),
}).strict().superRefine((record, context) => {
  const edges = record.parents.map(edge => `${edge.versionId}:${edge.itemId}`);
  if (new Set(edges).size !== edges.length) context.addIssue({code: 'custom', path: ['parents'], message: 'Duplicate origin edge'});
});
export type RecipeRichOriginEdge = z.infer<typeof recipeRichOriginEdgeSchema>;
export type RecipeRichOriginRecord = z.infer<typeof recipeRichOriginRecordSchema>;

const publicText = (maxBytes: number, maxPoints: number) => z.object({...identity, value: text(maxBytes, maxPoints)}).strict();
const modelSelection = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('default')}).strict(),
  z.object({kind: z.literal('explicit'), model: name, effort: name, custom: z.boolean().optional()}).strict(),
]);
const names = z.array(name).max(64).refine(value => new Set(value).size === value.length, 'Duplicate identifier');
const modelKey = name.refine(value => !['__proto__','constructor','prototype'].includes(value), 'Reserved model key');
const modelMap = <T extends z.ZodTypeAny>(value: T) => z.record(modelKey, value).refine(entries => Object.keys(entries).length <= 64, 'Model map limit exceeded');
const modelAccess = z.object({backend: name, models: names, efforts: names,
  modelEfforts: modelMap(names).optional(), modelServiceTiers: modelMap(z.array(z.enum(['fast','ultrafast'])).max(2)).optional(),
  defaultModel: name.optional(), defaultEffort: name.optional(),
}).strict().superRefine((value, context) => {
  const issue = (field: string) => context.addIssue({code: 'custom', path: [field], message: 'Inconsistent model-access recommendation'});
  if (!value.models.length) issue('models');
  if (Object.keys(value.modelEfforts ?? {}).some(model => !value.models.includes(model))) issue('modelEfforts');
  if (Object.entries(value.modelServiceTiers ?? {}).some(([model, tiers]) => !value.models.includes(model) || new Set(tiers).size !== tiers.length)) issue('modelServiceTiers');
  const defaultModel = value.defaultModel ?? value.models[0];
  if (defaultModel && !value.models.includes(defaultModel)) issue('defaultModel');
  const efforts = defaultModel && value.modelEfforts && Object.hasOwn(value.modelEfforts, defaultModel)
    ? value.modelEfforts[defaultModel]! : value.efforts;
  if (value.defaultEffort && !efforts.includes(value.defaultEffort)) issue('defaultEffort');
});
const judgeSelection = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('default')}).strict(),
  z.object({kind: z.literal('llm'), backend: name.pipe(judgeSectionSchema.shape.selection.options[1].shape.backend.unwrap()).optional(), model: name, effort: name.optional(), custom: z.boolean().optional()}).strict(),
  z.object({kind: z.literal('decision'), provider: name.pipe(judgeSectionSchema.shape.selection.options[2].shape.provider), model: name}).strict(),
  z.object({kind: z.literal('provider'), provider: z.enum(JUDGE_PROVIDER_IDS)}).strict(),
]);
const mode = z.enum(['off', 'running', 'done', 'always']);
const percent = z.number().int().min(0).max(100);
export const recipeRichCardBlockSchema = z.object({
  ...identity, id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  kind: z.enum(['context','model','time','status','tools','thinking','stop','reminder','custom']),
  name: text(320, 80, 1), slot: z.enum(['top-left','top-right','top','process','bottom-left','bottom-right','bottom','actions-left','actions-right']),
  mode, appearance: z.enum(['text','percent','bar','icon']), template: text(8000, 2000), requestedTemplate: text(320, 80).optional(),
  size: z.enum(['notation','normal']), color: z.enum(['auto','grey','blue']), warning: z.boolean(), warningAt: z.number().int().min(1).max(100),
  contextRules: z.object({yellowAt: percent, orangeAt: percent, redAt: percent, showFrom: percent,
    enabledColors: z.array(z.enum(['yellow','orange','red'])).max(3).optional()}).strict().optional(),
}).strict();
const cardDisplay = z.object({version: z.literal(1), blocks: z.array(recipeRichCardBlockSchema).max(30),
  reply: z.object({streamText: z.boolean(), collapseAfterRun: z.boolean()}).strict().optional(),
}).strict().superRefine((value, context) => {
  const native = {...value, blocks: value.blocks.map(({itemId: _itemId, originId: _originId, ...block}) => ({
    ...block, source: 'builtin', script: '', language: 'node', sample: '{}',
  }))};
  const parsed = cardDisplayConfigSchema.safeParse(native);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({code: 'custom', path: issue.path, message: 'Invalid inert card configuration'});
});
const setting = <T extends string, V extends z.ZodTypeAny>(field: T, value: V) => z.object({...identity, field: z.literal(field), value}).strict();
export const recipeRichSettingSchema = z.discriminatedUnion('field', [
  setting('sessionMode', z.enum(['multi','single','smart'])),
  setting('response.noMention', z.boolean()),
  setting('run.pendingPolicy', z.enum(['default','steer','queue'])),
  setting('presentation.voiceEnabled', z.boolean()),
  setting('presentation.showToolCalls', z.boolean()),
  setting('presentation.showModel', z.enum(['off','running','always'])),
  setting('presentation.completionMode', z.enum(['manual','long','failures','always'])),
  setting('presentation.longTaskMinutes', z.number().int().min(1).max(1440)),
  setting('presentation.completionTemplate', text(2000, 500).pipe(completionTemplateSchema).nullable()),
  setting('presentation.cardDisplay', cardDisplay.nullable()),
  setting('model.recommendation', z.object({backend: name, selection: modelSelection}).strict()),
  setting('modelAccess.recommendation', modelAccess),
  setting('speed.recommendation', z.object({tier: z.enum(['inherit','standard','fast','ultrafast'])}).strict()),
  setting('judge.recommendation', judgeSelection),
  setting('permission.requirement', z.object({mode: z.enum(['qa','write','full'])}).strict()),
  setting('permission.codex.requirement', z.object({sandbox: z.enum(['read-only','workspace-write','danger-full-access']), network: z.boolean()}).strict()),
  setting('permission.claude.requirement', z.object({permissionMode: z.enum(['default','acceptEdits','plan','auto','bypassPermissions']),
    sandbox: z.boolean(), network: z.enum(['off','all'])}).strict()),
]);
export type RecipeRichSetting = z.infer<typeof recipeRichSettingSchema>;

const rule = z.object({...identity, purpose: z.enum(['work','smartRespond','smartNewTopic']), text: recipeRichTextSchema}).strict();
const relativeName = text(240, 240, 1).refine(isPortableDocumentName, 'Unsafe portable filename');
const file = z.object({...identity, name: relativeName, use: z.enum(['skillDescription','reference','declaration']), text: recipeRichTextSchema}).strict();
const skill = z.object({...identity, name: text(320, 80, 1), entryFileId: uuid, fileIds: z.array(uuid).min(1).max(64)}).strict();
const cadence = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('once'), at: z.number().int().nonnegative().safe()}).strict(),
  z.object({kind: z.literal('every'), minutes: z.number().int().min(1).max(10080)}).strict(),
  z.object({kind: z.literal('daily'), time: hhmmSchema}).strict(),
  z.object({kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time: hhmmSchema}).strict(),
  z.object({kind: z.literal('cron'), expr: text(100, 100, 9).refine(value => {
    try {parseScheduleCron(value); return true;} catch {return false;}
  }, 'Invalid native cron')}).strict(),
]);
const timezone = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('targetChoice')}).strict(),
  z.object({kind: z.literal('recommended'), iana: z.string().max(100).regex(/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/).refine(value => {
    try {resolveScheduleTimeZone(value); return true;} catch {return false;}
  }, 'Unknown timezone recommendation')}).strict(),
]);
const task = z.object({...identity, name: text(160, 40).refine(value => value.length <= 40, 'Native task name limit exceeded'), instruction: recipeRichTextSchema, spec: cadence,
  timeZone: timezone, placement: z.enum(['follow','newTopic'])}).strict();
const setup = z.object({...identity, kind: z.enum(['config','tool','context']), title: text(320, 80),
  instructions: text(2048), check: text(512).optional(), required: z.boolean(),
  action: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('manual')}).strict(),
    z.object({kind: z.literal('nativeSettings'), entry: z.enum(['model','modelAccess','permission','response','conversation','run','smartRules','presentation','judge','speed'])}).strict(),
  ]),
}).strict();
export const recipeRichContentSchema = z.object({
  format: z.literal('rich-v2'), schemaVersion: z.literal(2),
  public: z.object({name: publicText(240, 60), summary: publicText(960, 240),
    overview: publicText(32768, 32768), version: publicText(160, 40)}).strict(),
  role: z.object({...identity, text: recipeRichTextSchema}).strict().optional(),
  settings: z.array(recipeRichSettingSchema).max(RECIPE_RICH_LIMITS.settings),
  rules: z.array(rule).max(RECIPE_RICH_LIMITS.rules), skills: z.array(skill).max(RECIPE_RICH_LIMITS.skills),
  files: z.array(file).max(RECIPE_RICH_LIMITS.files), tasks: z.array(task).max(RECIPE_RICH_LIMITS.tasks),
  memories: z.array(z.object({...identity, text: recipeRichTextSchema}).strict()).max(RECIPE_RICH_LIMITS.memories),
  setup: z.array(setup).max(RECIPE_RICH_LIMITS.setup),
  parts: z.array(recipeRichPartDescriptorSchema).max(RECIPE_RICH_LIMITS.parts),
  finalLogo: z.object({...identity, objectId: uuid}).strict().optional(),
}).strict();
export type RecipeRichContent = z.infer<typeof recipeRichContentSchema>;

export const recipeRichReleaseSchema = z.object({
  format: z.literal('rich-v2'), recipeId: uuid, versionId: uuid, authorId: uuid,
  revision, access: z.enum(['direct','coded']),
  contentSha256: sha256, logicalBytes: z.number().int().positive().max(RECIPE_RICH_LIMITS.logicalBytes),
}).strict();
export type RecipeRichRelease = z.infer<typeof recipeRichReleaseSchema>;
const itemKind = z.enum(['role', 'setting', 'cardBlock', 'rule', 'skill', 'file', 'task', 'memory', 'setup', 'finalLogo']);
const publicTextChange = z.object({op: z.literal('setPublicText'), itemId: uuid,
  field: z.enum(['name', 'summary', 'overview', 'version']), value: text(32768),
}).strict().superRefine((change, context) => {
  const parsed = recipeRichContentSchema.shape.public.shape[change.field].shape.value.safeParse(change.value);
  if (!parsed.success) context.addIssue({code: 'custom', path: ['value'], message: 'Invalid public field value'});
});
type SettingSchema = typeof recipeRichSettingSchema.options[number];
type CardDisplaySettingSchema = Extract<SettingSchema, {shape: {field: z.ZodLiteral<'presentation.cardDisplay'>}}>;
const editableSettings = recipeRichSettingSchema.options.filter((option): option is Exclude<SettingSchema, CardDisplaySettingSchema> =>
  option.shape.field.value !== 'presentation.cardDisplay').map(option => option.omit({itemId: true, originId: true}));
const settingChangeValue = z.union([editableSettings[0]!, editableSettings[1]!, ...editableSettings.slice(2)]);
const candidate = z.object({sourceIntentId: uuid, candidateId: uuid, expectedRevision: revision}).strict();
const candidateInclusion = z.discriminatedUnion('kind', [
  z.object({kind: z.enum(['role', 'setting', 'rule', 'skill', 'task', 'memory', 'setup', 'finalLogo']), source: candidate}).strict(),
  z.object({kind: z.literal('file'), parentItemId: uuid, source: candidate}).strict(),
  z.object({kind: z.literal('cardBlock'), parentItemId: uuid, source: candidate}).strict(),
]);
const copyReference = z.discriminatedUnion('kind', [
  z.object({kind: z.enum(['rule', 'skill', 'task', 'memory', 'setup']), itemId: uuid}).strict(),
  z.object({kind: z.enum(['file', 'cardBlock']), itemId: uuid, parentItemId: uuid}).strict(),
]);
const newSetupSource = z.union([
  z.object({kind: z.literal('accountClaim')}).strict(),
  z.object({kind: z.literal('releaseItems'), parents: z.array(recipeRichOriginEdgeSchema).min(1).max(64).refine(
    parents => new Set(parents.map(parent => `${parent.versionId}:${parent.itemId}`)).size === parents.length,
    'Duplicate origin edge')}).strict(),
]);
export const recipeRichDraftChangeSchema = z.union([
  publicTextChange,
  z.object({op: z.literal('setRoleText'), itemId: uuid, value: recipeRichTextSchema}).strict(),
  z.object({op: z.literal('setSetting'), itemId: uuid, value: settingChangeValue}).strict(),
  z.object({op: z.literal('setCardReply'), itemId: uuid, value: cardDisplay.innerType().shape.reply.unwrap()}).strict(),
  z.object({op: z.literal('setCardBlock'), itemId: uuid, value: recipeRichCardBlockSchema.omit({itemId: true, originId: true, id: true})}).strict(),
  z.object({op: z.literal('setRule'), itemId: uuid, value: rule.omit({itemId: true, originId: true})}).strict(),
  z.object({op: z.literal('setSkill'), itemId: uuid, value: skill.pick({name: true})}).strict(),
  z.object({op: z.literal('setFile'), itemId: uuid, value: file.pick({name: true, text: true})}).strict(),
  z.object({op: z.literal('setTask'), itemId: uuid, value: task.omit({itemId: true, originId: true})}).strict(),
  z.object({op: z.literal('addSetup'), value: setup.omit({itemId: true, originId: true}), source: newSetupSource}).strict(),
  z.object({op: z.literal('setSetup'), itemId: uuid, value: setup.omit({itemId: true, originId: true})}).strict(),
  z.object({op: z.literal('removeItem'), kind: itemKind, itemId: uuid}).strict(),
  z.object({op: z.literal('copyItem'), source: copyReference}).strict(),
  z.object({op: z.literal('includeCandidate'), value: candidateInclusion}).strict(),
]);
export type RecipeRichDraftChange = z.infer<typeof recipeRichDraftChangeSchema>;
export const recipeRichAuthoringPayloadSchema = z.discriminatedUnion('purpose', [
  z.object({format: z.literal('rich-v2'), purpose: z.literal('prepareDraft'), sourceIntentId: uuid, content: recipeRichContentSchema}).strict(),
  z.object({format: z.literal('rich-v2'), purpose: z.literal('editDraft'), draftId: uuid, baseRevision: revision,
    requestId: uuid, schemaVersion: z.literal(2), changes: z.array(recipeRichDraftChangeSchema).min(1).max(16)}).strict(),
]);
export type RecipeRichAuthoringPayload = z.infer<typeof recipeRichAuthoringPayloadSchema>;
