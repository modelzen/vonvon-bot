import {useEffect, useRef, useState} from 'react';
import {UserPlus} from 'lucide-react';
import {BorderBeam} from 'border-beam';
import {MetalFx} from 'metal-fx';
// Two package instances keep the comparison palettes independent: metal-fx
// intentionally shares one material between every instance of a module.
import {MetalFx as GoldMetalFx} from 'metal-fx-gold';
import './join-group-action.css';

type Effect = 'line' | 'colorful' | 'ocean' | 'chromatic' | 'gold';
type Props = {disabled?: boolean; onClick: () => void};

export function JoinGroupButtonCandidates(props: Props) {
  const candidates: [Effect, string][] = [['line', '底部彩色内光'], ['colorful', '彩色内光'], ['ocean', '蓝紫内光'], ['chromatic', '流彩金属'], ['gold', '金色金属']];
  return <section className="join-group-candidates" aria-label="入群按钮效果候选">
    <div className="join-group-candidates__hint">移入按钮，预览动效</div>
    <div className="join-group-candidates__list">
      {candidates.map(([effect, label], index) => <div className="join-group-candidates__item" key={effect}>
        <span className="join-group-candidates__label">{index + 1} · {label}</span>
        <JoinGroupButton {...props} effect={effect}/>
      </div>)}
    </div>
  </section>;
}

// Pulse uses an internal animation loop without a pause prop. Retain an actual
// rendered frame, then unmount the live effect until the next hover preview.
// This markup is only our own fixed button and the installed library's layers.
function PulsePreview({moving, disabled, palette}: {moving: boolean; disabled: boolean; palette: 'colorful' | 'ocean'}) {
  const live = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState('');
  useEffect(() => {
    if (moving || disabled) return;
    const timer = setTimeout(() => {
      if (live.current) setFrame(live.current.innerHTML);
    }, 80);
    return () => clearTimeout(timer);
  }, [moving, disabled]);
  if (frame && !moving && !disabled) return <span className="join-group-action__still" dangerouslySetInnerHTML={{__html: frame}}/>;
  return <span ref={live}>
    <BorderBeam size="pulse-inner" colorVariant={palette} theme="light" strength={1} active={!disabled} staticColors={palette === 'ocean'}
      className="join-group-action__beam" data-moving={moving || undefined}>
      <ButtonArtwork/>
    </BorderBeam>
  </span>;
}

function ButtonArtwork() {
  return <span className="join-group-action__button">
    <UserPlus size={16} aria-hidden="true"/><span>拉 Bot 入群</span>
  </span>;
}

// A quiet, persistent highlight. Only a deliberate pointer entry sets the official
// Line effect in motion; it stops after one short pass and cannot repeatedly pulse.
export function JoinGroupButton({disabled = false, onClick, effect = 'line'}: Props & {effect?: Effect}) {
  const [moving, setMoving] = useState(false);
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
    if (disabled || document.hidden || !matchMedia('(hover: hover) and (pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches || Date.now() - lastPlayed.current < 8000) return;
    lastPlayed.current = Date.now();
    setMoving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoving(false), 2000);
  }
  const Metal = effect === 'gold' ? GoldMetalFx : MetalFx;
  return <span className="join-group-action" data-disabled={disabled || undefined}
    onClick={() => {if (!disabled) onClick();}}
    onPointerEnter={event => {if (event.pointerType === 'mouse') play();}} onPointerLeave={stop}>
    <span className="join-group-action__art" aria-hidden="true">
    {effect === 'line' ? <BorderBeam size="line" colorVariant="colorful" theme="light" strength={1} active={!disabled}
      className="join-group-action__beam" data-moving={moving || undefined}>
      <ButtonArtwork/>
    </BorderBeam> : effect === 'colorful' || effect === 'ocean'
      ? <PulsePreview moving={moving} disabled={disabled} palette={effect}/>
      : <Metal variant="button" preset={effect} theme="light" strength={1} innerShadow paused={!moving} className="join-group-action__metal">
        <ButtonArtwork/>
      </Metal>}
    </span>
    <button className="join-group-action__button join-group-action__control" type="button" disabled={disabled}>
      <UserPlus size={16} aria-hidden="true"/><span>拉 Bot 入群</span>
    </button>
  </span>;
}
