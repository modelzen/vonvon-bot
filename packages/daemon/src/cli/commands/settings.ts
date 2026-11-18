import { badArgs, CommandError } from '../command-error';
import type { z } from 'zod';
import { settingsGet, settingsSet, settingsAccess } from '../../admin/structured-commands';
import {
  agentSectionSchemas, decisionApiProviderLabel, hostSectionSchemas, isKnownJudgeSelection, openIdSchema, projectEditableSchemas, sessionSectionSchemas, sessionThreadIdSchema,
  type Agent, type AgentSettingsView, type DecisionModelsView, type HostSettingsView, type JudgeSelectionView, type Membership, type ProjectSettingsView, type SessionSettingsView,
  type SettingsAction, type SettingsReply, type SettingsScope, type SettingsView, type SmartPromptView,
} from '@vonvon/protocol';
import {
  bindingsHidden, conversationLabel, localTime, pickBot, pickGroup, print, toolLabel, want, withDaemon, type Call, type Daemon, type Io,
} from '../daemon-client';
import { TIER_NAMES } from '../../agent/permission';
import { keyMissingText } from '../../judge/decision';
import { dmChatId } from '../../project/registry';
import { readStdin } from '../../core/stdin';

type SectionSchema = { shape: Record<string, unknown>; partial(): { strict(): Pick<z.ZodType, 'safeParse'> } };
type SectionView = { stored: unknown; effective: unknown; revision: string; access: { kind: 'writable' } | { kind: 'readonly'; message: string } };
export type Kind = 'agent' | 'project' | 'session' | 'host';
/** `host`: the machine's own settings (the web page's 本机), which need no bot (cli-6-settings 4.2). */
export type Target = { bot?: string; group?: string; session?: string; host?: boolean; dm?: boolean; revision?: string; reason?: string };

/** What a private chat shows, besides the group sections it does not have: the last two are fixed (dm-agent 4.2). */
const DM_VIEW = ['model', 'speed', 'modelAccess', 'skills', 'permission', 'workspace', 'conversation', 'smartRules', 'judge', 'run', 'presentation'];
const TABLES: Record<Kind, Record<string, SectionSchema>> = { agent: agentSectionSchemas, project: projectEditableSchemas, session: sessionSectionSchemas, host: hostSectionSchemas };
const sectionNames = (kind: Kind): string[] => Object.keys(TABLES[kind]);
const FORMAT = '写成 节.项=值，例如 permission.mode=full';
// A top-level text field already takes 2024 or true as typed (parseAssignments), so only text inside JSON lands here.
const TYPES: Record<string, string> = { number: '要填数字', boolean: '要填 true 或 false', string: '要填文字，JSON 里的文字要加双引号', object: '要填 JSON', array: '要填 JSON' };
const show = (value: unknown): string => typeof value === 'string' ? value : String(JSON.stringify(value));

/** Checked before connecting: the protocol would refuse a blank --session, and that refusal is not the daemon's fault. */
function scopeKind(target: Target): Kind {
  if (target.host) {
    const others = (['bot', 'group', 'session', 'dm'] as const).filter(key => target[key] !== undefined).map(key => `--${key}`);
    if (others.length) throw badArgs(`--host 是这台电脑的设置，不和 ${others.join('、')} 一起用。`);
    return 'host';
  }
  if (target.dm) {
    if (target.group !== undefined || target.session !== undefined) throw badArgs('--dm 是这个 Bot 的私聊，不和 --group、--session 一起用。');
    return 'project';
  }
  if (target.group !== undefined && target.session !== undefined) throw badArgs('--group 和 --session 只能选一个。');
  if (target.session !== undefined && !sessionThreadIdSchema.safeParse(target.session).success) {
    throw badArgs('--session 要填会话的话题 id（1 到 1000 个字）。用 vonvon settings get --group <群> 看群里的会话。');
  }
  return target.group !== undefined ? 'project' : target.session !== undefined ? 'session' : 'agent';
}

/** JSON when it parses (true, 3, null, {…}), the raw text otherwise, so `permission.mode=full` needs no quotes. */
function parseValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function explain(section: string, schema: SectionSchema, issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String);
  const where = [section, ...path].join('.');
  switch (issue.code) {
    case 'unrecognized_keys':
      return path.length ? `${where} 没有 ${issue.keys.join('、')} 这一项。` : `${section} 没有 ${issue.keys.join('、')} 这一项。可以改的有：${Object.keys(schema.shape).join('、')}`;
    case 'invalid_value':
      return `${where} 只能是 ${issue.values.map(String).join('、')}`;
    case 'invalid_union':
      if (issue.discriminator && 'options' in issue && issue.options) {
        return `${[section, ...path.slice(0, -1)].join('.')} 的 ${issue.discriminator} 只能是 ${issue.options.map(String).join(' 或 ')}`;
      }
      return `${where}：${issue.message}`;
    case 'invalid_type': {
      if (issue.input === undefined) return `${where} 没填`;
      const expected = TYPES[issue.expected];
      return expected ? `${where} ${expected}` : `${where}：${issue.message}`;
    }
    // Lengths of text (after trimming) and lists; numbers carry no bounds in the settings schemas.
    case 'too_small': {
      const least = Number(issue.minimum);
      if (issue.origin === 'string') return least <= 1 ? `${where} 不能为空` : `${where} 至少要 ${least} 个字`;
      if (issue.origin === 'array') return `${where} 至少要 ${least} 项`;
      return `${where}：${issue.message}`;
    }
    case 'too_big': {
      const most = Number(issue.maximum);
      if (issue.origin === 'string') return `${where} 最多 ${most} 个字`;
      if (issue.origin === 'array') return `${where} 最多 ${most} 项`;
      return `${where}：${issue.message}`;
    }
    default: return `${where}：${issue.message}`;
  }
}

