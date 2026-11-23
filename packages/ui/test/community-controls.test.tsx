// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {GlowButton} from '../src/GlowButton';
import {JoinGroupButton} from '../src/JoinGroupButton';
import {BackButton} from '../src/BackButton';

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('submits a community dialog form from the dark control and respects disabled', async () => {
  const submit = vi.fn();
  const render = (disabled: boolean) => <><form id="acquire" onSubmit={event => {event.preventDefault(); submit();}}/><GlowButton variant="dark" type="submit" form="acquire" disabled={disabled}>获取配方</GlowButton></>;
  await act(async () => root.render(render(false)));
  const button = document.querySelector('button')!;
  expect(button.closest('.glow-button')?.getAttribute('data-variant')).toBe('dark');
  expect(button.textContent).toBe('获取配方');
  await act(async () => button.click());
  expect(submit).toHaveBeenCalledOnce();
  await act(async () => root.render(render(true)));
  await act(async () => button.click());
  expect(submit).toHaveBeenCalledOnce();
});

it('keeps the original invite button light and uses the shared product back action', async () => {
  const invite = vi.fn(); const back = vi.fn();
  await act(async () => root.render(<><JoinGroupButton onClick={invite}/><BackButton label="返回 Bot 配方" onClick={back}/></>));
  const [inviteButton, backButton] = document.querySelectorAll('button');
  expect(inviteButton.closest('.glow-button')?.getAttribute('data-variant')).toBe('light');
  expect(inviteButton.closest('.glow-button')?.getAttribute('data-size')).toBe('md');
  expect(inviteButton.textContent).toBe('拉 Bot 入群');
  expect(backButton.getAttribute('aria-label')).toBe('返回 Bot 配方');
  expect(backButton.textContent).toBe('Bot 配方');
  expect(backButton.querySelector('svg')?.getAttribute('width')).toBe('14');
  await act(async () => {inviteButton.click(); backButton.click();});
  expect(invite).toHaveBeenCalledOnce(); expect(back).toHaveBeenCalledOnce();
});
