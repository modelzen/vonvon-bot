import {useState, type ReactNode} from 'react';
import {Bot, Check, Copy} from 'lucide-react';
import type {RecipeConfig, RecipeDetail, RecipePublic, RecipeSummary} from '@vonvon/protocol';
import {Button} from '../reference/components/ui';

export const recipeSections = ['概览', '模型与权限', '能力', '沟通方式', '记忆', '任务', '使用前准备'] as const;
type Section = typeof recipeSections[number];


export function RecipeMark({name}: {name: string}) {
  return <span className="community-recipe-mark" aria-hidden="true">{name.trim() ? Array.from(name.trim())[0] : <Bot size={26}/>}</span>;
}

export function CopyButton({value, label = '分享链接'}: {value: string; label?: string}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <><Button variant="ghost" onClick={() => {void Promise.resolve().then(() => navigator.clipboard.writeText(value)).then(() => setState('copied'), () => setState('failed'));}}>{state === 'copied' ? <><Check size={14}/>已复制</> : <><Copy size={14}/>{label}</>}</Button>
    {state === 'failed' && <label className="community-copy-fallback">未能复制，请手动复制<input aria-label="手动复制" readOnly value={value} onFocus={event => event.target.select()}/></label>}</>;
}

function inline(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => part.startsWith('**') ? <strong key={i}>{part.slice(2,-2)}</strong> : part.startsWith('`') ? <code key={i}>{part.slice(1,-1)}</code> : part);
}
export function RecipeMarkdown({text}: {text: string}) {
  let code = false; let buffer: string[] = [];
  const nodes: ReactNode[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (code) {nodes.push(<pre key={nodes.length}><code>{buffer.join('\n')}</code></pre>); buffer = [];}
      code = !code; continue;
    }
    if (code) {buffer.push(line); continue;}
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) nodes.push(heading[1]!.length === 1 ? <h2 key={nodes.length}>{inline(heading[2]!)}</h2> : <h3 key={nodes.length}>{inline(heading[2]!)}</h3>);
    else if (/^[-*]\s/.test(line)) nodes.push(<p className="community-markdown-item" key={nodes.length}>• {inline(line.slice(2))}</p>);
    else if (line.trim()) nodes.push(<p key={nodes.length}>{inline(line)}</p>);
  }
  if (buffer.length) nodes.push(<pre key={nodes.length}><code>{buffer.join('\n')}</code></pre>);
  return <div className="community-markdown">{nodes}</div>;
}

export function RecipeMetadata({meta, revision}: {meta: RecipePublic | RecipeSummary['public']; revision?: number}) {
  return <dl className="community-metadata"><div><dt>版本</dt><dd>{meta.version || '未指定'}{revision ? <small>第 {revision} 次发布</small> : null}</dd></div><div><dt>获取方式</dt><dd>{meta.access === 'coded' ? '凭分享码获取' : '直接获取'}</dd></div></dl>;
}

export function RecipeConfiguration({config, section}: {config: RecipeConfig; section: Section}) {
  if (section === '模型与权限') return <div className="community-config"><h2>模型与权限</h2><dl><dt>推荐模型</dt><dd>未指定</dd><dt>权限要求</dt><dd>未指定</dd></dl></div>;
  if (section === '能力') return <div className="community-config"><h2>角色与规则</h2><RecipeMarkdown text={config.role || '未指定'}/><h3>技能</h3><p className="community-muted">未指定</p></div>;
  if (section === '沟通方式') return <div className="community-config"><h2>沟通方式</h2><p className="community-muted">未指定</p></div>;
  if (section === '记忆') return <div className="community-config"><h2>记忆</h2></div>;
  if (section === '任务') return <div className="community-config"><h2>任务</h2><p className="community-muted">没有任务</p></div>;
  return <div className="community-config"><h2>使用前准备</h2>{config.setup?.steps.length ? <ol className="community-setup">{config.setup.steps.map((step, i) => <li key={i}><div><strong>{step.title || '未命名步骤'}</strong><span>{step.required ? '必需' : '可选'}</span></div><RecipeMarkdown text={step.instructions}/>{step.check && <p className="community-muted">检查方式：{step.check}</p>}</li>)}</ol> : <p className="community-muted">无需额外准备</p>}</div>;
}

export function RecipeDetails({recipe, action, management, share}: {recipe: RecipeDetail; action?: ReactNode; management?: ReactNode; share?: ReactNode}) {
  const [section, setSection] = useState<Section>('概览');
  const allowed = Boolean(recipe.config);
  return <article className="community-detail">
    <header className="community-detail-heading"><RecipeMark name={recipe.public.name}/><div><h1>{recipe.public.name}</h1><p>{recipe.public.summary}</p></div><div className="community-actions">{share}{action}</div></header>
    <div className="community-detail-layout"><nav aria-label="配方详细信息">{recipeSections.filter(item => allowed || item === '概览').map(item => <button type="button" key={item} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{item}</button>)}</nav>
      <div className="community-detail-content">{section === '概览' ? <><RecipeMetadata meta={recipe.public} revision={recipe.revision}/><RecipeMarkdown text={recipe.public.overview ?? ''}/>{!allowed && <p className="community-access-note">获取此版本后，可以查看完整配置。</p>}{management}</> : recipe.config && <RecipeConfiguration config={recipe.config} section={section}/>}</div></div>
  </article>;
}

export function RecipeCard({recipe, hero, onOpen}: {recipe: RecipeSummary; hero?: boolean; onOpen: () => void}) {
  return <button type="button" className={`community-card${hero ? ' community-card--hero' : ''}`} onClick={onOpen}>
    {hero && <small className="community-card-eyebrow">最新配方</small>}<RecipeMark name={recipe.public.name}/><div className="community-card-copy"><h2>{recipe.public.name}</h2><p>{recipe.public.summary}</p><small>{recipe.public.version}{recipe.public.access === 'coded' && ' · 凭分享码获取'}</small></div>
  </button>;
}