/** Checked before connecting with the same per-field schemas as the protocol's editSchema, so errors can name the field. */
export function parseAssignments(kind: Kind, assignments: readonly string[]): { section: string; patch: Record<string, unknown> } {
  let section: string | undefined;
  const fields = new Map<string, unknown>();
  const texts = new Map<string, string>();
  for (const assignment of assignments) {
    const equals = assignment.indexOf('=');
    const key = equals < 0 ? '' : assignment.slice(0, equals);
    const dot = key.indexOf('.');
    if (dot <= 0 || dot === key.length - 1) throw badArgs(FORMAT);
    const name = key.slice(0, dot);
    if (section !== undefined && name !== section) throw badArgs(`一次只能改一节；${section} 和 ${name} 分两次改。`);
    section = name;
    const field = key.slice(dot + 1);
    const text = assignment.slice(equals + 1);
    fields.set(field, parseValue(text));
    texts.set(field, text);
  }
  if (section === undefined) throw badArgs(FORMAT);
  if (kind === 'agent' && section === 'cards') throw badArgs('消息卡按群聊或私聊分别设置：群用 --group X presentation.cardDisplay，私聊用 --dm presentation.cardDisplay');
  if (kind === 'project' && section === 'presentation' && (fields.has('showToolCalls') || fields.has('showModel'))) throw badArgs('旧工具和模型显示字段只供迁移；请改本群或私聊的 presentation.cardDisplay');
  if (section === 'cliBridge') throw badArgs('咖啡一下第一版已拿掉，不能改。');
  if (section === 'compact' && kind === 'project') throw badArgs('自动压缩现在一直开着，不能关了。');
  if (section === 'permission' && kind === 'project' && fields.has('network')) throw badArgs('联网已经并进权限的档位：只读不联网，工作区可写联网，完全访问不限制。只读又要联网这类组合，用高级设置 permission.custom。');
  if (section === 'permission' && kind === 'project' && fields.has('guestMode')) throw badArgs('「普通成员权限」去掉了：一个群只有一个权限，群里谁说话都用它。改 permission.mode。');
  const schema = Object.hasOwn(TABLES[kind], section) ? TABLES[kind][section] : undefined;
  if (!schema) throw badArgs(`没有 ${section} 这一节。可以改的有：${sectionNames(kind).join('、')}`);
  // fromEntries keeps a key like __proto__ as data, so strict() reports it.
  const patch: Record<string, unknown> = Object.fromEntries(fields);
  const check = schema.partial().strict();
  // `paths.projectsRootDir=2024` parses as a number: a field that takes text gets the text as typed, and keeps it
  // when the text is wrong in another way, so the error names that instead of asking for text. Only numbers and
  // booleans read as text: `null`, `[]` and `{}` are never meant as the words.
  for (const [field, value] of fields) {
    if ((typeof value !== 'number' && typeof value !== 'boolean') || check.safeParse(Object.fromEntries([[field, value]])).success) continue;
    const asText = check.safeParse(Object.fromEntries([[field, texts.get(field)]]));
    if (asText.success || !asText.error.issues.some(issue => issue.code === 'invalid_type' && issue.path.length === 1)) patch[field] = texts.get(field);
  }
  const checked = check.safeParse(patch, { reportInput: true });
  if (!checked.success) throw badArgs(checked.error.issues.map(issue => explain(section, schema, issue)).join('\n'));
  return { section, patch };
}

async function resolveScope(call: Call, target: Target): Promise<{ agent: Agent; membership?: Membership; scope: SettingsScope }> {
  const snapshot = await call('读取快照', c => c.snapshot());
  const agent = pickBot(snapshot.agents, target.bot);
  // No membership: the private chat is in none, and goes by `oc_dm_<appId>`, whatever a group is called (dm-agent 4.2).
  if (target.dm) return { agent, scope: { kind: 'project', botId: agent.id, projectName: dmChatId(agent.id) } };
  if (target.group !== undefined) {
    // s1b: a group's session names no group; the daemon answers its settings read with 群里不能改设置
    if (bindingsHidden(snapshot.memberships, agent)) return { agent, scope: { kind: 'project', botId: agent.id, projectName: target.group } };
    const membership = pickGroup(snapshot.memberships, agent, target.group);
    return { agent, membership, scope: { kind: 'project', botId: agent.id, projectName: membership.name } };
  }
  if (target.session !== undefined) return { agent, scope: { kind: 'session', botId: agent.id, threadId: target.session } };
  return { agent, scope: { kind: 'agent', botId: agent.id } };
}

/** A bot's view may start its Provider for the model in effect, so a read waits as long as a save (daemon-client TIMEOUTS). */
const readView = async (call: Call, scope: SettingsScope): Promise<SettingsView> =>
  (await settingsGet({ read: async scope => want('读取设置', await call('读取设置', c => c.settings({ type: 'read', scope }), { provider: true }), 'view').view }, scope)).view;
