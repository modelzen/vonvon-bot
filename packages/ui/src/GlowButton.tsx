import {useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode} from 'react';
import {BorderBeam} from 'border-beam';
import './glow-button.css';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {children: ReactNode; size?: 'sm' | 'md'; variant?: 'light' | 'dark'};
// One complete Line sweep in border-beam 1.4.1. Leaving the button doesn't
// interrupt it; the finished sweep crossfades back to the quiet idle glow.
const SWEEP_MS = 3100;
const COOLDOWN_MS = 8000;

function ButtonArtwork({children}: {children: ReactNode}) {
  return <span className="glow-button__button">
    <span>{children}</span>
  </span>;
}

export function GlowButton({children, size = 'sm', variant = 'light', disabled = false, className, type = 'button', ...props}: Props) {
  const [moving, setMoving] = useState(false);
  const [cycle, setCycle] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPlayed = useRef(-Infinity);
  const stop = () => {clearTimeout(timer.current); setMoving(false);};
  useEffect(() => {
    if (disabled) stop();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const stopWhenHidden = () => {if (document.hidden) stop();};
    const stopWhenReduced = () => {if (reduced.matches) stop();};
    document.addEventListener('visibilitychange', stopWhenHidden);
    reduced.addEventListener('change', stopWhenReduced);
    return () => {clearTimeout(timer.current); document.removeEventListener('visibilitychange', stopWhenHidden); reduced.removeEventListener('change', stopWhenReduced);};
  }, [disabled]);
  function play() {
    if (disabled || document.hidden || !matchMedia('(hover: hover) and (pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches || Date.now() - lastPlayed.current < COOLDOWN_MS) return;
    lastPlayed.current = Date.now();
    setCycle(value => value + 1);
    setMoving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoving(false), SWEEP_MS);
  }
  return <span className="glow-button" data-size={size} data-variant={variant} data-disabled={disabled || undefined} data-moving={moving || undefined}
    onPointerEnter={event => {if (event.pointerType === 'mouse') play();}}>
    <span className="glow-button__art" aria-hidden="true">
      {disabled ? <ButtonArtwork>{children}</ButtonArtwork> : <>
        <span className="glow-button__idle">
          <BorderBeam size="line" colorVariant="colorful" theme={variant} strength={0.8} className="glow-button__beam glow-button__beam--idle">
            <ButtonArtwork>{children}</ButtonArtwork>
          </BorderBeam>
        </span>
        <span className="glow-button__sweep">
          <BorderBeam key={cycle} size="line" colorVariant="colorful" theme={variant} strength={0.8} className="glow-button__beam glow-button__beam--sweep">
            <ButtonArtwork>{children}</ButtonArtwork>
          </BorderBeam>
        </span>
      </>}
    </span>
    <button {...props} className={["glow-button__button glow-button__control", className].filter(Boolean).join(" ")} type={type} disabled={disabled}>
      <span>{children}</span>
    </button>
  </span>;
}
