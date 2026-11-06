import {useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent} from 'react';
import {Tooltip} from '@base-ui/react/tooltip';
import type {Conversation} from '@vonvon/protocol';
import './conversation-slider.css';

type ConversationMode = {value: Conversation; label: string; description: string};
export const communicationModes: readonly ConversationMode[] = [
  {value: 'threads', label: '独立话题', description: '主区 @ Bot 开启新话题，每个话题独立交谈、各自记住上下文。'},
  {value: 'shared', label: '连续交谈', description: '全群接着聊，共用一段对话和上下文。'},
  {value: 'smart', label: '智能', description: '根据判断规则，自己决定何时接话、何时另开话题。'},
];
/** A private chat has one person in it: no topics to open, and 智能 means something else. */
export const dmConversationModes: readonly ConversationMode[] = [
  {value: 'shared', label: '连续交谈', description: '每条都回，共用一段对话和上下文。'},
  {value: 'smart', label: '智能', description: '每条都看，只回需要回的。收尾的话留个表情。'},
];
const rangeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const thumbSize = 18;

/** Keep the real range in charge of focus and keyboard semantics. */
function ConversationThumb({position, steps, moving, dragging}: {position: number; steps: number; moving: boolean; dragging: boolean}) {
  const root = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <span ref={root} className="conversation-slider-art" aria-hidden="true">
    <span className="conversation-slider-thumb" data-moving={moving && !dragging || undefined}
      style={width === null ? {left: `${position * 100 / steps}%`, transform: 'translateX(-50%)'} : {transform: `translateX(${width * position / steps}px)`}}/>
  </span>;
}

export function ConversationSlider({label, value, disabled, pending, onChange, modes = communicationModes}: {
  label: string; value: Conversation; disabled?: boolean; pending?: boolean; onChange: (value: Conversation) => void; modes?: readonly ConversationMode[];
}) {
  const steps = modes.length - 1;
  const descriptionId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const draft = useRef<number | null>(null);
  const interaction = useRef<'pointer' | 'keyboard' | null>(null);
  const pointer = useRef<number | null>(null);
  const cancelled = useRef(false);
  const animationIntent = useRef<Conversation | null>(null);
  const current = modes.findIndex(mode => mode.value === value);
  const blocked = disabled || pending;
  const selected = disabled ? current : preview ?? current;
  const mode = modes[selected]!;
  function reset() {interaction.current = null; pointer.current = null; draft.current = null; setPreview(null); setPosition(null); setMoving(false);}
  function cancel() {if (interaction.current === 'pointer') cancelled.current = true; reset();}
  function commit(index: number | null, animate = false) {
    const next = index === null ? undefined : modes[index];
    reset();
    animationIntent.current = animate && next && next.value !== value ? next.value : null;
    setMoving(animate && !disabled);
    if (!blocked && next && next.value !== value) onChange(next.value);
  }
  function follow(event: PointerEvent<HTMLInputElement>) {
    if (!Number.isFinite(event.clientX)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= thumbSize) return;
    const next = Math.max(0, Math.min(steps, (event.clientX - rect.left - thumbSize / 2) / (rect.width - thumbSize) * steps));
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
    <div className="conversation-slider" style={{'--conversation-stops': modes.length} as CSSProperties} data-disabled={disabled || undefined} aria-busy={pending || undefined}>
      <div className="conversation-slider-rail">
        <div className="conversation-slider-track" aria-hidden="true">
          <span className="conversation-slider-signal" data-moving={moving && position === null || undefined} style={{transform: `scaleX(${(disabled ? current : position ?? selected) / steps})`}}/>
          {modes.map((item, index) => <i key={item.value} data-active={index <= selected || undefined} style={{left: `${index * 100 / steps}%`}}/>)}
        </div>
        <ConversationThumb position={disabled ? current : position ?? selected} steps={steps} moving={moving} dragging={position !== null}/>
        <input type="range" min={0} max={steps} step={1} value={selected} disabled={disabled} aria-disabled={blocked || undefined} aria-label={label}
          aria-valuetext={mode.label} aria-describedby={descriptionId}
          onPointerDown={event => {
            if (pending) {event.preventDefault(); return;}
            if (disabled || event.button !== 0 || event.isPrimary === false || interaction.current === 'pointer') return;
            cancelled.current = false; interaction.current = 'pointer'; pointer.current = event.pointerId;
            setMoving(true); follow(event); event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {if (!blocked && interaction.current === 'pointer' && pointer.current === event.pointerId) follow(event);}}
          onChange={event => {
            if (blocked || cancelled.current) return;
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
            if (pending) {if (rangeKeys.has(event.key)) event.preventDefault(); return;}
            if (event.key === 'Escape') {event.preventDefault(); cancel();}
            else if (rangeKeys.has(event.key)) {cancelled.current = false; interaction.current = 'keyboard'; setPosition(null); setMoving(false);}
          }}
          onKeyUp={event => {if (rangeKeys.has(event.key) && interaction.current === 'keyboard') commit(draft.current);}}
          onBlur={() => {if (interaction.current === 'keyboard') commit(draft.current); else reset();}}/>
      </div>
      <div className="conversation-slider-labels">
        {modes.map((item, index) => <Tooltip.Root key={item.value}>
          <Tooltip.Trigger className="conversation-slider-label" aria-pressed={selected === index} aria-disabled={blocked || undefined}
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
