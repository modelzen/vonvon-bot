import { isAbsolute } from 'node:path';
import { JUDGE_PROVIDER_IDS, WELCOME_CARD_INTRO_MAX, WELCOME_CARD_TITLE_MAX, cardDisplayConfigSchema, completionTemplateSchema } from '@vonvon/protocol';
import { isHomeRelative } from '../platform/home-path';
import type { SettingsAction, SettingsEdit, SettingsScope, ModelQuery } from './settings-types';
export class SettingsInputError extends Error {
}
type Rule = (value: unknown) => boolean;
const bool: Rule = value => typeof value === 'boolean';
const isPlainObject: Rule = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const body: Rule = value => typeof value === 'string' && value.length <= 30000;
/** A legacy SOUL.md may be longer than the other texts; the daemon enforces the write limits. */
const roleBody: Rule = value => typeof value === 'string' && value.length <= 70000;
const selector: Rule = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
const text: Rule = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const welcomeTitle: Rule = value => typeof value === 'string' && value.length <= WELCOME_CARD_TITLE_MAX && !/[\r\n\0]/.test(value);
const welcomeIntro: Rule = value => typeof value === 'string' && value.length <= WELCOME_CARD_INTRO_MAX && !value.includes('\0');
const one = (...values: readonly unknown[]): Rule => value => values.includes(value);
const integer = (min: number, max: number): Rule => value => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const identifier = (prefix: string): Rule => value => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,200}$`).test(value);
const array = (rule: Rule): Rule => value => Array.isArray(value) && value.length <= 1000 && value.every(rule);
const stringMap = (rule: Rule): Rule => value => isPlainObject(value) && Object.keys(value as object).length <= 1000 && Object.entries(value as Record<string, unknown>).every(([key, entry]) => text(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && rule(entry));
const path: Rule = value => value === null || typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value) && (isAbsolute(value) || isHomeRelative(value));
export function settingsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SettingsInputError('设置请求必须是对象');
  return value as Record<string, unknown>;
}
function shape(rules: Record<string, Rule>, partial = false): Rule {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const record = settingsObject(value);
    return Object.keys(record).every(key => Object.hasOwn(rules, key) && rules[key]!(record[key])) && (partial || Object.keys(rules).every(key => Object.hasOwn(record, key)));
  };
}
const selection: Rule = value => shape({
  kind: one('default')
})(value) || shape({
  kind: one('explicit'),
  model: text,
  effort: text
})(value) || shape({
  kind: one('explicit'),
  model: text,
  effort: text,
  custom: bool
})(value);
// The judge model (s23d): llm may leave out backend, effort and custom; decision takes no backend.
const judgeSelection: Rule = value => shape({
  kind: one('default')
})(value) || shape({
  kind: one('provider'),
  provider: one(...JUDGE_PROVIDER_IDS)
})(value) || shape({
  kind: one('llm'),
  backend: text,
  model: text,
  effort: text,
  custom: bool
}, true)(value) && (value as Record<string, unknown>).kind === 'llm' && Object.hasOwn(value as object, 'model') || shape({
  kind: one('decision'),
  provider: text,
  model: text
})(value);
const title: Rule = value => shape({
  enabled: one(false)
})(value) || shape({
  enabled: one(true),
  model: text,
  effort: text
})(value);
const schemas: Record<string, Record<string, Rule>> = {
  agent: {
    profile: shape({ persona: body, memory: body }, true),
    role: shape({ identity: roleBody, notes: roleBody }, true),
    welcome: shape({ title: welcomeTitle, intro: welcomeIntro }, true),
    run: shape({
      maxConcurrentRuns: integer(1, 50),
      runIdleTimeoutSeconds: value => value === 0 || integer(10, 3600)(value),
      pendingPolicy: one('steer', 'queue')
    }, true),
    completion: shape({
      mode: one('manual', 'long', 'failures', 'always'),
      longTaskMinutes: integer(1, 1440)
    }, true),
    comments: shape({
      backend: text,
      selection
    }, true),
    titles: value => shape({ policy: value => shape({ enabled: one(false) })(value) || shape({
      enabled: one(true), backend: text, model: text, effort: text
    })(value) })(value) || shape({ byBackend: value => {
      const map = settingsObject(value);
      return Object.keys(map).length === 1 && Object.entries(map).every(([key, policy]) => text(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && title(policy));
    } })(value),
    paths: shape({
      projectsRootDir: path
    }, true),
    access: shape({
      allowedChats: array(identifier('oc'))
    }, true),
    judge: shape({
      selection: judgeSelection
    }),
  },
  project: {
    profile: shape({ persona: body, memory: body, inheritPersona: bool, inheritMemory: bool }, true),
    role: shape({ supplement: body }, true),
    modelAccess: shape({ backend: text, models: value => array(text)(value) && (value as unknown[]).length > 0, efforts: array(text), modelEfforts: stringMap(array(text)), modelServiceTiers: stringMap(array(one('fast', 'ultrafast'))), defaultModel: text, defaultEffort: text }, true),
    workspace: shape({ primary: value => value !== null && path(value), directories: array(value => value !== null && path(value)), repositories: array(value => value !== null && path(value)) }, true),
    smartRules: shape({ respond: body, newTopic: body }, true),
    skills: shape({ disabledPaths: array(selector) }, true),
    presentation: shape({ voiceEnabled: bool, showToolCalls: bool, showModel: one('off', 'running', 'always'), cardDisplay: value => value === null || cardDisplayConfigSchema.safeParse(value).success, completionMode: one('manual', 'long', 'failures', 'always'), longTaskMinutes: integer(1, 1440), completionTemplate: value => value === null || completionTemplateSchema.safeParse(value).success }, true),
    permission: shape({
      mode: one('qa', 'write', 'full'),
      custom: value => value === null || isPlainObject(value)
    }, true),
    response: shape({
      noMention: bool
    }, true),
    conversation: shape({ mode: one('smart', 'single') }),
    model: shape({
      selection
    }),
    speed: shape({ tier: one('inherit', 'standard', 'fast', 'ultrafast') }),
    run: shape({
      pendingPolicy: one('default', 'steer', 'queue')
    }),
    judge: shape({
      selection: judgeSelection
    })
  },
  session: {
    model: shape({
      selection
    }),
    speed: shape({ tier: one('standard', 'fast', 'ultrafast') })
  },
  host: {
    execution: shape({
      codexBin: path
    }),
    judge: shape({ defaultProvider: one(...JUDGE_PROVIDER_IDS), byProvider: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      return Object.entries(value).every(([provider, choice]) =>
        text(provider) && !['__proto__','constructor','prototype'].includes(provider) && shape({ model: text, effort: text, custom: bool, endpoint: value => typeof value === 'string' && value.length <= 2048 }, true)(choice)
        && Object.hasOwn(choice as object, 'model'));
    } }, true)
  },
};
export function parseSettingsScope(input: unknown): SettingsScope {
  const object = settingsObject(input);
  const scopes: Record<string, Rule> = {
    host: shape({
      kind: one('host')
    }),
    agent: shape({
      kind: one('agent'),
      botId: identifier('cli')
    }),
    project: shape({
      kind: one('project'),
      botId: identifier('cli'),
      projectName: text
    }),
    session: shape({
      kind: one('session'),
      botId: identifier('cli'),
      threadId: text
    }),
  };
  if (typeof object.kind !== 'string' || !Object.hasOwn(scopes, object.kind) || !scopes[object.kind]!(object))
    throw new SettingsInputError('设置作用域无效');
  return object as SettingsScope;
}
export function parseSettingsEdit(input: unknown): SettingsEdit {
  const object = settingsObject(input);
  if (!shape({
    scope: () => true,
    section: text,
    revision: text,
    patch: () => true
  })(object))
    throw new SettingsInputError('设置保存参数无效');
  const scope = parseSettingsScope(object.scope);
  const section = String(object.section);
  if (scope.kind === 'agent' && section === 'cards')
    throw new SettingsInputError('消息卡按群聊或私聊分别设置：群用 --group X presentation.cardDisplay，私聊用 --dm presentation.cardDisplay');
  if (scope.kind === 'project' && section === 'presentation' && object.patch && typeof object.patch === 'object' && (Object.hasOwn(object.patch, 'showToolCalls') || Object.hasOwn(object.patch, 'showModel')))
    throw new SettingsInputError('旧工具和模型显示字段只供迁移；请改本群或私聊的 presentation.cardDisplay');
  if (scope.kind === 'project' && section === 'presentation' && object.patch && typeof object.patch === 'object' && Object.hasOwn(object.patch, 'completionTemplate')) {
    const template = (object.patch as Record<string, unknown>).completionTemplate;
    const checked = completionTemplateSchema.nullable().safeParse(template);
    if (!checked.success) throw new SettingsInputError(checked.error.issues.map(issue => issue.message).join('；'));
  }
  if (scope.kind === 'project' && section === 'permission' && object.patch && typeof object.patch === 'object' && Object.hasOwn(object.patch, 'network'))
    throw new SettingsInputError('联网已经并进权限的档位：只读不联网，工作区可写联网，完全访问不限制。只读又要联网这类组合，用高级设置 permission.custom。');
  const rule = schemas[scope.kind]?.[section];
  if (!Object.hasOwn(schemas[scope.kind]!, section) || !rule || !rule(object.patch) || Object.keys(settingsObject(object.patch)).length === 0)
    throw new SettingsInputError('设置字段、类型或范围无效');
  return {
    ...object,
    scope
  } as SettingsEdit;
}
export function parseModelQuery(input: unknown): ModelQuery {
  if (!shape({
    botId: identifier('cli'),
    backend: text,
    purpose: one('project', 'session', 'comments', 'titles', 'judge'),
    refresh: value => value === undefined || bool(value),
    threadId: value => value === undefined || text(value)
  }, true)(input) || !['botId', 'backend', 'purpose'].every(key => Object.hasOwn(input as object, key)))
    throw new SettingsInputError('模型查询无效');
  if ((input as ModelQuery).threadId && (input as ModelQuery).purpose !== 'session')
    throw new SettingsInputError('只有会话模型查询可指定会话');
  return input as ModelQuery;
}
export function parseSettingsAction(input: unknown): SettingsAction {
  const object = settingsObject(input);
  const common = {
    kind: text,
    botId: identifier('cli')
  };
  const revision = text;
  const membership = one('present', 'absent');
  const rules: Record<string, Rule> = {
    voice: shape({
      ...common,
      action: shape({
        action: one('enable', 'disable', 'test', 'refreshPermission')
      })
    }),
    adminMember: shape({
      ...common,
      openId: identifier('ou'),
      membership,
      revision
    }),
    projectMember: shape({
      ...common,
      projectName: text,
      openId: identifier('ou'),
      membership,
      revision
    }),
    projectAudience: shape({
      ...common,
      projectName: text,
      audience: one('all'),
      revision
    }),
    commentInstructions: shape({
      ...common,
      revision,
      content: value => shape({
        kind: one('default')
      })(value) || shape({
        kind: one('custom'),
        text: v => typeof v === 'string' && v.trim().length > 0 && v.length <= 30000
      })(value)
    }),
  };
  if (typeof object.kind !== 'string' || !Object.hasOwn(rules, object.kind) || !rules[object.kind]!(object))
    throw new SettingsInputError('设置操作参数无效');
  return object as SettingsAction;
}