/** The machine's settings need no bot, so no snapshot either: they work before the first bot (cli-6-settings 4.2). */
const scopeOf = async (call: Call, target: Target): Promise<SettingsScope> => target.host ? { kind: 'host' } : (await resolveScope(call, target)).scope;

function header(view: SettingsView, agent: Agent, membership?: Membership, dm?: boolean): string {
  if (dm) {
    const { backend, cwd } = (view as ProjectSettingsView).identity;
    return `Bot ${agent.name}（${agent.id}）的私聊 · ${toolLabel(backend)} · ${cwd}`;
  }
  if (membership) return `群 ${membership.name}（${membership.groupId}）· ${toolLabel(membership.backend)} · ${conversationLabel(membership.conversation)} · ${membership.directory}`;
  if (view.scope.kind === 'session') {
    const identity = (view as SessionSettingsView).identity;
    return `会话 ${view.scope.threadId} · 群 ${identity.projectName ?? identity.chatId} · ${toolLabel(identity.backend)}`;
  }
  return `Bot ${agent.name}（${agent.id}）的设置`;
}

function cut(text: string, max = 40): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** Where the judge prompt comes from, and which file to make or delete to change it (design 第 5 节). */
function promptSource(prompt: SmartPromptView, group: boolean): string {
  if (prompt.error) return `智能提示词：读不了 ${prompt.path}：${prompt.error}`;
  if (prompt.source === 'group') return `智能提示词：这个群自己的 ${prompt.path}，删掉它就回到 Bot 的`;
  if (!group) return prompt.source === 'bot' ? `智能提示词：${prompt.path}，删掉它就恢复默认` : `智能提示词：内置默认。要改就新建 ${prompt.path}，删掉它就恢复默认`;
  return `智能提示词：${prompt.source === 'bot' ? '用 Bot 的 SMART.md' : '内置默认'}。要只改这个群就新建 ${prompt.path}，删掉它就回到 Bot 的`;
}

/** The judge prompt in full, for `get judge` only: it runs to a few thousand characters. Split into lines, since printing strips a line's own breaks. */
function promptText(prompt: SmartPromptView): string[] {
  const where = { main: '群主区', topic: '话题里' } as const;
  return [
    '—— 智能提示词 ——', prompt.error ? '（读不了，见上面）' : prompt.text,
    ...(Object.keys(where) as (keyof typeof where)[]).flatMap(v => [`—— 程序附的格式行（只读）：${where[v]} ——`, prompt.formatLines[v]]),
    '—— 程序给模型的输入（示例，只读）——', prompt.inputExample,
    ...(prompt.backendNote ? ['—— 模型还会看到（只读）——', prompt.backendNote] : []),
  ].flatMap(text => text.split('\n'));
}

/** A decision model by its service's name; one the daemon lists none for is said so (a daemon from before s23f lists none at all). */
function decisionName(models: DecisionModelsView | undefined, provider: string, model: string): string {
  const known = models?.find(m => m.provider === provider);
  return `决策模型 ${known?.displayName ?? provider} 的 ${model}${models && !known ? '，这个版本的 daemon 不认识这家决策模型' : ''}`;
}

/** For each decision model the daemon calls (s23f): its key not filled in while one in use, and under `get judge`
 * how to choose it, the key filled in or not (owner: choose first, fill in later). */
function decisionLines(models: DecisionModelsView | undefined, inUse: ReadonlySet<string>, choices: boolean, scope: string): string[] {
  return (models ?? []).flatMap(m => [
    ...(inUse.has(m.provider) && !m.keySet ? [`  ${keyMissingText(m)}`] : []),
    ...(choices ? m.models.map(model => `  可选的决策模型：${m.displayName} 的 ${model.id}（${model.displayName}，key ${m.keySet ? '已填' : m.keyUnreadable ? '填没填看不出，密钥库读不了' : '还没填'}）。选它：vonvon settings set ${scope}judge.selection='${JSON.stringify({ kind: 'decision', provider: m.provider, model: model.id })}'`) : []),
  ]);
}

/** One line per backend: the bot has no backend of its own, so a single effective model would mislead. */
function judgeLines(view: AgentSettingsView): string[] {
  return Object.entries(view.judgeByBackend ?? {}).map(([id, j]) => {
    const what = j.provider ? decisionName(view.decisionModels, j.provider, j.model) : `${j.model}，${j.effort ? `推理强度 ${j.effort}` : id === 'claude-agent' ? '关思考' : '不传推理强度'}`;
    return `  ${toolLabel(id)} 的群用：${what}（${j.source === 'bot' ? 'Bot 设的' : '默认'}）`;
  });
}

/** A kind a newer daemon wrote shows as sent (v1-plan 第 5 节"旧客户端读到决策模型"); say so. */
function unknownJudge(selection: JudgeSelectionView | undefined): string[] {
  return selection && !isKnownJudgeSelection(selection) ? [`  这个版本的命令行不认识 ${selection.kind} 这一类判断模型，上面是原样`] : [];
}

