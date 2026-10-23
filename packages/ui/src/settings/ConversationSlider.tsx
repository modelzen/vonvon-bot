import {useEffect, useId, useRef, useState, type CSSProperties} from 'react';
import {Tooltip} from '@base-ui/react/tooltip';
import type {Conversation} from '@vonvon/protocol';
import './conversation-slider.css';

const modes: readonly {value: Conversation; label: string; description: string}[] = [
  {value: 'threads', label: '独立话题', description: '主区 @ Bot 开启新话题，每个话题独立交谈、各自记住上下文。'},
  {value: 'shared', label: '连续交谈', description: '全群接着聊，共用一段对话和上下文。'},
  {value: 'smart', label: '智能', description: '根据判断规则，自己决定何时接话、何时另开话题。'},
];
const rangeKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function ConversationSlider({label, value, disabled, onChange}: {
  label: string; value: Conversation; disabled?: boolean; onChange: (value: Conversation) => void;
}) {
  const descriptionId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const draft = useRef<number | null>(null);
  const interaction = useRef<'pointer' | 'keyboard' | null>(null);
  const current = modes.findIndex(mode => mode.value === value);
  const selected = disabled ? current : preview ?? current;
  const mode = modes[selected]!;
  function reset() {interaction.current = null; draft.current = null; setPreview(null);}
  function commit(index: number | null) {
    reset();
    const next = index === null ? undefined : modes[index];
    if (!disabled && next && next.value !== value) onChange(next.value);
  }
  // A stopped Bot or a refreshed setting cancels an in-progress gesture.
  useEffect(reset, [value, disabled]);
  return <Tooltip.Provider delay={250}>
    <div className="conversation-slider" data-disabled={disabled || undefined}>
      <div className="conversation-slider-rail" style={{'--conversation-position': `${selected * 50}%`} as CSSProperties}>
        <div className="conversation-slider-track" aria-hidden="true"><span/>{modes.map((item, index) => <i key={item.value} style={{left: `${index * 50}%`}}/>)}</div>
        <input type="range" min={0} max={2} step={1} value={selected} disabled={disabled} aria-label={label}
          aria-valuetext={mode.label} aria-describedby={descriptionId}
          onPointerDown={event => {if (disabled || event.button !== 0) return; interaction.current = 'pointer'; event.currentTarget.setPointerCapture(event.pointerId);}}
          onChange={event => {
            if (disabled) return;
            const next = Number(event.currentTarget.value);
            draft.current = next; setPreview(next);
            if (!interaction.current) commit(next);
          }}
          onPointerUp={() => {if (interaction.current === 'pointer') commit(draft.current);}}
          onPointerCancel={reset}
          onLostPointerCapture={() => {if (interaction.current === 'pointer') reset();}}
          onKeyDown={event => {
            if (event.key === 'Escape') {event.preventDefault(); reset();}
            else if (rangeKeys.has(event.key)) interaction.current = 'keyboard';
          }}
          onKeyUp={event => {if (rangeKeys.has(event.key) && interaction.current === 'keyboard') commit(draft.current);}}
          onBlur={() => {if (interaction.current === 'keyboard') commit(draft.current); else reset();}}/>
      </div>
      <div className="conversation-slider-labels">
        {modes.map((item, index) => <Tooltip.Root key={item.value}>
          <Tooltip.Trigger className="conversation-slider-label" aria-pressed={selected === index} aria-disabled={disabled || undefined}
            onClick={() => commit(index)}>{item.label}</Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Positioner side="top" sideOffset={8} collisionPadding={12}>
            <Tooltip.Popup className="conversation-mode-tooltip">{item.description}</Tooltip.Popup>
          </Tooltip.Positioner></Tooltip.Portal>
        </Tooltip.Root>)}
      </div>
      <p id={descriptionId} className="group-control-note conversation-slider-description">{mode.description}</p>
    </div>
  </Tooltip.Provider>;
}
