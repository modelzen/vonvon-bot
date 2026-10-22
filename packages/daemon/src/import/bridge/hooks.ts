/** Only known standalone entrypoints. Never match a substring, chained shell command, or another hook product. */
export function classifyHookCommand(command: string): 'bridge' | 'vonvon-legacy' | 'other' {
  const text = command.trim();
  if (text.includes('agent2lark-hook') || /[\n\r;&|`<>]/.test(text)) return 'other';
  if (/^(?:feishu-codex-bridge|"[^"\n]+"\s+"[^"\n]*\/feishu-codex-bridge\.mjs")\s+hook(?:\s|$)/.test(text)) return 'bridge';
  if (/^"[^"\n]+"\s+"[^"\n]*\/bin\/vonvon\.mjs"\s+hook(?:\s|$)/.test(text)) return 'vonvon-legacy';
  return 'other';
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Shape errors fail closed; preserve every unrelated JSON value. */
export function removeBridgeHooks(bytes: Buffer): {changed: boolean; bytes: Buffer} {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (!record(value) || (value.hooks !== undefined && !record(value.hooks))) throw new Error('Invalid hook settings');
  if (!value.hooks) return {changed: false, bytes};
  let changed = false;
  for (const [event, input] of Object.entries(value.hooks as Record<string, unknown>)) {
    if (!Array.isArray(input)) throw new Error('Invalid hook groups');
    const groups: unknown[] = [];
    for (const group of input) {
      if (!record(group) || !Array.isArray(group.hooks)) throw new Error('Invalid hook group');
      const hooks: unknown[] = [];
      for (const hook of group.hooks) {
        if (!record(hook) || (hook.type !== undefined && typeof hook.type !== 'string') || (hook.command !== undefined && typeof hook.command !== 'string')) throw new Error('Invalid hook command');
        if ((hook.type === undefined || hook.type === 'command') && typeof hook.command === 'string' && classifyHookCommand(hook.command) !== 'other') changed = true;
        else hooks.push(hook);
      }
      if (hooks.length || group.hooks.length === 0) groups.push({...group, hooks});
    }
    if (groups.length || input.length === 0) (value.hooks as Record<string, unknown>)[event] = groups;
    else delete (value.hooks as Record<string, unknown>)[event];
  }
  return {changed, bytes: changed ? Buffer.from(`${JSON.stringify(value, null, 2)}\n`) : bytes};
}
