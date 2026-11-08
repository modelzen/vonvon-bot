import {z} from 'zod';

/** One declarative contract for settings, CLI, native cards and the editor. */
export type CardDisplayMode = 'off' | 'running' | 'done' | 'always';
export type CardDisplaySlot = 'top-left' | 'top-right' | 'top' | 'process' | 'bottom-left' | 'bottom-right' | 'bottom' | 'actions-left' | 'actions-right';
export type CardDisplayKind = 'context' | 'model' | 'time' | 'status' | 'tools' | 'thinking' | 'stop' | 'custom';
export type ContextColor = 'yellow' | 'orange' | 'red';
export type ContextRules = {yellowAt: number; orangeAt: number; redAt: number; showFrom: number; enabledColors?: ContextColor[] | undefined};
export type CardDisplayValues = Record<string, unknown>;
export type CardDisplayBlock = {
  id: string; kind: CardDisplayKind; name: string; slot: CardDisplaySlot; mode: CardDisplayMode;
  appearance: 'text' | 'percent' | 'bar' | 'icon'; template: string;
  size: 'notation' | 'normal'; color: 'auto' | 'grey' | 'blue';
  /** Retained for older editor drafts; contextRules is authoritative when set. */
  warning: boolean; warningAt: number;
  source: 'builtin' | 'script'; script: string; language: 'node' | 'shell' | 'powershell'; sample: string;
  contextRules?: ContextRules | undefined;
};
export type CardDisplayConfig = {
  version: 1;
  blocks: CardDisplayBlock[];
  reply?: {streamText: boolean; collapseAfterRun: boolean; flowModes?: Record<string, CardDisplayMode> | undefined} | undefined;
};
// These aliases keep UI/CLI callers using the same contract during the migration.
export type CardBlock = CardDisplayBlock;
export type DisplayMode = CardDisplayMode;
export type CardSlot = CardDisplaySlot;
export type BlockKind = CardDisplayKind;
export type CardDisplayDraft = CardDisplayConfig;

export const slotNames: Record<CardDisplaySlot, string> = {'top-left':'上方左侧','top-right':'上方右侧',top:'上方整行',process:'执行过程','bottom-left':'下方左侧','bottom-right':'下方右侧',bottom:'下方整行','actions-left':'操作区左侧','actions-right':'操作区右侧'};
export const modeNames: Record<CardDisplayMode, string> = {off:'隐藏',running:'仅执行中',done:'仅完成后',always:'全程显示'};
const infoSlots: CardDisplaySlot[] = ['top-left','top-right','top','bottom-left','bottom-right','bottom'];
export function allowedSlots(block: Pick<CardDisplayBlock,'kind'|'appearance'>): CardDisplaySlot[] {
  if (block.kind === 'stop') return ['top-left','top-right','bottom-left','bottom-right','actions-left','actions-right'];
  if (block.kind === 'tools' || block.kind === 'thinking') return ['process'];
  if (block.kind === 'time') return ['process', ...infoSlots];
  if (block.kind === 'status') return ['bottom-left','bottom-right'];
  return [...infoSlots];
}

