import {useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {Tooltip} from '@base-ui/react/tooltip';
import {Liquid} from 'liquid-gooey';
import type {Conversation} from '@vonvon/protocol';
import './conversation-slider.css';

export const communicationModes: readonly {value: Conversation; label: string; description: string}[] = [
  {value: 'threads', label: '独立话题', description: '主区 @ Bot 开启新话题，每个话题独立交谈、各自记住上下文。'},
  {value: 'shared', label: '连续交谈', description: '全群接着聊，共用一段对话和上下文。'},
  {value: 'smart', label: '智能', description: '根据判断规则，自己决定何时接话、何时另开话题。'},
];
const rangeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const thumbSize = 28;
const move = {stretch: 0.6, trail: 0.35};

/** Keep the real range in charge of focus and keyboard semantics. */
function ConversationThumb({position, moving, dragging}: {position: number; moving: boolean; dragging: boolean}) {
  const root = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [staticOnly, setStaticOnly] = useState(true);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
  const liquid = !staticOnly && moving && width !== null;
  const thumb = <span className="conversation-slider-thumb" data-static={!liquid || undefined} data-moving={liquid && !dragging || undefined}
    style={width === null ? {left: `${position * 50}%`, transform: 'translateX(-50%)'} : {transform: `translateX(${width * position / 2}px)`}}/>;
  return <span ref={root} className="conversation-slider-art" aria-hidden="true">
    {liquid ? <Liquid className="conversation-slider-liquid" fill="var(--conversation-thumb)" blur={6} contrast={18} shadow="0 1px 3px rgba(0,0,0,.10)">
      <Liquid.Item effect="move" move={move}>{thumb}</Liquid.Item>
    </Liquid> : thumb}
  </span>;
}

export function ConversationSlider({label, value, disabled, onChange}: {
  label: string; value: Conversation; disabled?: boolean; onChange: (value: Conversation) => void;
}) {
  const descriptionId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const draft = useRef<number | null>(null);
  const interaction = useRef<'pointer' | 'keyboard' | null>(null);
  const pointer = useRef<number | null>(null);
  const cancelled = useRef(false);
  const animationIntent = useRef<Conversation | null>(null);
  const current = communicationModes.findIndex(mode => mode.value === value);
  const selected = disabled ? current : preview ?? current;
  const mode = communicationModes[selected]!;
  function reset() {interaction.current = null; pointer.current = null; draft.current = null; setPreview(null); setPosition(null); setMoving(false);}
  function cancel() {if (interaction.current === 'pointer') cancelled.current = true; reset();}
  function commit(index: number | null, animate = false) {
    const next = index === null ? undefined : communicationModes[index];
    reset();
    animationIntent.current = animate && next && next.value !== value ? next.value : null;
    setMoving(animate && !disabled);
    if (!disabled && next && next.value !== value) onChange(next.value);
  }
  function follow(event: PointerEvent<HTMLInputElement>) {
    if (!Number.isFinite(event.clientX)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= thumbSize) return;
    const next = Math.max(0, Math.min(2, (event.clientX - rect.left - thumbSize / 2) / (rect.width - thumbSize) * 2));
    draft.current = Math.round(next);
    setPreview(draft.current);
    setPosition(next);
  }
  // A stopped Bot or a refreshed setting cancels an in-progress gesture.
  useEffect(() => {
    const arriving = !disabled && animationIntent.current === value;
    cancel();
    if (arriving) setMoving(true);
    if (animationIntent.current === value) animationIntent.current = null;
  }, [value, disabled]);
  return <Tooltip.Provider delay={250}>
    <div className="conversation-slider" data-disabled={disabled || undefined}>
      <div className="conversation-slider-rail">
        <div className="conversation-slider-track" aria-hidden="true"/>
        <ConversationThumb position={disabled ? current : position ?? selected} moving={moving} dragging={position !== null}/>
        <input type="range" min={0} max={2} step={1} value={selected} disabled={disabled} aria-label={label}
          aria-valuetext={mode.label} aria-describedby={descriptionId}
          onPointerDown={event => {
            if (disabled || event.button !== 0 || event.isPrimary === false || interaction.current === 'pointer') return;
            cancelled.current = false; interaction.current = 'pointer'; pointer.current = event.pointerId;
            setMoving(true); follow(event); event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {if (!disabled && interaction.current === 'pointer' && pointer.current === event.pointerId) follow(event);}}
          onChange={event => {
            if (disabled || cancelled.current) return;
            const next = Number(event.currentTarget.value);
            draft.current = next; setPreview(next);
            if (!interaction.current) commit(next);
          }}
          onPointerUp={event => {
            if (interaction.current === 'pointer' && event && pointer.current !== event.pointerId) return;
            if (interaction.current === 'pointer' && (!event || pointer.current === event.pointerId)) commit(draft.current, true);
            cancelled.current = false;
          }}
          onPointerCancel={event => {
            if (interaction.current === 'pointer' && (!event || pointer.current === event.pointerId)) {reset(); cancelled.current = false;}
          }}
          onLostPointerCapture={event => {
            if (interaction.current === 'pointer' && (!event || pointer.current === event.pointerId)) {reset(); cancelled.current = false;}
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {event.preventDefault(); cancel();}
            else if (rangeKeys.has(event.key)) {cancelled.current = false; interaction.current = 'keyboard'; setPosition(null); setMoving(false);}
          }}
          onKeyUp={event => {if (rangeKeys.has(event.key) && interaction.current === 'keyboard') commit(draft.current);}}
          onBlur={() => {if (interaction.current === 'keyboard') commit(draft.current); else reset();}}/>
      </div>
      <div className="conversation-slider-labels">
        {communicationModes.map((item, index) => <Tooltip.Root key={item.value}>
          <Tooltip.Trigger className="conversation-slider-label" aria-pressed={selected === index} aria-disabled={disabled || undefined}
            onClick={event => commit(index, event.detail > 0)}>{item.label}</Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Positioner side="top" sideOffset={8} collisionPadding={12}>
            <Tooltip.Popup className="conversation-mode-tooltip">{item.description}</Tooltip.Popup>
          </Tooltip.Positioner></Tooltip.Portal>
        </Tooltip.Root>)}
      </div>
      <p id={descriptionId} className="group-control-note conversation-slider-description">{mode.description}</p>
    </div>
  </Tooltip.Provider>;
}