/** A judge service by name: Codex and Claude are backends, the rest decision APIs. */
const providerName = (id: string): string => id === 'codex-appserver' || id === 'claude-agent' ? toolLabel(id) : decisionApiProviderLabel(id);
const readonlyNote = (value: SectionView): string => value.access.kind === 'readonly' ? `（只读：${value.access.message}）` : '';

/** `settings get --host`: what the web page's 本机 shows (cli-6-settings 4.2); `runtime` is what the daemon runs with, read only. */
function hostLines(view: HostSettingsView, section: string | undefined): string[] {
  const human = ['本机设置'];
  const sections = view.sections as Record<string, SectionView | undefined>;
  for (const name of sectionNames('host').filter(name => section === undefined || name === section)) {
    const value = Object.hasOwn(sections, name) ? sections[name] : undefined;
    if (!value) {
      if (section !== undefined) human.push(`daemon 没有 ${name} 这一节。daemon 可能比命令行旧。`);
      continue;
    }
    human.push(`[${name}]${readonlyNote(value)}`);
    if (name === 'execution') {
      const { codexBin } = value.stored as { codexBin: string | null };
      human.push(`  codexBin = ${codexBin ?? 'null（没设，自动找）'}`);
      continue;
    }
    type Judge = NonNullable<HostSettingsView['sections']['judge']>['stored'];
    const stored = value.stored as Judge;
    const effective = value.effective as Judge;
    const chosen = effective.defaultProvider ?? stored.defaultProvider;
    human.push(`  defaultProvider = ${chosen ? `${chosen}（${providerName(chosen)}）` : '没设'}${stored.defaultProvider ? '' : '，用默认'}`);
    for (const [id, model] of Object.entries(effective.byProvider ?? stored.byProvider)) {
      human.push(`  ${providerName(id)}（${id}）：${model.model}${model.effort ? `，推理强度 ${model.effort}` : ''}${model.endpoint ? `，接口 ${model.endpoint}` : ''}${Object.hasOwn(stored.byProvider, id) ? '' : '（默认）'}`);
    }
  }
  if (section === undefined) {
    const { runtime } = view;
    human.push('[runtime]（只读）', `  实际用的 Codex：${runtime.codexBin ?? '自动找'}`, `  找不到文件夹时的默认目录：${runtime.fallbackCwd}`, `  平台：${runtime.platform}`);
  }
  return human;
}

/** The list as it is; whoever scanned the bot in carries a label and nothing more. */
function adminList(view: AgentSettingsView): string {
  const { administrators: { openIds }, ownerOpenId } = view;
  if (!openIds.length) return '还没有';
  return openIds.map(id => id === ownerOpenId ? `${id}（创建者）` : id).join('、');
}

/** An empty list lets every member in (the web page's 允许所有成员); a name comes from the group's roster when it has one. */
function memberList(members: ProjectSettingsView['members']): string {
  if (!members.openIds.length) return '所有成员';
  return members.openIds.map(id => {
    const name = members.roster?.entries.find(entry => entry.openId === id)?.name;
    return name ? `${id}（${name}）` : id;
  }).join('、');
}

const commentLine = (instructions: AgentSettingsView['commentInstructions']): string =>
  `评论指令：${instructions.content.kind === 'default' ? '默认' : `自定义「${cut(instructions.content.text)}」`}`;

/** cli-6-settings 4.4: what the web page's buttons change. A daemon from before has none of it, so each part is optional. */
function agentExtras(view: AgentSettingsView, target: Target): string[] {
  const bot = target.bot !== undefined ? ` --bot ${target.bot}` : '';
  return [
    ...(view.voice ? [`语音转文字：${view.voice.enabled ? '开' : '关'}（飞书语音权限：${view.voice.feishu.message}）`] : []),
    ...(view.administrators ? [`管理员：${adminList(view)}`, `管理员改动：vonvon settings act admin add|remove <openId>${bot}`] : []),
    ...(view.commentInstructions ? [commentLine(view.commentInstructions)] : []),
  ];
}

const SKILL_SOURCES = { workspace: '本群工作区', user: '用户目录', provider: 'Provider' } as const;
/** The group's skills sit in the group's view: they come from its folders and its backend. */
function projectExtras(view: ProjectSettingsView, dm?: boolean): string[] {
  const human = view.members && !dm ? [`响应成员：${memberList(view.members)}`] : [];
  const disabled = new Set(view.sections.skills?.stored.disabledPaths ?? []);
  const off = (skill: NonNullable<ProjectSettingsView['skills']>[number]) => !skill.enabled || disabled.has(skill.path);
  if (view.skills) {
    human.push(`Skill：${view.skills.length} 个（停用 ${view.skills.filter(off).length} 个）`);
    for (const skill of view.skills) human.push(`  ${skill.name}  ${SKILL_SOURCES[skill.source] ?? skill.source}${off(skill) ? '  已停用' : ''}`);
  }
  if (view.skillsError) human.push(`${view.skills ? '  ' : 'Skill：'}${view.skillsError}`);
  return human;
}

