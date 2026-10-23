import {useId, useRef} from 'react';
import {CornerDownRight, Plus, X} from 'lucide-react';
import './group-design-settings.css';

type Props = {
  label: '个性' | '记忆' | '身份与职责' | '其他说明';
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
  inheritance?: {
    enabled: boolean;
    source: string;
    botName: string;
    onChange: (enabled: boolean) => void;
  };
};

/** A single writing surface. The inherited reference is removable as a whole;
 * editing the local text never edits the Bot's source text. */
export function PersonaEditor({label, value, onChange, disabled = false, maxLength, inheritance}: Props) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const inheritButton = useRef<HTMLButtonElement>(null);
  function removeReference() {
    inheritance?.onChange(false);
    requestAnimationFrame(() => inheritButton.current?.focus());
  }
  return <section className="gd-persona-field" aria-labelledby={`${id}-label`}>
    <div className="gd-field-heading">
      <label id={`${id}-label`} htmlFor={`${id}-text`}>{label}</label>
      {inheritance && !inheritance.enabled && <button type="button" className="gd-text-action" ref={inheritButton} disabled={disabled}
        onClick={() => {inheritance.onChange(true); input.current?.focus();}}><Plus size={13}/>继承 Bot {label}</button>}
    </div>
    <div className="gd-persona-surface" data-disabled={disabled || undefined}>
      {inheritance?.enabled && <div className="gd-inherited" role="group" aria-label={`继承的 Bot ${label}`}>
        <div className="gd-inherited-heading"><span><CornerDownRight size={13}/>{inheritance.botName} · {label}</span>
          <button type="button" className="gd-icon-action" disabled={disabled} aria-label={`移除 Bot ${label}继承`} title="停止本群继承，保留 Bot 原文" onClick={removeReference}><X size={14}/></button>
        </div>
        <p>{inheritance.source || `Bot 尚未填写${label}`}</p>
      </div>}
      <textarea ref={input} id={`${id}-text`} aria-label={`${inheritance ? '本群' : 'Bot '}${label}`} rows={5} value={value} maxLength={maxLength} disabled={disabled}
        placeholder={inheritance?.enabled ? `补充本群${label}…` : `填写${label}…`} onChange={event => onChange(event.target.value)}/>
    </div>
  </section>;
}
