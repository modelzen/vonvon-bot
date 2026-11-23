import {useState} from 'react';
import {setupSkillsFirst, type ProjectSettingsView} from '@vonvon/protocol';
import {ChevronRight, RefreshCw, Search} from 'lucide-react';
import {Button, IconButton, Toggle} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SetupSkillBadge} from '../skills/SetupSkillBadge';

type Skills = NonNullable<ProjectSettingsView['skills']>;
const groups = [
  {source: 'workspace', title: '项目技能', description: '本项目提供及从配方安装的技能'},
  {source: 'user', title: '全局技能', description: '来自用户目录，可在多个项目中使用'},
  {source: 'provider', title: 'Provider 技能', description: 'Provider 自带或通过插件提供的技能'},
] as const satisfies readonly {source: Skills[number]['source']; title: string; description: string}[];

export function SkillsList({skills, disabledPaths, disabled, onToggle, refresh}: {
  skills: Skills; disabledPaths: string[]; disabled: boolean;
  onToggle: (path: string, enabled: boolean) => void; refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Skills[number]>();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState({workspace: true, user: false, provider: false});
  const needle = query.trim().toLocaleLowerCase();
  const visible = skills.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(needle));
  const isEnabled = (skill: Skills[number]) => skill.enabled && !disabledPaths.includes(skill.path);
  const enabledCount = skills.filter(isEnabled).length;
  return <>
    <div className="gd-section-heading gd-skill-heading">
      <label className="gd-skill-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="搜索技能" placeholder="搜索名称或说明" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="gd-skill-actions"><span className="gd-skill-count">{needle ? `${visible.length} / ${skills.length} 项` : `${skills.length} 项 · ${enabledCount} 已启用`}</span><IconButton size="sm" variant="ghost" label="重新读取" title="重新读取技能" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></div>
    </div>
    <div className="gd-skill-groups">
      {groups.map(group => {
        const total = skills.filter(skill => skill.source === group.source);
        const matches = setupSkillsFirst(visible.filter(skill => skill.source === group.source));
        if (needle ? !matches.length : group.source !== 'workspace' && !total.length) return null;
        return <details className="gd-skill-group" data-source={group.source} key={group.source}
          open={Boolean(needle) || expanded[group.source]} onToggle={event => {
            const open = event.currentTarget.open;
            if (!needle) setExpanded(previous => previous[group.source] === open ? previous : {...previous, [group.source]: open});
          }}>
          <summary><ChevronRight size={14} aria-hidden="true"/><span className="gd-skill-group-copy"><strong>{group.title}</strong><small>{group.description}</small></span>
            <span className="gd-skill-count">{needle ? `${matches.length} / ${total.length} 项` : `${total.length} 项 · ${total.filter(isEnabled).length} 已启用`}</span>
          </summary>
          <div className="gd-skill-list" role="list" aria-label={group.title}>
            {matches.length ? matches.map(skill => <div className="gd-skill-row" role="listitem" key={skill.path} data-enabled={isEnabled(skill)}>
              <button type="button" className="gd-skill-detail" onClick={() => setSelected(skill)}><span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}{!skill.enabled && !disabledPaths.includes(skill.path) && <small>Provider 已停用</small>}</span><ChevronRight size={14} aria-hidden="true"/></button>
              <SetupSkillBadge name={skill.name}/>
              <Toggle className="settings-row-switch" label={`使用 ${skill.name}`} aria-label={`使用 ${skill.name}`} checked={isEnabled(skill)} disabled={disabled || !skill.enabled && !disabledPaths.includes(skill.path)} onChange={event => onToggle(skill.path, event.target.checked)}/>
            </div>) : <p className="gd-empty">本项目尚未发现技能。配方安装的技能会显示在这里。</p>}
          </div>
        </details>;
      })}
      {needle && !visible.length && <div className="gd-empty" role="status">没有匹配的技能。<button type="button" className="gd-text-action" onClick={() => setQuery('')}>清除搜索</button></div>}
    </div>
    <Dialog open={Boolean(selected)} title={selected?.name ?? '技能'} onClose={() => setSelected(undefined)} footer={<Button onClick={() => setSelected(undefined)}>完成</Button>}>
      {selected && <dl className="gd-skill-facts"><div><dt>说明</dt><dd>{selected.description || '未提供说明'}</dd></div><div><dt>来源</dt><dd>{selected.path.startsWith('recipe:') ? '配方安装 · 项目技能' : groups.find(group => group.source === selected.source)?.title}</dd></div><div><dt>位置</dt><dd>{selected.path.startsWith('recipe:') ? '由本群配方管理' : selected.path}</dd></div></dl>}
    </Dialog>
  </>;
}
