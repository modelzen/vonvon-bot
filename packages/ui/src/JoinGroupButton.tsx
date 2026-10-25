import {useEffect, useRef, useState} from 'react';
import {BorderBeam} from 'border-beam';
import './join-group-action.css';

type Props = {disabled?: boolean; onClick: () => void};
// One complete Line sweep in border-beam 1.4.1. Leaving the button doesn't
// interrupt it; the finished sweep crossfades back to the quiet idle glow.
const SWEEP_MS = 3100;
const COOLDOWN_MS = 8000;

function ButtonArtwork() {
  return <span className="join-group-action__button">
    <span>拉 Bot 入群</span>
  </span>;
}

export function JoinGroupButton({disabled = false, onClick}: Props) {
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
  return <span className="join-group-action" data-disabled={disabled || undefined} data-moving={moving || undefined}
    onPointerEnter={event => {if (event.pointerType === 'mouse') play();}}>
    <span className="join-group-action__art" aria-hidden="true">
      {disabled ? <ButtonArtwork/> : <>
        <span className="join-group-action__idle">
          <BorderBeam size="line" colorVariant="colorful" theme="light" strength={0.8} className="join-group-action__beam join-group-action__beam--idle">
            <ButtonArtwork/>
          </BorderBeam>
        </span>
        <span className="join-group-action__sweep">
          <BorderBeam key={cycle} size="line" colorVariant="colorful" theme="light" strength={0.8} className="join-group-action__beam join-group-action__beam--sweep">
            <ButtonArtwork/>
          </BorderBeam>
        </span>
      </>}
    </span>
    <button className="join-group-action__button join-group-action__control" type="button" disabled={disabled} onClick={onClick}>
      <span>拉 Bot 入群</span>
    </button>
  </span>;
}