export async function runSettingsGet(section: string | undefined, target: Target, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const kind = scopeKind(target);
  const names = target.dm ? DM_VIEW : sectionNames(kind);
  if (section !== undefined && !names.includes(section)) throw badArgs(`${target.dm ? '私聊' : ''}没有 ${section} 这一节。可以看的有：${names.join('、')}`);
  if (kind === 'host') {
    const view = await daemon(call => readView(call, { kind: 'host' })) as HostSettingsView;
    return print(io, hostLines(view, section), { view });
  }
  const { agent, membership, view, sessions } = await daemon(async call => {
    const { agent, membership, scope } = await resolveScope(call, target);
    const view = await readView(call, scope);
    const sessions = membership
      ? want('读取会话列表', await call('读取会话列表', c => c.settings({ type: 'sessions', botId: agent.id, projectName: membership.name })), 'sessions').sessions
      : undefined;
    return { agent, membership, view, sessions };
  });
  const human = [header(view, agent, membership, target.dm)];
  const sections = view.sections as Record<string, SectionView>;
  const fullOnly = view.scope.kind === 'project' ? (view as ProjectSettingsView).identity.fullOnly : undefined;
  for (const name of names.filter(name => section === undefined || name === section)) {
    const value = Object.hasOwn(sections, name) ? sections[name] : undefined;
    // 智能 has no 免@ (s25c): its stored value does nothing, so it is not shown.
    if (name === 'response' && view.scope.kind === 'project' && (view as ProjectSettingsView).identity.kind === 'smart') {
      human.push('免 @：智能群没有这一项，回不回由 Bot 判断');
      continue;
    }
    if (!value) {
      // asked for by name: say why nothing shows (same words as set)
      if (section !== undefined) human.push(`daemon 没有 ${name} 这一节。daemon 可能比命令行旧。`);
      continue;
    }
    human.push(`[${name}]${value.access.kind === 'readonly' ? `（只读：${value.access.message}）` : ''}`);
    const effective = (value.effective ?? {}) as Record<string, unknown>;
    // Only what `set` takes: the view's deprecated permission.guestMode (s15c) is left out.
    const settable = TABLES[kind][name]!.shape;
    // The bot's judge model differs per backend: judgeLines, not one effective value.
    const botJudge = name === 'judge' && view.scope.kind === 'agent';
    for (const [key, stored] of Object.entries((value.stored ?? {}) as Record<string, unknown>)) {
      if (!Object.hasOwn(settable, key)) continue;
      const live = effective[key];
      human.push(`  ${key} = ${show(stored)}${botJudge || JSON.stringify(live) === JSON.stringify(stored) ? '' : `（生效：${show(live)}）`}`);
    }
    if (name === 'permission' && view.scope.kind === 'project') {
      const permission = value.stored as ProjectSettingsView['sections']['permission']['stored'];
      const options = permission.options;
      human.push(`  权限：${options?.invalid ? '高级设置读不出来，现在按只读跑' : options?.customSummary ? `自定义（${options.customSummary}）${options.legacy ? '（从旧版的联网开关转来）' : ''}` : TIER_NAMES[permission.mode]}`);
      if (options?.fields?.length && !target.dm) {
        human.push('    高级设置（permission.custom）：');
        for (const field of options.fields) {
          const values = field.kind === 'choice' ? field.choices?.map(choice => choice.value).join(' | ')
            : field.kind === 'switch' ? 'true | false' : '["github.com", …]';
          const condition = field.showWhen ? `（${field.showWhen.key}=${field.showWhen.in.join(' | ')} 时）` : '';
          human.push(`      ${field.key}  ${field.label}：${values ?? ''}${condition}`);
        }
      }
    }
    if (name === 'permission' && fullOnly) human.push(`  ${fullOnly}`);
    if (name === 'judge') {
      const { smartPrompt: prompt, decisionModels } = view as AgentSettingsView | ProjectSettingsView;
      human.push(...unknownJudge((value.stored as { selection?: JudgeSelectionView } | undefined)?.selection));
      if (botJudge) human.push(...judgeLines(view as AgentSettingsView));
      const live = (effective as { selection?: JudgeSelectionView }).selection;
      const inUse = new Set(botJudge ? Object.values((view as AgentSettingsView).judgeByBackend ?? {}).flatMap(j => j.provider ?? [])
        : live && isKnownJudgeSelection(live) && live.kind === 'decision' ? [live.provider] : []);
      // the --bot and --group this command was given, so the line runs as printed on a machine with several bots
      const scope = `${target.bot !== undefined ? `--bot ${target.bot} ` : ''}${view.scope.kind === 'project' && target.group !== undefined ? `--group ${target.group} ` : ''}`;
      human.push(...decisionLines(decisionModels, inUse, section === 'judge', scope));
      if (prompt && !target.dm) human.push(`  ${promptSource(prompt, view.scope.kind === 'project')}`);
      human.push(target.dm ? '  只在智能模式下用' : '  只在智能模式的群里用');
      if (prompt && section === 'judge') human.push(...promptText(prompt));
    }
  }
  if (sessions) {
    const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    human.push(sessions.length ? `会话（最近 ${recent.length} 个，共 ${sessions.length} 个；看单个会话：vonvon settings get --session <id>）` : '还没有会话。');
    for (const item of recent) human.push(`  ${item.threadId}  ${localTime(item.updatedAt)}  ${item.model ?? '默认模型'}  ${cut(item.summary)}`);
  }
  // last, so the lines above keep their places; --json has all of it in the view already
  if (section === undefined && view.scope.kind === 'agent') human.push(...agentExtras(view as AgentSettingsView, target));
  if (section === undefined && view.scope.kind === 'project') human.push(...projectExtras(view as ProjectSettingsView, target.dm));
  print(io, human, { view, ...(sessions ? { sessions } : {}) });
}

