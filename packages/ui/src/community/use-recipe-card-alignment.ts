import {useLayoutEffect, useRef} from 'react';

/** Keep the action card level with the visible settings card, below its section heading. */
export function useRecipeCardAlignment(selector: string | undefined) {
  const reading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const column = reading.current;
    const layout = column?.parentElement;
    const card = selector && column?.querySelector(selector);
    if (!column || !layout || !card) return;
    const align = () => {
      const offset = card.getBoundingClientRect().top - column.getBoundingClientRect().top;
      layout.style.setProperty('--recipe-card-offset', Math.max(0, offset) + 'px');
    };
    align();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(align) : undefined;
    observer?.observe(column);
    return () => {
      observer?.disconnect();
      layout.style.removeProperty('--recipe-card-offset');
    };
  });
  return reading;
}
