// @vitest-environment jsdom
import {act, useRef, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MotionConfig} from 'motion/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Dialog} from '../src/reference/components/ui/Dialog';

let root: Root;
function Dialogs({reduced}: {reduced: boolean}) {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
    <button onClick={() => setOuter(true)}>打开外层</button>
    <Dialog open={outer} title="外层" onClose={() => setOuter(false)}>
      <input aria-label="外层输入"/>
      <button onClick={() => setInner(true)}>打开内层</button>
    </Dialog>
    <Dialog open={inner} title="内层" initialFocusRef={first} onClose={() => setInner(false)}>
      <input aria-label="内层输入" ref={first}/>
      <button onClick={() => setInner(false)}>关闭内层</button>
    </Dialog>
  </MotionConfig>;
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!;
async function click(text: string) {await act(async () => {button(text).focus(); button(text).click();});}
async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...options})));
}
async function settle() {await act(async () => {await new Promise(resolve => setTimeout(resolve, 450));});}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it.each([false, true])('keeps Escape, focus, Tab and inert within the top portal with reduced motion %s', async reduced => {
  await act(async () => root.render(<Dialogs reduced={reduced}/>));
  await click('打开外层'); await click('打开内层'); await settle();
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  expect(dialogs).toHaveLength(2);
  expect(dialogs[0]!.parentElement!.hasAttribute('inert')).toBe(true);
  const input = document.querySelector<HTMLInputElement>('[aria-label="内层输入"]')!;
  expect(document.activeElement).toBe(input);
  button('关闭内层').focus(); await key('Tab'); expect(document.activeElement).toBe(dialogs[1]!.querySelector('button'));
  await key('Tab', {shiftKey: true}); expect(document.activeElement).toBe(button('关闭内层'));
  await key('Escape', {isComposing: true}); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await key('Escape'); await settle();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('#root')!.hasAttribute('inert')).toBe(true);
  expect(dialogs[0]!.parentElement!.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(button('打开内层'));
  await key('Escape'); await settle();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  expect(document.querySelector('#root')!.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('#root')!.hasAttribute('aria-hidden')).toBe(false);
  expect(document.activeElement).toBe(button('打开外层'));
});

it('preserves the background attributes it did not own when the last portal closes', async () => {
  const background = document.querySelector('#root')!;
  background.setAttribute('inert', ''); background.setAttribute('aria-hidden', 'false');
  await act(async () => root.render(<Dialogs reduced/>));
  await click('打开外层'); await key('Escape'); await settle();
  expect(background.hasAttribute('inert')).toBe(true);
  expect(background.getAttribute('aria-hidden')).toBe('false');
});