export async function runSettingsSet(assignments: readonly string[], target: Target, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { section, patch } = parseAssignments(scopeKind(target), assignments);
  // A complete card object was edited from an earlier snapshot. Reading a new
  // revision here would authorize overwriting changes made in the meantime.
  if (section === 'presentation' && Object.hasOwn(patch, 'cardDisplay') && patch.cardDisplay !== null && !target.revision?.trim()) {
    throw badArgs('保存完整 presentation.cardDisplay 必须提供 --revision <读取时的版本>。先用 vonvon settings get presentation --group <群> --json（私聊用 --dm，跨 Bot 加 --bot）读取 view.sections.presentation.revision，并在同一目标上使用这个版本保存。');
  }
  const unknown = '可能已经保存，运行 vonvon settings get 查看。';
  const result = await daemon(async call => {
    const scope = await scopeOf(call, target);
    // Each section carries its own revision; there is no view-level one.
    const sections = (await readView(call, scope)).sections as Record<string, SectionView>;
    const revision = target.revision ?? (Object.hasOwn(sections, section) ? sections[section]?.revision : undefined);
    if (!revision) throw new Error(`daemon 没有 ${section} 这一节。daemon 可能比命令行旧。`);
    // a model, speed or modelAccess change is checked against the Provider's live list (#641)
    return settingsSet({ save: async edit => want('保存设置', await call('保存设置', c => c.settings({ type: 'save', edit }), { unknown, provider: true }), 'saved', unknown).result }, { scope, section, revision, patch });
  });
  // Same wording as the web page's errorText; a conflict is not retried, the user reruns with fresh eyes.
  if (result.kind === 'conflict') throw new CommandError('conflict', CONFLICT, { reason: 'conflict', current: result.current });
  if (result.kind !== 'saved') throw notSaved(result);
  // The daemon fills in a language model's backend: show what was stored, and for which groups.
  const stored = section === 'judge' ? (result.section.value.stored as { selection?: JudgeSelectionView }).selection : undefined;
  const known = stored && isKnownJudgeSelection(stored) ? stored : undefined;
  const whose = target.group !== undefined ? '' : known?.kind === 'decision' ? '（各后端的群都用）'
    : known?.kind === 'llm' && known.backend ? `（${toolLabel(known.backend)} 的群用）` : '';
  const saved = stored ? `judge.selection = ${show(stored)}${whose}`
    : Object.entries(patch).map(([key, value]) => `${section}.${key} = ${show(value)}`).join('、');
  // `warnings` (a group turned 完全访问, devices 第 15 节) print after the effects and stay in --json.
  print(io, [`已保存 ${saved}。`, ...result.effects.map(effect => effect.detail), ...result.warnings ?? []], { ...result, ...(target.reason ? { reason: target.reason } : {}) });
}

export async function runSettingsAccess(target: Target, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  scopeKind(target);
  const result = await daemon(async call => {
    const scope = await scopeOf(call, target);
    return settingsAccess({ read: async scope => readView(call, scope) }, scope);
  });
  const human = Object.entries(result.access).map(([name, access]) => {
    const each = access as SectionView['access'];
    return `${name}：${each.kind === 'writable' ? '可以改' : `只读，${each.message}`}`;
  });
  print(io, human, result);
}

// ---- settings act and settings models: the settings page's buttons and model lists (cli-6-settings) ----

const CONFLICT = '这项设置刚在别处改过，没有保存。先读取当前版本再修改。';
/** A save or an action the daemon did not make, as the exit code of its kind (cli-6-settings 4.1). */
function notSaved(result: { kind: 'rejected'; fields: { field: string; message: string }[] } | { kind: 'unavailable'; reason: SectionView['access'] & { reason?: string } }): CommandError {
  if (result.kind === 'rejected') {
    return new CommandError('bad-args', `没有保存：${result.fields.map(field => `${field.field}：${field.message}`).join('；')}`, { reason: 'rejected', partial: { fields: result.fields } });
  }
  const { reason } = result;
  return new CommandError('refused', reason.kind === 'readonly' ? reason.message : '当前不可编辑。', { reason: reason.kind === 'readonly' && reason.reason ? reason.reason : 'unavailable' });
}

type Acted = Extract<SettingsReply, { kind: 'acted' }>['result'];
type ActedView = AgentSettingsView | ProjectSettingsView;
const ACT_UNKNOWN = '可能已经改了，运行 vonvon settings get 查看。';
/** Voice checks reach Feishu and every action answers with the view read again, which may start a Provider: the
 * longest wait (daemon-client TIMEOUTS). */
