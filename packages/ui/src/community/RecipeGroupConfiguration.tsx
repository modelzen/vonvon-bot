import {RecipeCommunication, RecipeModelSettings} from './RecipeModelAndCommunication';
import {recipeSkillDescription} from '@vonvon/protocol';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {ReadonlyRecipeSkills} from '../settings/GroupSkills';
import {RecipeMarkdown, type RecipeDisplay, type RecipeSection} from './RecipeContent';
import {richText} from './RichConfiguration';
import {RecipeTasks} from './RecipeTasks';

export function RecipeGroupConfiguration({recipe, section}: {recipe: RecipeDisplay; section: RecipeSection}) {
  const rich = recipe.rich, preview = recipe.preview;
  const settings = preview?.settings ?? rich?.content.settings ?? [];
  if (section === '任务') return <RecipeTasks recipe={recipe}/>;
  if (section === '能力') {
    const role = recipe.config?.role ?? (rich?.content.role && richText(rich.content.role.text, rich));
    const voice = settings.find(setting => setting.field === 'presentation.voiceEnabled')?.value;
    const skills = preview?.skills ?? rich?.content.skills.map(skill => {
      const entry = rich.content.files.find(file => file.itemId === skill.entryFileId);
      return {itemId:skill.itemId, name:skill.name, description:entry ? recipeSkillDescription(richText(entry.text,rich)) : ''};
    }) ?? [];
    return <div className="gd-page">
      <SettingsGroup label="技能"><ReadonlyRecipeSkills skills={skills}/></SettingsGroup>
      <SettingsGroup label="语音"><SettingsRow title="语音转文字"
        value={voice === undefined ? preview?.omittedSettingCount ? '概览未提供' : '未指定' : voice ? '开启' : '关闭'}/></SettingsGroup>
      <SettingsGroup label="本群角色">{role
        ? <div className="recipe-reading-surface"><RecipeMarkdown text={role}/></div>
        : <SettingsRow title={preview ? '角色说明' : '未指定本群角色'} description={preview ? '交给 Bot 时读取配方中的角色配置。' : '沿用目标群聊的角色。'}/>}</SettingsGroup>
    </div>;
  }
  if (section === '沟通方式') return <RecipeCommunication settings={settings} omitted={preview?.omittedSettingCount}
    ruleCount={preview?.ruleCount ?? rich?.content.rules.length ?? 0}/>;
  return <RecipeModelSettings settings={settings} omitted={preview?.omittedSettingCount}/>;
}
