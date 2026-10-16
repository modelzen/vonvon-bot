import {
  agentSectionSchemas, projectSectionSchemas, sessionSectionSchemas, sessionThreadIdSchema,
  type Agent, type Membership, type ProjectSettingsView, type SessionSettingsView, type SettingsScope, type SettingsView,
} from '@vonvon/protocol';
import {
  conversationLabel, localTime, pickBot, pickGroup, print, toolLabel, want, withDaemon, type Call, type Daemon, type Io,
} from '../daemon-client';

// Structural views of the protocol's zod objects: the daemon's own zod is v4, protocol's is v3 (see daemon-client).
type Issue = { code: string; path: readonly (string | number)[]; message: string; keys?: readonly string[]; options?: readonly unknown[]; expected?: unknown; received?: unknown };
type Check = { safeParse(value: unknown): { success: true } | { success: false; error: { issues: readonly Issue[] } } };
type SectionSchema = { shape: Record<string, unknown>; partial(): { strict(): Check } };
type SectionView = { stored: unknown; effective: unknown; revision: string; access: { kind: 'writable' } | { kind: 'readonly'; message: string } };
export type Kind = 'agent' | 'project' | 'session';
export type Target = { bot?: string; group?: string; session?: string };

const TABLES: Record<Kind, Record<string, SectionSchema>> = { agent: agentSectionSchemas, project: projectSectionSchemas, session: sessionSectionSchemas };
const sectionNames = (kind: Kind): string[] => Object.keys(TABLES[kind]);
const FORMAT = '写成 节.项=值，例如 permission.mode=full';
// A top-level text field already takes 2024 or true as typed (parseAssignments), so only text inside JSON lands here.
const TYPES: Record<string, string> = { number: '要填数字', boolean: '要填 true 或 false', string: '要填文字，JSON 里的文字要加双引号', object: '要填 JSON', array: '要填 JSON' };
const show = (value: unknown): string => typeof value === 'string' ? value : String(JSON.stringify(value));

/** Checked before connecting: the protocol would refuse a blank --session, and that refusal is not the daemon's fault. */
function scopeKind(target: Target): Kind {
  if (target.group !== undefined && target.session !== undefined) throw new Error('--group 和 --session 只能选一个。');
  if (target.session !== undefined && !sessionThreadIdSchema.safeParse(target.session).success) {
    throw new Error('--session 要填会话的话题 id（1 到 1000 个字）。用 vonvon settings get --group <群> 看群里的会话。');
  }
  return target.group !== undefined ? 'project' : target.session !== undefined ? 'session' : 'agent';
}

