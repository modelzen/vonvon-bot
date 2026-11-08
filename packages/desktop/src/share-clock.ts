import type { ShareRailBox, ShareTick, ShareTickResult } from './share-contract.js';

export type ShareClock = {
  /** From now on time moves only in `tick`. */
  begin(rail: ShareRailBox): number;
  /** The page has had `ready()` resolve, so its own clock has started. */
  started(): void;
  tick(step: ShareTick): Promise<ShareTickResult>;
};

/**
 * Runs in the share window's main world before the page's scripts. `contextBridge.executeInMainWorld` serializes it,
 * so it closes over nothing and imports nothing.
 *
 * Until `begin` the page's clocks are the real ones. After it, time moves only in `tick`, by exactly its step:
 * requestAnimationFrame callbacks run there with the stepped time, `performance.now()` and event timestamps read it, and
 * every animation on the document timeline (CSS transitions and animations, WAAPI), which the main process froze through
 * CDP, is moved on by the same step. However slow the machine, each frame is then exactly one step of animation time on.
 */
export function installShareClock(): void {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const nativeNow = performance.now.bind(performance);
  const nativeMatch = window.matchMedia.bind(window);
  const stamp = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp')!.get!;
  const queued = new Map<number, FrameRequestCallback>();
  const live = new Map<number, number>();
  const stamps = new WeakMap<Event, number>();
  let stepped = false, started = false, now = 0, seq = 1, wheels = 0;
  let pointer: [number, number] | undefined;
  let marker: HTMLElement | undefined;
  let rail: Element | undefined;

  window.requestAnimationFrame = callback => {
    const id = seq++;
    if (stepped) queued.set(id, callback);
    else live.set(id, nativeRaf(time => {
      live.delete(id);
      if (stepped) queued.set(id, callback);
      else callback(time);
    }));
    return id;
  };
  window.cancelAnimationFrame = id => {
    queued.delete(id);
    const native = live.get(id);
    if (native !== undefined) { live.delete(id); nativeCancel(native); }
  };
  performance.now = () => stepped ? now : nativeNow();
  // An event dispatched between two steps happened at the earlier one.
  Object.defineProperty(Event.prototype, 'timeStamp', {
    configurable: true,
    get(this: Event) {
      if (!stepped) return stamp.call(this);
      let value = stamps.get(this);
      if (value === undefined) { value = now; stamps.set(this, value); }
      return value;
    },
  });
  // The GIF shows the app's hover motion to people who never see this computer, whatever its own settings.
  const forced: Record<string, boolean> = {
    '(any-hover:hover)': true, '(hover:hover)': true,
    '(prefers-reduced-motion:reduce)': false, '(prefers-reduced-motion:no-preference)': true,
  };
  window.matchMedia = query => {
    const matches = forced[query.replace(/\s+/g, '').toLowerCase()];
    if (matches === undefined) return nativeMatch(query);
    const list = {
      matches, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    };
    return list as unknown as MediaQueryList;
  };
  addEventListener('pointermove', event => { pointer = [event.clientX, event.clientY]; }, { capture: true, passive: true });
  addEventListener('wheel', () => { wheels++; }, { capture: true, passive: true });

  /** Waits for `ready`; past the limit, a soft wait goes on without it. */
  async function until(ready: () => boolean, what: string, soft = false): Promise<void> {
    const deadline = nativeNow() + (soft ? 300 : 5000);
    while (!ready()) {
      if (nativeNow() > deadline) { if (soft) return; throw new Error(`share clock: no ${what}`); }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
  function paintMarker(index: number): void {
    const a = index & 1 ? 255 : 0, b = index & 2 ? 255 : 0;
    if (marker) marker.style.background = `rgb(${a},${b},${a})`;
  }
  /** The element the card reported as its badge rail, to read its scroll position after wheel steps. */
  function findRail(box: ShareRailBox): Element | undefined {
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 2;
    for (const start of document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2)) {
      for (let node: Element | null = start; node; node = node.parentElement) {
        const r = node.getBoundingClientRect();
        if (near(r.left, box.x) && near(r.top, box.y) && near(r.width, box.width) && near(r.height, box.height)) return node;
      }
    }
    return undefined;
  }

  const clock: ShareClock = {
    begin(box) {
      rail = findRail(box);
      marker = document.createElement('div');
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;z-index:2147483647;pointer-events:none';
      paintMarker(0);
      document.documentElement.append(marker);
      now = nativeNow();
      stepped = true;
      return now;
    },
    started() { started = true; },
    async tick(step) {
      await until(() => started, 'start');
      const expected = step.pointer;
      if (expected) await until(() => pointer !== undefined && Math.abs(pointer[0] - expected[0]) < 0.6 && Math.abs(pointer[1] - expected[1]) < 0.6, 'pointer move');
      if (step.wheels !== undefined) await until(() => wheels >= step.wheels!, 'wheel');
      // Snapping could leave the rail elsewhere; then the frame shows where it is.
      if (step.scroll !== undefined && rail) await until(() => Math.abs(rail!.scrollLeft - step.scroll!) < 0.5, 'scroll', true);
      // The animations running before this step move on by it; those its callbacks start begin at the step's time.
      for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running' || animation.timeline !== document.timeline || animation.currentTime === null) continue;
        animation.currentTime = Number(animation.currentTime) + step.dt * animation.playbackRate;
      }
      now += step.dt;
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) {
        try { callback(now); }
        catch (error) { setTimeout(() => { throw error; }); }
      }
      if (step.marker !== undefined) paintMarker(step.marker);
      return rail ? { scrollLeft: rail.scrollLeft } : {};
    },
  };
  Object.defineProperty(window, '__vonvonShareClock', { value: clock });
}
