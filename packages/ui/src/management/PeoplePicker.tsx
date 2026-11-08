import type {ReactNode} from 'react';
import {Button} from '../reference/components/ui';
import {Person} from './Person';

export type PickablePerson = {openId: string; name: string; tag?: string; source?: string};
export const matchesPerson = (person: PickablePerson, query: string): boolean => {
  const text = query.trim().toLocaleLowerCase();
  return !text || person.name.toLocaleLowerCase().includes(text) || person.openId.toLocaleLowerCase().includes(text);
};

export function PeopleSearch({query, onChange, label = '搜索'}: {query: string; onChange: (query: string) => void; label?: string}) {
  return <input className="admin-search" aria-label={label} placeholder="搜索姓名" autoComplete="off" value={query} onChange={event => onChange(event.target.value)}/>;
}

/** Shared picker rows; callers retain their own authorized roster and mutations. */
export function PeopleRows({people, label, disabled, onPick, empty, children}: {
  people: readonly PickablePerson[]; label: string; disabled: boolean; onPick: (openId: string) => void; empty: string; children?: ReactNode;
}) {
  return <div className="admin-list" role="list" aria-label={label}>
    {people.map(person => <div className="admin-pick" role="listitem" key={person.openId}>
      <Person name={person.name || `…${person.openId.slice(-6)}`} tag={person.tag}/>
      {person.source && <span className="admin-source">{person.source}</span>}
      <Button size="sm" disabled={disabled} aria-label={`添加 ${person.name || `…${person.openId.slice(-6)}`}`} onClick={() => {if (!disabled) onPick(person.openId);}}>添加</Button>
    </div>)}
    {!people.length && <p className="admin-empty">{empty}</p>}
    {children}
  </div>;
}
