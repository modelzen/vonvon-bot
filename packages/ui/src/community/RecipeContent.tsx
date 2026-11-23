import {RichConfiguration} from './RichConfiguration';
import {useState, type ReactNode} from 'react';
import {ArrowRight, ArrowUpRight, Bot, Check, Copy, KeyRound} from 'lucide-react';
import type {RecipeConfig, RecipeDetail, RecipePublic, RecipeSummary} from '@vonvon/protocol';
import {Button} from '../reference/components/ui';

export const recipeSections = ['概览', '模型与权限', '能力', '沟通方式', '记忆', '任务'] as const;
type Section = typeof recipeSections[number];


export function RecipeMark({name, logo}: {name: string; logo?: string}) {
  if (logo) return <img className="community-recipe-mark" alt="" src={logo}/>;
  return <span className="community-recipe-mark" aria-hidden="true"><Bot size={26} strokeWidth={1.65}/></span>;
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
    if (heading) nodes.push(heading[1]!.length === 1 ? <h2 key={nodes.length}>{inline(heading[2]!)}</h2> : heading[1]!.length === 2 ? <h3 key={nodes.length}>{inline(heading[2]!)}</h3> : <h4 key={nodes.length}>{inline(heading[2]!)}</h4>);
    else if (/^[-*]\s/.test(line)) nodes.push(<p className="community-markdown-item" key={nodes.length}>• {inline(line.slice(2))}</p>);
    else if (line.trim()) nodes.push(<p key={nodes.length}>{inline(line)}</p>);
  }
  if (buffer.length) nodes.push(<pre key={nodes.length}><code>{buffer.join('\n')}</code></pre>);
  return <div className="community-markdown">{nodes}</div>;
}

export function RecipeMetadata({meta, revision, draft, author}: {author?:string;draft?:boolean;meta: RecipePublic | RecipeSummary['public']; revision?: number}) {
  return <dl className="community-metadata">{author && <div><dt>作者</dt><dd>{author}</dd></div>}<div><dt>版本</dt><dd>{meta.version || '未指定'}{revision ? <small>{draft ? `草稿修订 ${revision}` : `第 ${revision} 次发布`}</small> : null}</dd></div><div><dt>获取方式</dt><dd>{meta.access === 'coded' ? '凭分享码获取' : '直接获取'}</dd></div></dl>;
}

export function RecipeConfiguration({config, section}: {config: RecipeConfig; section: Section}) {
  if (section === '模型与权限') return <div className="community-config"><h2>模型与权限</h2><dl><dt>推荐模型</dt><dd>未指定</dd><dt>权限要求</dt><dd>未指定</dd></dl></div>;
  if (section === '能力') return <div className="community-config"><h2>角色与规则</h2><RecipeMarkdown text={config.role || '未指定'}/><h3>技能</h3><p className="community-muted">未指定</p></div>;
  if (section === '沟通方式') return <div className="community-config"><h2>沟通方式</h2><p className="community-muted">未指定</p></div>;
  if (section === '记忆') return <div className="community-config"><h2>记忆</h2></div>;
  if (section === '任务') return <div className="community-config"><h2>任务</h2><p className="community-muted">没有任务</p></div>;
  return null;
}

export function RecipeOverview({recipe, draft}: {recipe: Pick<RecipeDetail, 'public' | 'revision' | 'creator' | 'config' | 'rich'>; draft?: boolean}) {
  const notes = recipe.rich?.content.setup ?? recipe.config?.setup?.steps ?? [];
  return <><RecipeMetadata meta={recipe.public} revision={recipe.revision} draft={draft} author={recipe.creator?.displayName}/><RecipeMarkdown text={recipe.public.overview ?? ''}/>
    {notes.length > 0 && <details className="community-additional-notes"><summary>补充说明</summary>{notes.map((note, index) => <article key={index}><h3>{note.title || `说明 ${index + 1}`}</h3><RecipeMarkdown text={note.instructions}/>{note.check && <p>核对方式：{note.check}</p>}</article>)}</details>}
  </>;
}

export function RecipeDetails({recipe, action, management, share, draft}: {draft?:boolean;recipe: RecipeDetail; action?: ReactNode; management?: ReactNode; share?: ReactNode}) {
  const [section, setSection] = useState<Section>('概览');
  const allowed = Boolean(recipe.config || recipe.rich);
  return <article className="community-detail">
    <header className="community-detail-heading"><RecipeMark name={recipe.public.name} logo={recipe.logo}/><div><h1>{recipe.public.name}</h1><p>{recipe.public.summary}</p></div><div className="community-actions">{share}{action}</div></header>
    <div className="community-detail-layout"><nav aria-label="配方详细信息">{recipeSections.filter(item => allowed || item === '概览').map(item => <button type="button" key={item} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{item}</button>)}</nav>
      <div className="community-detail-content">{section === '概览' ? <><RecipeOverview recipe={recipe} draft={draft}/>{!allowed && <p className="community-access-note">获取此版本后，可以查看完整配置。</p>}{management}</> : recipe.rich ? <RichConfiguration view={recipe.rich} section={section}/> : recipe.config && <RecipeConfiguration config={recipe.config} section={section}/>}</div></div>
  </article>;
}

export function RecipeCard({recipe, hero, heroKind, onOpen, context = 'catalog'}: {recipe: RecipeSummary; hero?: boolean;heroKind?: 'featured'|'latest'|null; context?: 'catalog' | 'library'; onOpen: () => void}) {
  if (hero) return <button type="button" className="community-card community-card--hero" aria-label={`${heroKind === 'featured' ? '场景精选' : '最新配方'}：${recipe.public.name}`} onClick={onOpen}>
    <div className="community-hero-copy"><h2>{recipe.public.name}</h2><p>{recipe.public.summary}</p><span className="community-hero-cta">查看「{recipe.public.name}」<ArrowRight size={15}/></span></div>
    <div className="community-recipe-cover" aria-hidden="true"><span className="community-recipe-stamp"><RecipeMark name={recipe.public.name} logo={recipe.logo}/></span><div className="community-recipe-paper"><strong>{recipe.public.name}</strong><div className="community-cover-meta"><span>{recipe.creator?.displayName}</span><span>{recipe.public.version}</span></div></div></div>
  </button>;
  return <button type="button" className="community-card" onClick={onOpen}>
    <div className="community-card-top"><RecipeMark name={recipe.public.name} logo={recipe.logo}/>{context === 'catalog' && recipe.public.access === 'coded' && <span className="community-card-access"><KeyRound size={13}/>需分享码</span>}</div>
    <div className="community-card-copy"><h2>{recipe.public.name}</h2><p>{recipe.public.summary}</p></div><div className="community-card-footer"><small>{[recipe.creator?.displayName, recipe.public.version].filter(Boolean).join(' · ')}</small><ArrowUpRight size={15}/></div>
  </button>;
}
