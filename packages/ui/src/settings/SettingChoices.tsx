import {useId} from 'react';

/** Small, finite settings stay visible; native radios retain keyboard navigation. */
export function SettingChoices<T extends string>({label, value, choices, disabled = false, onChange, stacked = false}: {
  label: string;
  value: T;
  choices: readonly {value: T; label: string; disabled?: boolean}[];
  disabled?: boolean;
  onChange: (value: T) => void;
  stacked?: boolean;
}) {
  const name = useId();
  return <span className={`setting-choices${stacked ? ' setting-choices--stacked' : ''}`} role="radiogroup" aria-label={label}>
    {choices.map(choice => <label key={choice.value} className="setting-choice">
      <input type="radio" name={name} value={choice.value} checked={value === choice.value} disabled={disabled || choice.disabled}
        onChange={() => {if (!disabled && !choice.disabled) onChange(choice.value);}}/>
      <span>{choice.label}</span>
    </label>)}
  </span>;
}
