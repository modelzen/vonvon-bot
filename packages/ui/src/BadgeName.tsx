import {useLayoutEffect, useRef} from 'react';

/** Only the ink moves. Measuring the printed line also works for mixed scripts
 * and when a long employee number leaves less room beside the owner's name. */
export function BadgeName({text, active, motion}: {text: string; active: boolean; motion: boolean}) {
  const viewport = useRef<HTMLSpanElement>(null);
  const ink = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const clip = viewport.current;
    const line = ink.current;
    if (!clip || !line || !active) return;
    let animation: Animation | undefined;
    let inView = false;

    function measure() {
      animation?.cancel();
      clip!.scrollLeft = 0;
      const distance = line!.offsetWidth - clip!.clientWidth;
      if (!motion || distance <= 1) return;

      const hold = 1400;
      const duration = hold * 2 + distance * 45;
      const end = 'translateX(-' + distance + 'px)';
      animation = line!.animate([
        {transform: 'translateX(0)', offset: 0},
        {transform: 'translateX(0)', offset: hold / duration},
        {transform: end, offset: 1 - hold / duration},
        {transform: end, offset: 1},
      ], {duration, iterations: Infinity, direction: 'alternate', easing: 'linear'});
      if (!inView) animation.pause();
    }

    const size = new ResizeObserver(measure);
    size.observe(clip);
    size.observe(line);
    const visibility = new IntersectionObserver(([entry]) => {
      inView = Boolean(entry?.isIntersecting);
      if (inView) animation?.play();
      else animation?.pause();
    });
    visibility.observe(clip);
    measure();
    return () => {
      animation?.cancel();
      size.disconnect();
      visibility.disconnect();
    };
  }, [text, active, motion]);

  return <span className="badge-name-viewport" ref={viewport} title={text}>
    <span className="badge-name-ink" ref={ink}>{text}</span>
  </span>;
}
