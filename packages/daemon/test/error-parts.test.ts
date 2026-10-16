import { expect, it } from 'vitest';
import { errorParts, formatErrorTree, markLogged, wasLogged, type ExpandedErrors } from '../src/core/error-parts';

const tree = () => new AggregateError([
  new Error('first'),
  new AggregateError([new TypeError('second'), 'plain text'], 'inner group'),
], 'Host shutdown failed.');

it('numbers the leaves of nested groups and names the groups between', () => {
  const { parts, total, truncated } = errorParts(tree());
  expect(parts.map(part => [part.path, part.within, part.name, part.message])).toEqual([
    ['1', [], 'Error', 'first'],
    ['2.1', ['inner group'], 'TypeError', 'second'],
    ['2.2', ['inner group'], 'string', 'plain text'],
  ]);
  expect(parts[0]?.stack).toContain('Error: first');
  expect(parts[2]?.stack).toBeUndefined();
  expect({ total, truncated }).toEqual({ total: 3, truncated: false });
});

it('opens an error whose cause is a group, not one whose cause is a plain error', () => {
  const caused = new Error('Codex 子进程树已退出，但清理失败', { cause: new AggregateError([new Error('kill failed')], 'Codex cleanup errors') });
  expect(errorParts(caused).parts.map(part => [part.path, part.within, part.message])).toEqual([['1', ['Codex cleanup errors'], 'kill failed']]);
  const nested = errorParts(new AggregateError([caused], 'Provider cleanup failed.'));
  expect(nested.parts[0]).toMatchObject({ path: '1.1', within: ['Codex 子进程树已退出，但清理失败', 'Codex cleanup errors'], message: 'kill failed' });
  expect(errorParts(new Error('fetch failed', { cause: new Error('ECONNRESET') }))).toEqual({ parts: [], total: 0, truncated: false });
  expect(errorParts('not an error')).toEqual({ parts: [], total: 0, truncated: false });
});

it('keeps 20 leaves, counts the rest, and survives cycles, hostile getters and deep trees', () => {
  const many = errorParts(new AggregateError(Array.from({ length: 25 }, (_, index) => new Error(`e${index}`)), 'many'));
  expect(many.parts).toHaveLength(20);
  expect(many.total).toBe(25);
  const cyclic = new AggregateError([new Error('ok')], 'cyclic');
  cyclic.errors.push(cyclic);
  expect(errorParts(cyclic).parts.map(part => part.message)).toEqual(['ok', '(循环引用)']);
  const hostile = new Error('x');
  Object.defineProperty(hostile, 'message', { get() { throw new Error('no'); } });
  expect(errorParts(new AggregateError([hostile, Object.create(null)], 'g')).parts.map(part => part.message)).toEqual(['(unprintable)', '(unprintable)']);
  let deep: unknown = new Error('bottom');
  for (let level = 0; level < 12; level++) deep = new AggregateError([deep], `level ${level}`);
  const deepParts = errorParts(deep);
  expect(deepParts.parts).toHaveLength(1);
  expect(deepParts.parts[0]).toMatchObject({ name: 'AggregateError', path: '1.1.1.1.1.1.1.1' });
  const wide = errorParts(new AggregateError(Array.from({ length: 300 }, () => new AggregateError([new Error('a')], 'pair')), 'wide'));
  expect(wide.truncated).toBe(true);
  expect(wide.parts).toHaveLength(20);
});

it('marks a group already split as a repeat, and a root split before with its time', () => {
  const seen: ExpandedErrors = new WeakMap();
  const inner = new AggregateError([new Error('drain failed')], 'API listener closed with cleanup errors');
  expect(errorParts(inner, seen, 'T1').total).toBe(1);
  expect(errorParts(inner, seen, 'T2')).toEqual({ parts: [], total: 0, truncated: false, partsAt: 'T1' });
  const outer = errorParts(new AggregateError([inner, new Error('other')], 'Supervisor cleanup failed.'), seen, 'T3');
  expect(outer.parts.map(part => [part.path, part.message, part.repeat, part.partsAt])).toEqual([
    ['1', 'API listener closed with cleanup errors', true, 'T1'],
    ['2', 'other', undefined, undefined],
  ]);
});

it('prints the message alone for a plain error, then one line per leaf', () => {
  expect(formatErrorTree(new Error('reported failure'))).toBe('reported failure');
  expect(formatErrorTree('plain')).toBe('plain');
  expect(formatErrorTree(new AggregateError([new Error('line one\nline two'), new AggregateError([new Error('b')], 'Provider cleanup failed.')], 'Host shutdown failed.'))).toBe([
    'Host shutdown failed.',
    '  - Error: line one; line two',
    '  - Provider cleanup failed. › Error: b',
  ].join('\n'));
  expect(formatErrorTree(new AggregateError(Array.from({ length: 22 }, () => new Error('x')), 'many')).split('\n').at(-1)).toBe('  - 还有 2 条没列出');
  expect(formatErrorTree(new AggregateError([new Error('y'.repeat(800))], 'long')).split('\n')[1]).toHaveLength(501);
});

it('knows an error log.fail wrote, and a cleanup group whose errors it wrote one by one', () => {
  const a = new Error('a');
  const b = new Error('b');
  expect(wasLogged(a)).toBe(false);
  markLogged(a);
  expect(wasLogged(a)).toBe(true);
  expect(wasLogged(new AggregateError([a, b], 'Supervisor cleanup failed.'))).toBe(false);
  markLogged(b);
  expect(wasLogged(new AggregateError([a, b], 'Supervisor cleanup failed.'))).toBe(true);
  expect(wasLogged(new AggregateError([], 'empty'))).toBe(false);
  expect(wasLogged('text')).toBe(false);
});