async function act(call: Call, action: SettingsAction): Promise<Acted> {
  return want('修改设置', await call('修改设置', c => c.settings({ type: 'act', action }), { unknown: ACT_UNKNOWN, provider: true }), 'acted', ACT_UNKNOWN).result;
}
/** The view after a saved action; a conflict carries the part the action changes, as it is now. */
function saved<V extends ActedView>(result: Acted, part: (view: V) => unknown): { view: V; warnings: string[] } {
  if (result.kind === 'saved') return { view: result.view as V, warnings: result.warnings };
  if (result.kind === 'conflict') throw new CommandError('conflict', CONFLICT, { reason: 'conflict', current: part(result.view as V) });
  throw notSaved(result);
}
const botOf = async (call: Call, wanted?: string): Promise<Agent> => pickBot((await call('读取快照', c => c.snapshot())).agents, wanted);
const readAgent = async (call: Call, botId: Agent['id']): Promise<AgentSettingsView> => await readView(call, { kind: 'agent', botId }) as AgentSettingsView;
const OPEN_ID = 'Open ID 要以 ou_ 开头。群成员的 Open ID 用 vonvon feishu members <群 id> 查。';

export type ActTarget = { bot?: string; group?: string; revision?: string };
const VOICE = { test: 'test', refresh: 'refreshPermission' } as const;

/** `settings act voice test|refresh`: the web page's 测试 and 重新检测. Turning voice on or off is `presentation.voiceEnabled` (4.6). */
export async function runSettingsVoice(what: string, target: ActTarget, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if (!Object.hasOwn(VOICE, what)) throw badArgs('写成 voice test（测一次识别）或 voice refresh（重新检测飞书语音权限）。');
  const result = await daemon(async call => {
    const agent = await botOf(call, target.bot);
    return act(call, { kind: 'voice', botId: agent.id, action: { action: VOICE[what as keyof typeof VOICE] } });
  });
  const { view, warnings } = saved<AgentSettingsView>(result, view => view.voice);
  const { voice } = view;
  print(io, [
    `语音转文字：${voice.enabled ? '开' : '关'}`, `飞书语音权限：${voice.feishu.message}`,
    ...(voice.result ? [voice.result] : []), ...(voice.grantUrl ? [`开权限：${voice.grantUrl}`] : []), ...warnings,
  ], { result: 'saved', warnings, voice });
}

/** `settings act admin add|remove <openId>`: this machine's administrators of a bot. Sent as asked: the daemon is idempotent. */
export async function runSettingsAdmin(op: string, openId: string, target: ActTarget, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const membership = op === 'add' ? 'present' : op === 'remove' ? 'absent' : undefined;
  if (!membership) throw badArgs('写成 admin add <openId> 或 admin remove <openId>。');
  if (!openIdSchema.safeParse(openId).success) throw badArgs(OPEN_ID);
  const result = await daemon(async call => {
    const agent = await botOf(call, target.bot);
    const revision = target.revision ?? (await readAgent(call, agent.id)).administrators.revision;
    return act(call, { kind: 'adminMember', botId: agent.id, openId, membership, revision });
  });
  const { view, warnings } = saved<AgentSettingsView>(result, view => view.administrators);
  print(io, [`${membership === 'present' ? '已加上' : '已去掉'}管理员 ${openId}。`, `管理员：${adminList(view)}`, ...warnings],
    { result: 'saved', warnings, administrators: view.administrators });
}

/** `settings act member add|remove <openId>` and `member all`: who a group responds to; an empty list is everyone. */
export async function runSettingsMember(op: string, openId: string | undefined, target: ActTarget, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if (op !== 'add' && op !== 'remove' && op !== 'all') throw badArgs('写成 member add <openId>、member remove <openId> 或 member all。');
  if (op === 'all' && openId !== undefined) throw badArgs('member all 不带 Open ID：它清空名单，让所有成员都能用。');
  if (op !== 'all' && (openId === undefined || !openIdSchema.safeParse(openId).success)) throw badArgs(OPEN_ID);
  if (target.group === undefined) throw badArgs('要给 --group <群>（群 id oc_… 或项目名）。');
  const outcome = await daemon(async (call): Promise<{ result: Acted } | { unchanged: ProjectSettingsView['members'] }> => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = pickBot(snapshot.agents, target.bot);
    const projectName = bindingsHidden(snapshot.memberships, agent) ? target.group! : pickGroup(snapshot.memberships, agent, target.group!).name;
    let revision = target.revision;
    if (revision === undefined) {
      const { members } = await readView(call, { kind: 'project', botId: agent.id, projectName }) as ProjectSettingsView;
      // as the web page, which shows 允许所有成员 only over a list (4.6)
      if (op === 'all' && !members.openIds.length) return { unchanged: members };
      revision = members.revision;
    }
    const action: SettingsAction = op === 'all'
      ? { kind: 'projectAudience', botId: agent.id, projectName, audience: 'all', revision }
      : { kind: 'projectMember', botId: agent.id, projectName, openId: openId!, membership: op === 'add' ? 'present' : 'absent', revision };
    return { result: await act(call, action) };
  });
  if ('unchanged' in outcome) return print(io, ['已经是所有成员都能用，没有改。'], { result: 'unchanged', warnings: [], members: outcome.unchanged });
  const { view, warnings } = saved<ProjectSettingsView>(outcome.result, view => view.members);
  const done = op === 'all' ? '已改成所有成员都能用。' : `${op === 'add' ? '已加上' : '已去掉'}响应成员 ${openId}。`;
  print(io, [done, `响应成员：${memberList(view.members)}`, ...warnings], { result: 'saved', warnings, members: view.members });
}

