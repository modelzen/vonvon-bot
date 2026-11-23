import {useRef, useState} from 'react';
import type {RecipeBrowsePreview} from '@vonvon/protocol';
import {isSetupSkillName, setupSkillsFirst} from '@vonvon/protocol';
import {setupSkillPurpose} from '../skills/SetupSkillBadge';
import {SkillDetailsButton} from '../skills/SkillDetailsButton';
import './recipe-skills.css';

type RecipeSkill = {itemId: string; name: string; description?: string};

export function RecipeSkillList({skills, onOpen}: {skills: RecipeSkill[]; onOpen: (skill: RecipeSkill) => void}) {
  return <ul className="recipe-skills-list" aria-label="配方技能">{setupSkillsFirst(skills).map(skill =>
    <li className="recipe-skills-row" key={skill.itemId}>
      <SkillDetailsButton name={skill.name} description={skill.description || '作者暂未填写技能说明。'} onOpen={() => onOpen(skill)}/>
    </li>
  )}</ul>;
}

export function RecipeSkills({skills}: {skills: RecipeBrowsePreview['skills']}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, select] = useState<RecipeSkill>();
  if (!skills.length) return <p className="community-muted">未选择技能</p>;
  return <div className="recipe-skills">
    <RecipeSkillList skills={skills} onOpen={skill => {select(skill); dialog.current?.showModal();}}/>
    <dialog ref={dialog} className="recipe-skill-dialog" aria-label={selected?.name || '技能'}>
      <h2>{selected?.name}</h2>
      <dl><dt>说明</dt><dd>{selected?.description || '作者暂未填写技能说明。'}</dd>
        {selected && isSetupSkillName(selected.name) && <><dt>Setup 用途</dt><dd>{setupSkillPurpose}</dd></>}
        <dt>来源</dt><dd>配方技能</dd><dt>位置</dt><dd>交给 Bot 后，由目标群聊管理。</dd></dl>
      <form method="dialog"><button type="submit">完成</button></form>
    </dialog>
  </div>;
}
