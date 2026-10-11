type Json = null | boolean | number | string | readonly Json[] | JsonObject;
type JsonObject = { readonly [key: string]: Json };
type Agent = 'claude' | 'codex';
type NodeCommand = { readonly node: string; readonly script: string };
type HookLocation = { readonly event: string; readonly groupIndex: number; readonly hookIndex: number };
type JsonPath = readonly (string | number)[];

export type HookConversionOptions = {
  readonly platform: 'posix' | 'win32';
  readonly legacyNodeCommands: readonly NodeCommand[];
  readonly target: NodeCommand;
};

export type HookConversionResult =
  | { readonly kind: 'unchanged'; readonly value: JsonObject; readonly rewrittenCount: 0 }
  | { readonly kind: 'converted'; readonly value: JsonObject; readonly rewrittenCount: number }
  | { readonly kind: 'refused'; readonly reason: 'invalid-json-shape' | 'invalid-command-path'; readonly path: JsonPath }
  | { readonly kind: 'refused'; readonly reason: 'ambiguous-legacy-command'; readonly location: HookLocation };

type CommandMeaning =
  | { readonly kind: 'unrelated' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'legacy-hook'; readonly agent: Agent; readonly bot: string | null };

type Replacement = { readonly location: HookLocation; readonly command: string };

const botPattern = '[A-Za-z0-9_-]{1,128}';
const tailPattern = new RegExp(`^(?:[ \t]+--bot[ \t]+(?:(${botPattern})|"(${botPattern})"|'(${botPattern})'))?[ \t]+--agent[ \t]+(claude|codex)$`);

export function convertBridgeHooks(parsedJson: unknown, options: HookConversionOptions): HookConversionResult {
  const jsonError = invalidJsonPath(parsedJson);
  if (jsonError) return { kind: 'refused', reason: 'invalid-json-shape', path: jsonError };
  if (!isJsonObject(parsedJson)) return { kind: 'refused', reason: 'invalid-json-shape', path: [] };
  const shapeError = invalidHookPath(parsedJson);
  if (shapeError) return { kind: 'refused', reason: 'invalid-json-shape', path: shapeError };

  for (const [index, pair] of options.legacyNodeCommands.entries()) {
    if (!validPair(pair, options.platform)) {
      return { kind: 'refused', reason: 'invalid-command-path', path: ['legacyNodeCommands', index] };
    }
  }
  if (!validPair(options.target, options.platform)) {
    return { kind: 'refused', reason: 'invalid-command-path', path: ['target'] };
  }

  const bases = new Set(['feishu-codex-bridge', ...options.legacyNodeCommands.map(renderPair)]);
  const replacements: Replacement[] = [];
  const hooks = parsedJson.hooks;
  if (isJsonObject(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const [groupIndex, group] of groups.entries()) {
        if (!isJsonObject(group) || !Array.isArray(group.hooks)) continue;
        for (const [hookIndex, hook] of group.hooks.entries()) {
          if (!isJsonObject(hook) || typeof hook.command !== 'string' || (hook.type !== undefined && hook.type !== 'command')) continue;
          const meaning = classifyCommand(hook.command, bases, options.platform);
          const location = { event, groupIndex, hookIndex };
          if (meaning.kind === 'ambiguous') return { kind: 'refused', reason: 'ambiguous-legacy-command', location };
          if (meaning.kind === 'legacy-hook') {
            const command = buildTargetCommand(options.target, meaning);
            if (command !== hook.command) replacements.push({ location, command });
          }
        }
      }
    }
  }
  if (replacements.length === 0) return { kind: 'unchanged', value: parsedJson, rewrittenCount: 0 };

  const result: JsonObject = {
    ...parsedJson,
    hooks: Object.fromEntries(Object.entries(hooks ?? {}).map(([event, groups]) => [
      event,
      Array.isArray(groups) ? groups.map((group, groupIndex) => {
        if (!isJsonObject(group) || !Array.isArray(group.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.map((hook, hookIndex) => {
            const command = replacements.find(({ location }) => location.event === event
              && location.groupIndex === groupIndex && location.hookIndex === hookIndex)?.command;
            return command !== undefined && isJsonObject(hook) ? { ...hook, command } : hook;
          }),
        };
      }) : groups,
    ])),
  };
  return { kind: 'converted', value: result, rewrittenCount: replacements.length };
}

