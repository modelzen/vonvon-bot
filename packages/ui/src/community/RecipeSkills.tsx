import {useState} from 'react';
import {Search} from 'lucide-react';
import type {RecipeBrowsePreview} from '@vonvon/protocol';
import {setupSkillsFirst} from '@vonvon/protocol';
import {SetupSkillBadge} from '../skills/SetupSkillBadge';
import './recipe-skills.css';

export function RecipeSkills({skills}: {skills: RecipeBrowsePreview['skills']}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const visible = setupSkillsFirst(skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)));
  if (!skills.length) return <p className="community-muted">未选择技能</p>;
  return <div className="recipe-skills">
    <div className="recipe-skills-heading">
      <label className="recipe-skills-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <span className="recipe-skills-count">{needle ? `${visible.length} / ${skills.length} 项` : `${skills.length} 项`}</span>
    </div>
    {visible.length ? <ul className="recipe-skills-list" aria-label="配方技能">{visible.map(skill => <li className="recipe-skills-row" key={skill.itemId}>
      <div className="recipe-skills-name"><strong>{skill.name}</strong><SetupSkillBadge name={skill.name}/></div><p>{skill.description || '作者暂未填写技能说明。'}</p>
    </li>)}</ul> : <div className="recipe-skills-empty" role="status">没有匹配的技能。<button type="button" onClick={() => setQuery('')}>清除搜索</button></div>}
  </div>;
}