export type InstructionSource = { default?: boolean; text?: string; stdin?: boolean };
/** Where `--stdin` reads; a terminal is refused, so the command never waits on a person. */
export type Stdin = { isTTY: boolean; read(): Promise<string> };
const processStdin = (): Stdin => ({ isTTY: Boolean(process.stdin.isTTY), read: readStdin });
/** The protocol's bound, checked before connecting; the view's `maxEditLength` once read. */
const MAX_INSTRUCTIONS = 30000;
const tooLong = (max: number): CommandError => badArgs(`评论指令最多 ${max} 个字，这次没有发出。`);

/** `settings act comment-instructions --default | --text <t> | --stdin`: the web page's 恢复默认 and 自定义. */
export async function runSettingsCommentInstructions(source: InstructionSource, target: ActTarget, io: Io, daemon: Daemon = withDaemon, stdin: Stdin = processStdin()): Promise<void> {
  const given = [source.default && '--default', source.text !== undefined && '--text', source.stdin && '--stdin'].filter(Boolean);
  if (given.length !== 1) throw badArgs(`--default、--text <文字>、--stdin 正好给一个${given.length ? `，这次给了 ${given.join('、')}` : ''}。`);
  let text = source.text;
  if (source.stdin) {
    if (stdin.isTTY) throw badArgs('--stdin 要从管道读，例如 cat 说明.md | vonvon settings act comment-instructions --stdin');
    text = (await stdin.read()).replace(/\r?\n$/, '');
  }
  if (text !== undefined && !text.trim()) throw badArgs(source.stdin ? '--stdin 没读到内容。' : '--text 不能为空；要恢复默认用 --default。');
  if (text !== undefined && text.length > MAX_INSTRUCTIONS) throw tooLong(MAX_INSTRUCTIONS);
  const result = await daemon(async call => {
    const agent = await botOf(call, target.bot);
    let revision = target.revision;
    if (revision === undefined) {
      const { commentInstructions } = await readAgent(call, agent.id);
      if (text !== undefined && text.length > commentInstructions.maxEditLength) throw tooLong(commentInstructions.maxEditLength);
      revision = commentInstructions.revision;
    }
    return act(call, { kind: 'commentInstructions', botId: agent.id, revision, content: text === undefined ? { kind: 'default' } : { kind: 'custom', text } });
  });
  const { view, warnings } = saved<AgentSettingsView>(result, view => view.commentInstructions);
  print(io, [`已保存。${commentLine(view.commentInstructions)}`, ...warnings], { result: 'saved', warnings, commentInstructions: view.commentInstructions });
}

const BACKEND_ALIASES: Record<string, string> = { codex: 'codex-appserver', claude: 'claude-agent' };
const PURPOSES = ['project', 'session', 'comments', 'titles', 'judge'] as const;
export type ModelsTarget = { bot?: string; backend?: string; purpose?: string; session?: string; refresh?: boolean; dm?: boolean };

/** `settings models`: what a model picker on the settings page lists; hidden models only in --json. */
export async function runSettingsModels(target: ModelsTarget, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if (!target.dm && !target.backend?.trim()) throw badArgs('要给 --backend：codex、claude，或者 codex-appserver 这样的 id。');
  if (target.dm && target.purpose !== undefined && target.purpose !== 'project') throw badArgs('--dm 列的是私聊的模型选择，不和别的 --purpose 一起用。');
  const purpose = target.dm ? 'project' : PURPOSES.find(purpose => purpose === target.purpose);
  if (!purpose) throw badArgs(`要给 --purpose：${PURPOSES.join('、')} 选一个。`);
  if (purpose === 'session' && target.session === undefined) throw badArgs('--purpose session 要给 --session <会话的话题 id>。');
  if (target.session !== undefined && !sessionThreadIdSchema.safeParse(target.session).success) throw badArgs('--session 要填会话的话题 id（1 到 1000 个字）。');
  const given = target.backend?.trim();
  const named = given && Object.hasOwn(BACKEND_ALIASES, given) ? BACKEND_ALIASES[given]! : given;
  const { backend, catalog } = await daemon(async call => {
    const agent = await botOf(call, target.bot);
    // The private chat's own Provider, unless asked about another.
    const backend = named ?? agent.dm?.backend;
    if (!backend) throw badArgs('这个 Bot 还没有私聊：启动过一次才有。也可以用 --backend 指定。');
    const query = { botId: agent.id, backend, purpose, ...(target.session !== undefined ? { threadId: target.session } : {}), ...(target.refresh ? { refresh: true } : {}) };
    // the bot process asks the backend for its list, which can outlast the local wait
    return { backend, catalog: want('读取模型目录', await call('读取模型目录', c => c.settings({ type: 'models', query }), { provider: true }), 'models').catalog };
  });
  if (catalog.state === 'unavailable') throw new CommandError('refused', `读不到 ${toolLabel(backend)} 的模型目录${catalog.error ? `：${catalog.error}` : '。'}`, { reason: 'models_unavailable' });
  const visible = catalog.models.filter(model => !model.hidden);
  print(io, [
    ...(catalog.state === 'fallback' ? ['daemon 没拿到最新目录，这是内置的'] : []),
    ...(visible.length ? visible.map(model => `${model.id}  ${model.displayName}${model.isDefault ? '（默认）' : ''}`) : ['没有可选的模型。']),
  ], { catalog });
}
