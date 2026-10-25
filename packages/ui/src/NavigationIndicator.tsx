import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Liquid, type MoveTuning} from 'liquid-gooey';

type Position = {x: number; y: number; width: number; height: number};
type Highlight = {position: Position; animate: boolean; generation: number};
// Match the accepted preview's effective tuning: it used the public stretch
// value and the library defaults for the trailing droplet and arrival spring.
const move = {springiness: 0.5, wobble: 0.5, stretch: 0.18, trail: 0.575} satisfies MoveTuning;

// Decorative only: the existing navigation buttons keep their handlers, focus,
// current-page semantics and memory counts. Measure them instead of assuming
// equal widths, so counts and narrow windows cannot displace the highlight.
export function NavigationIndicator({activeIndex}: {activeIndex: number | null}) {
  const root = useRef<HTMLSpanElement>(null);
  const previousIndex = useRef<number | null>(null);
  const intent = useRef<{index: number; mouse: boolean} | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [staticOnly, setStaticOnly] = useState(true);

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const forced = matchMedia('(forced-colors: active)');
    const update = () => setStaticOnly(reduced.matches || forced.matches || document.hidden);
    update();
    reduced.addEventListener('change', update);
    forced.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      reduced.removeEventListener('change', update);
      forced.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useLayoutEffect(() => {
    const nav = root.current?.parentElement;
    if (!nav) return;
    let mouse = false;
    const pointer = (event: PointerEvent) => {mouse = event.pointerType === 'mouse';};
    const click = (event: MouseEvent) => {
      const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>(':scope > button'));
      const index = buttons.findIndex(button => button.contains(event.target as Node));
      intent.current = index < 0 ? null : {index, mouse: mouse && event.detail > 0};
    };
    nav.addEventListener('pointerdown', pointer, true);
    nav.addEventListener('click', click, true);
    return () => {
      nav.removeEventListener('pointerdown', pointer, true);
      nav.removeEventListener('click', click, true);
    };
  }, []);

  useLayoutEffect(() => {
    const nav = root.current?.parentElement;
    if (!nav) return;
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>(':scope > button'));
    const selected = activeIndex === null ? undefined : buttons[activeIndex];
    const animate = previousIndex.current !== null && intent.current?.index === activeIndex && intent.current.mouse;
    previousIndex.current = activeIndex;
    intent.current = null;
    if (!selected) {setHighlight(null); return;}
    const measure = (allowMotion: boolean) => {
      const position = {x: selected.offsetLeft, y: selected.offsetTop, width: selected.offsetWidth, height: selected.offsetHeight};
      setHighlight(previous => {
        if (previous && Object.entries(position).every(([key, value]) => previous.position[key as keyof Position] === value)) return previous;
        return {position, animate: Boolean(allowMotion && previous), generation: (previous?.generation ?? 0) + (allowMotion ? 0 : 1)};
      });
    };
    measure(Boolean(animate));
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(nav);
    buttons.forEach(button => observer.observe(button));
    return () => observer.disconnect();
  }, [activeIndex]);

  return <span ref={root} className="today-nav-highlight" aria-hidden="true" data-ready={Boolean(highlight && !staticOnly) || undefined}>
    {highlight && !staticOnly && <Liquid key={highlight.generation} className="today-nav-liquid" fill="var(--color-surface)" blur={4} contrast={18} shadow="0 1px 3px rgba(0,0,0,.1)">
      <Liquid.Item effect="move" move={move}>
        <span className="today-nav-indicator" data-moving={highlight.animate || undefined} style={{
          width: highlight.position.width, height: highlight.position.height,
          transform: `translate(${highlight.position.x}px, ${highlight.position.y}px)`,
        }}/>
      </Liquid.Item>
    </Liquid>}
  </span>;
}
