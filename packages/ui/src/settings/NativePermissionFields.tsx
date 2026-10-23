import {useEffect, useState} from 'react';
import type {ProjectSettingsView} from '@vonvon/protocol';
import {Toggle} from '../reference/components/ui';
import {SettingsRow} from '../reference/components/system-settings';
import {SettingChoices} from './SettingChoices';

export type NativeField = ProjectSettingsView['sections']['permission']['stored']['options']['fields'][number];
type NativeSettings = Record<string, unknown>;
export function visibleNativeFields(fields: readonly NativeField[], value: NativeSettings): NativeField[] {
  const byKey = new Map(fields.map(field => [field.key, field]));
  function visible(field: NativeField, seen = new Set<string>()): boolean {
    if (seen.has(field.key)) return false;
    if (!field.showWhen) return true;
    const control = byKey.get(field.showWhen.key);
    return Boolean(control && visible(control, new Set([...seen, field.key])) && field.showWhen.in.some(expected => value[field.showWhen!.key] === expected));
  }
  return fields.filter(field => visible(field));
}
export function nativePermissionPatch(fields: readonly NativeField[], value: NativeSettings): NativeSettings {
  return Object.fromEntries(visibleNativeFields(fields, value).filter(field => value[field.key] !== undefined).map(field => [field.key, value[field.key]]));
}
const domainLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
function Domains({label, value, disabled, onChange}: {label: string; value: unknown; disabled: boolean; onChange: (value: string[]) => void}) {
  const saved = Array.isArray(value) ? value as string[] : [];
  const [text, setText] = useState(saved.join('\n'));
  useEffect(() => {if (JSON.stringify(domainLines(text)) !== JSON.stringify(saved)) setText(saved.join('\n'));}, [value]);
  return <textarea className="settings-field" rows={4} aria-label={label} value={text} disabled={disabled}
    onChange={event => {setText(event.target.value); onChange(domainLines(event.target.value));}}/>;
}
/** Keep the existing settings controls and hierarchy; native names explain the provider's choices. */
export function NativePermissionFields({fields, value, disabled, onChange}: {fields: readonly NativeField[]; value: NativeSettings; disabled: boolean; onChange: (value: NativeSettings) => void}) {
  return <>{visibleNativeFields(fields, value).map(field => {
    const label = `${field.label}（${field.native}）`;
    const change = (next: unknown) => onChange({...value, [field.key]: next});
    return <SettingsRow key={field.key} className={field.kind === 'switch' ? undefined : 'group-choice-row'} title={label} description={field.hint}
      trailing={field.kind === 'choice' ? <SettingChoices label={label} value={typeof value[field.key] === 'string' ? value[field.key] as string : ''} disabled={disabled}
        choices={(field.choices ?? []).map(choice => ({value: choice.value, label: `${choice.label}（${choice.native}）`, description: choice.hint && <small>{choice.hint}</small>}))} onChange={change}/>
        : field.kind === 'switch' ? <Toggle className="settings-row-switch" label={label} aria-label={label} checked={value[field.key] === true} disabled={disabled} onChange={event => change(event.target.checked)}/>
          : <Domains label={label} value={value[field.key]} disabled={disabled} onChange={change}/>}/>;
  })}</>;
}