/** JSON when it parses (true, 3, null, {…}), the raw text otherwise, so `permission.mode=full` needs no quotes. */
function parseValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function explain(section: string, schema: SectionSchema, issue: Issue): string {
  const where = [section, ...issue.path].join('.');
  switch (issue.code) {
    case 'unrecognized_keys':
      return issue.path.length ? `${where} 没有 ${(issue.keys ?? []).join('、')} 这一项。` : `${section} 没有 ${(issue.keys ?? []).join('、')} 这一项。可以改的有：${Object.keys(schema.shape).join('、')}`;
    case 'invalid_enum_value': return `${where} 只能是 ${(issue.options ?? []).join('、')}`;
    case 'invalid_union_discriminator': return `${[section, ...issue.path.slice(0, -1)].join('.')} 的 ${String(issue.path.at(-1))} 只能是 ${(issue.options ?? []).join(' 或 ')}`;
    case 'invalid_type': {
      if (issue.received === 'undefined') return `${where} 没填`;
      const expected = String(issue.expected);
      // A non-string for an enum reports the options as the expected type: 'off' | 'running' | 'always'.
      return `${where} ${TYPES[expected] ?? `只能是 ${expected.split(' | ').map(option => option.replace(/^'(.*)'$/, '$1')).join('、')}`}`;
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
    if (dot <= 0 || dot === key.length - 1) throw new Error(FORMAT);
    const name = key.slice(0, dot);
    if (section !== undefined && name !== section) throw new Error(`一次只能改一节；${section} 和 ${name} 分两次改。`);
    section = name;
    const field = key.slice(dot + 1);
    const text = assignment.slice(equals + 1);
    fields.set(field, parseValue(text));
    texts.set(field, text);
  }
  if (section === undefined) throw new Error(FORMAT);
  if (section === 'cliBridge') throw new Error('咖啡一下第一版已拿掉，不能改。');
  if (section === 'compact' && kind === 'project') throw new Error('自动压缩现在一直开着，不能关了。');
  const schema = Object.hasOwn(TABLES[kind], section) ? TABLES[kind][section] : undefined;
  if (!schema) throw new Error(`没有 ${section} 这一节。可以改的有：${sectionNames(kind).join('、')}`);
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
  const checked = check.safeParse(patch);
  if (!checked.success) throw new Error(checked.error.issues.map(issue => explain(section, schema, issue)).join('\n'));
  return { section, patch };
}

async function resolveScope(call: Call, target: Target): Promise<{ agent: Agent; membership?: Membership; scope: SettingsScope }> {
  const snapshot = await call('读取快照', c => c.snapshot());
  const agent = pickBot(snapshot.agents, target.bot);
  if (target.group !== undefined) {
    const membership = pickGroup(snapshot.memberships, agent, target.group);
    return { agent, membership, scope: { kind: 'project', botId: agent.id, projectName: membership.name } };
  }
  if (target.session !== undefined) return { agent, scope: { kind: 'session', botId: agent.id, threadId: target.session } };
  return { agent, scope: { kind: 'agent', botId: agent.id } };
}

const readView = async (call: Call, scope: SettingsScope): Promise<SettingsView> =>
  want('读取设置', await call('读取设置', c => c.settings({ type: 'read', scope })), 'view').view;

function header(view: SettingsView, agent: Agent, membership?: Membership): string {
  if (membership) return `群 ${membership.name}（${membership.groupId}）· ${toolLabel(membership.backend)} · ${conversationLabel(membership.conversation)} · ${membership.directory}`;
  if (view.scope.kind === 'session') {
    const identity = (view as SessionSettingsView).identity;
    return `会话 ${view.scope.threadId} · 群 ${identity.projectName ?? identity.chatId} · ${toolLabel(identity.backend)}`;
  }
  return `bot ${agent.name}（${agent.id}）的设置`;
}

function cut(text: string, max = 40): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

export async function runSettingsGet(section: string | undefined, target: Target, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const names = sectionNames(scopeKind(target));
  if (section !== undefined && !names.includes(section)) throw new Error(`没有 ${section} 这一节。可以看的有：${names.join('、')}`);
  const { agent, membership, view, sessions } = await daemon(async call => {
    const { agent, membership, scope } = await resolveScope(call, target);
    const view = await readView(call, scope);
    const sessions = membership
      ? want('读取会话列表', await call('读取会话列表', c => c.settings({ type: 'sessions', botId: agent.id, projectName: membership.name })), 'sessions').sessions
      : undefined;
    return { agent, membership, view, sessions };
  });
  const human = [header(view, agent, membership)];
  const sections = view.sections as Record<string, SectionView>;
  const fullOnly = view.scope.kind === 'project' ? (view as ProjectSettingsView).identity.fullOnly : undefined;
  for (const name of names.filter(name => section === undefined || name === section)) {
    const value = Object.hasOwn(sections, name) ? sections[name] : undefined;
    if (!value) continue;
    human.push(`[${name}]${value.access.kind === 'readonly' ? `（只读：${value.access.message}）` : ''}`);
    const effective = (value.effective ?? {}) as Record<string, unknown>;
    for (const [key, stored] of Object.entries((value.stored ?? {}) as Record<string, unknown>)) {
      const live = effective[key];
      human.push(`  ${key} = ${show(stored)}${JSON.stringify(live) === JSON.stringify(stored) ? '' : `（生效：${show(live)}）`}`);
    }
    if (name === 'permission' && fullOnly) human.push(`  ${fullOnly}`);
  }
  if (sessions) {
    const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    human.push(sessions.length ? `会话（最近 ${recent.length} 个，共 ${sessions.length} 个；看单个会话：vonvon settings get --session <id>）` : '还没有会话。');
    for (const item of recent) human.push(`  ${item.threadId}  ${localTime(item.updatedAt)}  ${item.model ?? '默认模型'}  ${cut(item.summary)}`);
  }
  print(io, human, { view, ...(sessions ? { sessions } : {}) });
}

export async function runSettingsSet(assignments: readonly string[], target: Target, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { section, patch } = parseAssignments(scopeKind(target), assignments);
  const unknown = '可能已经保存，运行 vonvon settings get 查看。';
  const result = await daemon(async call => {
    const { scope } = await resolveScope(call, target);
    // Each section carries its own revision; there is no view-level one.
    const sections = (await readView(call, scope)).sections as Record<string, SectionView>;
    const revision = Object.hasOwn(sections, section) ? sections[section]?.revision : undefined;
    if (!revision) throw new Error(`daemon 没有 ${section} 这一节。daemon 可能比命令行旧。`);
    const reply = await call('保存设置', c => c.settings({ type: 'save', edit: { scope, section, revision, patch } }), { unknown });
    return want('保存设置', reply, 'saved', unknown).result;
  });
  // Same wording as the web page's errorText; a conflict is not retried, the user reruns with fresh eyes.
  if (result.kind === 'conflict') throw new Error('这项设置刚在别处改过，没有保存。重新运行一次。');
  if (result.kind === 'rejected') throw new Error(`没有保存：${result.fields.map(field => `${field.field}：${field.message}`).join('；')}`);
  if (result.kind === 'unavailable') throw new Error(result.reason.kind === 'readonly' ? result.reason.message : '当前不可编辑。');
  const saved = Object.entries(patch).map(([key, value]) => `${section}.${key} = ${show(value)}`).join('、');
  print(io, [`已保存 ${saved}。`, ...result.effects.map(effect => effect.detail)], { section: result.section, effects: result.effects });
}
