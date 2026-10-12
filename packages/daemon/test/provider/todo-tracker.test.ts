import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../src/provider/model';
import { TodoTracker } from '../../src/provider/runtime/todo-tracker';

describe('TodoTracker', () => {
  it('replaces the whole list, caps it at 50, and caps each text at 80 chars', () => {
    const tracker = new TodoTracker();
    const input: TodoItem[] = Array.from({ length: 51 }, (_, index) => ({
      text: `${index}:` + 'x'.repeat(80), status: 'pending',
    }));
    const result = tracker.replace(input);
    expect(result).toHaveLength(50);
    expect(result?.[0]?.text).toHaveLength(80);
    expect(result?.at(-1)?.text.startsWith('49:')).toBe(true);
    expect(tracker.replace([{ text: 'new', status: 'completed' }]))
      .toEqual([{ text: 'new', status: 'completed' }]);
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.replace(null)).toBeNull();
    expect(tracker.list()).toBeNull();
  });

  it('does not expose mutable input or output state', () => {
    const tracker = new TodoTracker();
    const input: TodoItem[] = [{ text: 'draft', status: 'pending' }];
    const returned = tracker.replace(input);
    const inputItem = input[0];
    if (!inputItem) throw new Error('expected input todo');
    inputItem.text = 'changed input';
    const returnedItem = returned?.[0];
    if (!returnedItem) throw new Error('expected returned todo');
    returnedItem.status = 'completed';
    const listed = tracker.list();
    const listedItem = listed?.[0];
    if (!listedItem) throw new Error('expected listed todo');
    listedItem.text = 'changed output';
    expect(tracker.list()).toEqual([{ text: 'draft', status: 'pending' }]);
  });
});