function classifyCommand(command: string, bases: ReadonlySet<string>, platform: HookConversionOptions['platform']): CommandMeaning {
  if (command.includes('agent2lark-hook')) return { kind: 'unrelated' };
  const trimmed = command.replace(/^[ \t]+|[ \t]+$/g, '');
  for (const base of bases) {
    if (!trimmed.startsWith(base)) continue;
    const afterBase = trimmed.slice(base.length);
    if (!/^[ \t]+hook(?=$|[ \t])/.test(afterBase)) continue;
    const tail = afterBase.replace(/^[ \t]+hook/, '');
    const match = tailPattern.exec(tail);
    if (!match || (platform === 'win32' && match[3] !== undefined)) return { kind: 'ambiguous' };
    const agent = match[4];
    if (agent !== 'claude' && agent !== 'codex') return { kind: 'ambiguous' };
    return { kind: 'legacy-hook', agent, bot: match[1] ?? match[2] ?? match[3] ?? null };
  }
  return { kind: 'unrelated' };
}

function buildTargetCommand(target: NodeCommand, meaning: Extract<CommandMeaning, { kind: 'legacy-hook' }>): string {
  return `${renderPair(target)} hook${meaning.bot === null ? '' : ` --bot ${meaning.bot}`} --agent ${meaning.agent}`;
}

function renderPair(pair: NodeCommand): string {
  return `"${pair.node}" "${pair.script}"`;
}

function validPair(pair: NodeCommand, platform: HookConversionOptions['platform']): boolean {
  return validPath(pair.node, platform) && validPath(pair.script, platform);
}

function validPath(path: string, platform: HookConversionOptions['platform']): boolean {
  if (typeof path !== 'string') return false;
  if (platform === 'posix') return path.startsWith('/') && !/[\x00-\x1f\x7f"\\$`]/.test(path);
  return (/^[A-Za-z]:\\[^\\]/.test(path) || /^\\\\[^\\]+\\[^\\]+\\/.test(path))
    && !/[\x00-\x1f\x7f"%!?&|<>^()]/.test(path);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function invalidJsonPath(value: unknown, path: JsonPath = [], active = new WeakSet<object>()): JsonPath | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (typeof value !== 'object') return path;
  if (active.has(value)) return path;
  if (!Array.isArray(value) && !isJsonObject(value)) return path;
  active.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return [...path, index];
      const error = invalidJsonPath(value[index], [...path, index], active);
      if (error) return error;
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      const error = invalidJsonPath(item, [...path, key], active);
      if (error) return error;
    }
  }
  active.delete(value);
  return null;
}

function invalidHookPath(root: JsonObject): JsonPath | null {
  const hooks = root.hooks;
  if (hooks === undefined) return null;
  if (!isJsonObject(hooks)) return ['hooks'];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return ['hooks', event];
    for (const [groupIndex, group] of groups.entries()) {
      const groupPath = ['hooks', event, groupIndex];
      if (!isJsonObject(group)) return groupPath;
      if (group.matcher !== undefined && typeof group.matcher !== 'string') return [...groupPath, 'matcher'];
      if (group.hooks === undefined) continue;
      if (!Array.isArray(group.hooks)) return [...groupPath, 'hooks'];
      for (const [hookIndex, hook] of group.hooks.entries()) {
        const hookPath = [...groupPath, 'hooks', hookIndex];
        if (!isJsonObject(hook)) return hookPath;
        if (hook.command !== undefined && typeof hook.command !== 'string') return [...hookPath, 'command'];
        if (hook.type !== undefined && typeof hook.type !== 'string') return [...hookPath, 'type'];
        if (hook.timeout !== undefined && typeof hook.timeout !== 'number') return [...hookPath, 'timeout'];
      }
    }
  }
  return null;
}