const blank = {appearance:'text' as const,size:'notation' as const,color:'auto' as const,warning:false,warningAt:80,source:'builtin' as const,script:'',language:'node' as const,sample:'{"branch":"feature/card-style"}'};
export function defaultCardDisplay(): CardDisplayConfig {
  return {version:1,reply:{streamText:true,collapseAfterRun:true},blocks:[
    {...blank,id:'context',kind:'context',name:'上下文用量',slot:'top',mode:'always',template:'上下文 {{context.percent}}% · {{context.used}}/{{context.window}}',contextRules:{yellowAt:70,orangeAt:85,redAt:95,showFrom:0,enabledColors:['yellow','orange','red']}},
    {...blank,id:'time',kind:'time',name:'执行耗时',slot:'process',mode:'always',size:'normal',template:'{{elapsed.label}} {{elapsed.value}}'},
    {...blank,id:'status',kind:'status',name:'执行状态',slot:'bottom-left',mode:'running',template:'{{status.label}}'},
    {...blank,id:'model',kind:'model',name:'模型与思考强度',slot:'bottom-right',mode:'running',template:'{{model.name}} · {{model.effort}}'},
    {...blank,id:'tools',kind:'tools',name:'工具调用',slot:'process',mode:'always',template:''},
    {...blank,id:'thinking',kind:'thinking',name:'思考内容',slot:'process',mode:'always',template:''},
    {...blank,id:'stop',kind:'stop',name:'终止按钮',slot:'actions-left',mode:'running',appearance:'icon',template:'终止'},
  ]};
}
export function contextRulesFor(block: Pick<CardDisplayBlock,'contextRules'|'warning'|'warningAt'>): ContextRules {
  if (block.contextRules) return {...block.contextRules, enabledColors:block.contextRules.enabledColors ?? ['yellow','orange','red']};
  const redAt = block.warning ? Math.max(2, Math.min(100,block.warningAt)) : 95;
  const orangeAt = Math.min(85,redAt-1);
  return {yellowAt:Math.min(70,orangeAt-1),orangeAt,redAt,showFrom:0,enabledColors:['yellow','orange','red']};
}
export const defaultCardDisplayConfig = defaultCardDisplay;
export function isShown(block: Pick<CardDisplayBlock,'mode'>, phase: string): boolean {
  const terminal = !['thinking','tool','tool_running','streaming','running','retrying'].includes(phase);
  return block.mode === 'always' || block.mode === 'running' && !terminal || block.mode === 'done' && terminal;
}
const object = (value: unknown): Record<string,unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const forbiddenKeys = new Set(['__proto__','prototype','constructor']);
const variablePattern = /\{\{\s*([\w.]+)\s*\}\}/g;
export function interpolate(template: string, values: CardDisplayValues): {text:string;missing:string[]} {
  const missing: string[] = [];
  const text = template.replace(variablePattern,(_match,key:string) => {
    const value = key.split('.').reduce<unknown>((current,part) => !forbiddenKeys.has(part) && Object.hasOwn(object(current),part) ? object(current)[part] : undefined,values);
    if (value === undefined || value === null || typeof value === 'object') {missing.push(key);return '—';}
    return String(value);
  }).trim();
  return {text,missing:[...new Set(missing)]};
}
export const CARD_DISPLAY_VARIABLES = ['context.percent','context.used','context.window','context.mark','model.name','model.effort','elapsed.label','elapsed.value','status.label'] as const;
export function variablesFor(kind: CardDisplayKind): string[] {
  if (kind === 'stop') return [];
  if (kind === 'context') return ['context.percent','context.used','context.window'];
  if (kind === 'model') return ['model.name','model.effort'];
  if (kind === 'time') return ['elapsed.label','elapsed.value'];
  if (kind === 'status') return ['status.label'];
  return ['branch','model.name','context.percent'];
}

const modeSchema = z.enum(['off','running','done','always']);
const percent = z.number().int().min(0).max(100);
const contextRulesSchema = z.object({yellowAt:percent,orangeAt:percent,redAt:percent,showFrom:percent,enabledColors:z.array(z.enum(['yellow','orange','red'])).max(3).optional()}).strict();
const blockSchema = z.object({
  id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/,'组件 ID 只能使用字母、数字、下划线和短横线，最多 64 字符'),
  kind:z.enum(['context','model','time','status','tools','thinking','stop','custom']),name:z.string().min(1).max(80),
  slot:z.enum(['top-left','top-right','top','process','bottom-left','bottom-right','bottom','actions-left','actions-right']),mode:modeSchema,
  appearance:z.enum(['text','percent','bar','icon']),template:z.string().max(2000),size:z.enum(['notation','normal']),color:z.enum(['auto','grey','blue']),
  warning:z.boolean(),warningAt:z.number().int().min(1).max(100),source:z.enum(['builtin','script']),script:z.string().max(8192),language:z.enum(['node','shell','powershell']),sample:z.string().max(16384),contextRules:contextRulesSchema.optional(),
}).strict();

