// s17b: the errors inside an AggregateError, one by one, for the JSON log, stderr and the crash handler.
// No imports: `host/crash-guard.ts` uses this and is bundled into a test child process.

/** One leaf error. `path` numbers it from 1 (`2.1`); `within` holds the messages of the groups between the root and it. */
export type ErrorPart = { path: string; within: string[]; name: string; message: string; stack?: string; repeat?: true; partsAt?: string };
/** `partsAt`: the root's group was already split by the log at that time, so `parts` is empty. */
export type ErrorParts = { parts: ErrorPart[]; total: number; truncated: boolean; partsAt?: string };
/** Each group already split into the log, with the time of that log line. */
export type ExpandedErrors = WeakMap<object, string>;

const MAX_PARTS = 20;
const MAX_NODES = 200;
const MAX_DEPTH = 8;
const MAX_LINE = 500;
const none = (): ErrorParts => ({ parts: [], total: 0, truncated: false });
const read = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
const isObject = (value: unknown): value is object => (typeof value === 'object' && value !== null) || typeof value === 'function';

/** The message `index.ts` printed before s17b: an Error's message, anything else as a string. */
export function messageOf(value: unknown): string {
  return read(() => value instanceof Error ? String(value.message) : String(value), '(unprintable)');
}

/** The group whose `errors` are this value's children: an AggregateError, or an Error whose cause is one. */
function groupOf(value: unknown): { group: AggregateError; viaCause: boolean } | undefined {
  return read(() => {
    if (value instanceof AggregateError) return Array.isArray(value.errors) ? { group: value, viaCause: false } : undefined;
    const cause: unknown = value instanceof Error ? value.cause : undefined;
    return cause instanceof AggregateError && Array.isArray(cause.errors) ? { group: cause, viaCause: true } : undefined;
  }, undefined);
}

function leaf(value: unknown, path: string, within: string[]): ErrorPart {
  const error = read(() => value instanceof Error, false);
  const name = error ? read(() => String((value as Error).name), '(unprintable)') : typeof value;
  const stack = error ? read(() => (value as Error).stack, undefined) : undefined;
  return { path, within, name, message: messageOf(value), ...(typeof stack === 'string' ? { stack } : {}) };
}

/**
 * The leaves of an error tree: the `errors` of an AggregateError, nested ones and an Error whose `cause` is one opened
 * too. Empty for any other error. At most 20 leaves, 200 values and 8 levels; a cycle is a leaf. With `seen`, a group
 * already in it is one `repeat` leaf (or, at the root, `partsAt` and no parts), and each group opened is added at `at`.
 * Never throws.
 */
export function errorParts(error: unknown, seen?: ExpandedErrors, at = ''): ErrorParts {
  try {
    const root = groupOf(error);
    if (!root) return none();
    const children = read(() => root.group.errors.slice(0, MAX_NODES), [] as unknown[]);
    if (children.length === 0) return none();
    const partsAt = seen?.get(root.group);
    if (partsAt !== undefined) return { ...none(), partsAt };
    seen?.set(root.group, at);
    const result = none();
    let nodes = 1;
    const path = new Set<object>([root.group]);
    if (isObject(error)) path.add(error);
    const add = (part: ErrorPart): void => { result.total++; if (result.parts.length < MAX_PARTS) result.parts.push(part); };
    const walk = (values: unknown[], prefix: string, within: string[], depth: number): void => {
      for (let index = 0; index < values.length; index++) {
        if (nodes >= MAX_NODES) { result.truncated = true; return; }
        nodes++;
        const value = values[index];
        const id = `${prefix}${index + 1}`;
        const node = groupOf(value);
        if ((isObject(value) && path.has(value)) || (node && path.has(node.group))) { add({ ...leaf(value, id, within), message: '(循环引用)' }); continue; }
        const inner = node && depth < MAX_DEPTH ? read(() => node.group.errors.slice(0, MAX_NODES), [] as unknown[]) : [];
        if (!node || inner.length === 0) { add(leaf(value, id, within)); continue; }
        const earlier = seen?.get(node.group);
        if (earlier !== undefined) { add({ ...leaf(value, id, within), repeat: true, partsAt: earlier }); continue; }
        seen?.set(node.group, at);
        path.add(node.group);
        if (isObject(value)) path.add(value);
        walk(inner, `${id}.`, [...within, messageOf(value), ...(node.viaCause ? [messageOf(node.group)] : [])], depth + 1);
        path.delete(node.group);
        if (isObject(value)) path.delete(value);
      }
    };
    walk(children, '', root.viaCause ? [messageOf(root.group)] : [], 1);
    return result;
  } catch { return none(); }
}

/** One `  - group › Name: message` line per leaf, for stderr; empty for an error that is not a group. */
export function errorPartLines(error: unknown): string[] {
  const { parts, total, truncated } = errorParts(error);
  const lines = parts.map(part => {
    const line = `  - ${[...part.within, `${part.name}: ${part.message}`].join(' › ').replace(/\r\n|\r|\n/g, '; ')}`;
    return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
  });
  const more = total - parts.length;
  if (more > 0) lines.push(`  - 还有 ${more} 条没列出${truncated ? '，后面可能还有' : ''}`);
  else if (truncated) lines.push('  - 后面可能还有，没列出');
  return lines;
}

/** The message, then one line per leaf of an AggregateError: what `vonvon` prints when a command fails. */
export function formatErrorTree(error: unknown): string {
  return [messageOf(error), ...errorPartLines(error)].join('\n');
}

const logged = new WeakSet<object>();

/** Called by `log.fail` for each error it writes. */
export function markLogged(error: unknown): void {
  if (isObject(error)) logged.add(error);
}

/** `log.fail` already wrote this error, or each error of this group (a cleanup's own AggregateError). */
export function wasLogged(error: unknown): boolean {
  return read(() => isObject(error) && (logged.has(error)
    || (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0 && error.errors.every(item => isObject(item) && logged.has(item)))), false);
}
