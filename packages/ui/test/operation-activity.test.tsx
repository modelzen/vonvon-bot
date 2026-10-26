import {afterEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {OperationActivity} from '../src/management/OperationActivity';

const harness = vi.hoisted(() => ({visible: false, effect: undefined as undefined | (() => void | (() => void))}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: () => [harness.visible, (next: boolean) => {harness.visible = next;}],
  useEffect: (effect: () => void | (() => void)) => {harness.effect = effect;},
}));
afterEach(() => {vi.useRealTimers(); harness.visible = false; harness.effect = undefined;});

it('keeps the pending label immediate and waits two seconds before mounting one canvas', async () => {
  vi.useFakeTimers();
  const render = () => renderToStaticMarkup(<OperationActivity label="启用中" state="connecting"/>);
  expect(render()).toContain('启用中');
  expect(render()).not.toContain('<canvas');
  const cleanup = harness.effect?.();
  await vi.advanceTimersByTimeAsync(1999);
  expect(render()).not.toContain('<canvas');
  await vi.advanceTimersByTimeAsync(1);
  expect(render().match(/<canvas/g)).toHaveLength(1);
  cleanup?.();
});

it('cancels the delayed canvas when the pending operation finishes quickly', async () => {
  vi.useFakeTimers();
  renderToStaticMarkup(<OperationActivity label="停用中"/>);
  const cleanup = harness.effect?.();
  await vi.advanceTimersByTimeAsync(1000);
  cleanup?.();
  await vi.advanceTimersByTimeAsync(2000);
  expect(harness.visible).toBe(false);
});