/** Shape and synchronous semantics also run when reading hand-edited settings. */
export const cardDisplayConfigSchema: z.ZodType<CardDisplayConfig> = z.object({
  version:z.literal(1),blocks:z.array(blockSchema).max(30),
  reply:z.object({streamText:z.boolean(),collapseAfterRun:z.boolean(),flowModes:z.record(z.string().max(64),modeSchema).optional()}).strict().optional(),
}).strict().superRefine((config,ctx) => {
  const issue = (path:(string|number)[],message:string) => ctx.addIssue({code:'custom',path,message});
  const ids = new Set<string>(),kinds = new Set<string>();
  if (config.blocks.filter(block => block.kind === 'custom' && block.source === 'script').length > 4) issue(['blocks'],'最多配置四个脚本组件，请合并同类数据输出');
  config.blocks.forEach((block,index) => {
    const path = ['blocks',index];
    if (ids.has(block.id)) issue([...path,'id'],'组件 ID 不可重复');
    ids.add(block.id);
    if (block.kind !== 'custom' && kinds.has(block.kind)) issue([...path,'kind'],'同一内置组件只可配置一次');
    kinds.add(block.kind);
    if (!allowedSlots(block).includes(block.slot)) issue([...path,'slot'],'这个组件不能放在该位置');
    if ((block.kind === 'stop' || block.kind === 'status') && !['off','running'].includes(block.mode)) issue([...path,'mode'],'该组件只在执行中存在，请选择 running 或 off');
    if (block.kind === 'stop' ? !['icon','text'].includes(block.appearance) : block.kind === 'context' ? !['text','percent','bar'].includes(block.appearance) : block.appearance !== 'text') issue([...path,'appearance'],'该组件不支持此显示形态');
    if (block.kind !== 'custom' && block.source !== 'builtin') issue([...path,'source'],'脚本仅用于自定义组件');
    if (block.source === 'script' && !block.script.trim()) issue([...path,'script'],'请填写脚本');
    if (block.kind === 'status' && block.template !== '{{status.label}}') issue([...path,'template'],'执行状态必须反映真实状态，使用 {{status.label}}');
    if (block.contextRules) {
      if (block.kind !== 'context') issue([...path,'contextRules'],'仅上下文组件可设置用量规则');
      const colors = block.contextRules.enabledColors ?? ['yellow','orange','red'];
      if (new Set(colors).size !== colors.length) issue([...path,'contextRules','enabledColors'],'颜色档位不可重复');
      const thresholds = (['yellow','orange','red'] as const).filter(color => colors.includes(color)).map(color => block.contextRules![`${color}At`]);
      if (thresholds.some((value,i) => i > 0 && value <= thresholds[i-1]!)) issue([...path,'contextRules'],'已启用的黄色、橙色、红色起点必须依次递增');
    }
    const available = new Set<string>(CARD_DISPLAY_VARIABLES);
    if (block.kind === 'custom' && block.source === 'script') {
      try {
        const sample:unknown = JSON.parse(block.sample);
        if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw new Error('样例输出应为 JSON 对象');
        const walk = (value:unknown,prefix:string,depth:number) => {
          if (depth > 4) throw new Error('样例输出最多嵌套四层');
          if (value !== null && typeof value === 'object') {
            const entries = Object.entries(value);
            if (entries.length > 64) throw new Error('每层最多 64 个字段');
            for (const [key,child] of entries) {
              if (forbiddenKeys.has(key) || !/^\w+$/.test(key)) throw new Error('样例字段使用字母、数字和下划线，不可使用保留字段名');
              walk(child,prefix ? `${prefix}.${key}` : key,depth+1);
            }
          } else if (prefix) available.add(prefix);
        };
        walk(sample,'',0);
      } catch (error) {issue([...path,'sample'],error instanceof Error ? error.message : '样例输出不是有效 JSON 对象');}
    }
    if (/[{}]/.test(block.template.replace(variablePattern,''))) issue([...path,'template'],'模板变量使用 {{字段名}}，不支持条件语法或未闭合的大括号');
    for (const match of block.template.matchAll(variablePattern)) if (!available.has(match[1]!)) issue([...path,'template'],`变量 ${match[1]} 不存在；请使用已知变量，或在脚本样例输出中声明`);
  });
  for (const id of Object.keys(config.reply?.flowModes ?? {})) if (!ids.has(id)) issue(['reply','flowModes',id],'过程组件的恢复记录必须引用已有组件');
});

export function parseCardDisplay(text: string): CardDisplayConfig {return cardDisplayConfigSchema.parse(JSON.parse(text) as unknown);}
