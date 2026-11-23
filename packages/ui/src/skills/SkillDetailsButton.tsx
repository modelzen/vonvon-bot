import {ChevronRight} from 'lucide-react';
import {SetupSkillBadge} from './SetupSkillBadge';

export function SkillDetailsButton({name, description, note, onOpen}: {
  name: string; description?: string; note?: string; onOpen: () => void;
}) {
  return <button type="button" className="gd-skill-detail" aria-label={name} aria-haspopup="dialog" onClick={onOpen}>
    <span className="recipe-skills-copy">
      <span className="recipe-skills-name"><strong>{name}</strong><SetupSkillBadge name={name} showInfo={false}/></span>
      {description && <small className="recipe-skills-description">{description}</small>}
      {note && <small>{note}</small>}
    </span>
    <ChevronRight size={15} aria-hidden="true"/>
  </button>;
}
