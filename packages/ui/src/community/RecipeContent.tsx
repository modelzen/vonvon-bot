import {useRecipeCardAlignment} from './use-recipe-card-alignment';
import {RecipeGroupConfiguration} from './RecipeGroupConfiguration';
import {RecipeSettingsConfiguration, RecipeTaskSummary} from './RichConfiguration';
import {useEffect, useState, type ReactNode} from 'react';
import {ArrowRight, ArrowUpRight, Bot, Check, Copy, KeyRound} from 'lucide-react';
import type {RecipeBrowseDetail, RecipeConfig, RecipeDetail, RecipePublic, RecipeSummary} from '@vonvon/protocol';
import {Button} from '../reference/components/ui';
import {SettingsGroup} from '../reference/components/system-settings';
import {useShellCapabilities} from '../client-context';
import {allowedExternalUrl, openExternalUrl} from '../url-actions';
import {useCommunity} from './community-context';
import {useAccount} from '../account-context';

export const recipeTabs = [
  {id: 'overview', label: '概览'}, {id: 'models', label: '模型与权限'}, {id: 'abilities', label: '能力'},
  {id: 'communication', label: '沟通方式'}, {id: 'tasks', label: '任务'},
] as const;
export type RecipeSection = typeof recipeTabs[number]['label'];
export const recipeSections = recipeTabs.map(tab => tab.label);
type Section = RecipeSection;


export function RecipeMark({name, logo}: {name: string; logo?: string}) {
  if (logo) return <img className="community-recipe-mark" alt="" src={logo}/>;
  return <span className="community-recipe-mark" aria-hidden="true"><Bot size={26} strokeWidth={1.65}/></span>;
}

function useRecipeLogo(recipe: Pick<RecipeDisplay, 'versionId' | 'logo' | 'hasDisplayLogo'>) {
  const shell = useCommunity()?.shell;
  const [loaded, setLoaded] = useState<{versionId: string; logo: string}>();
  const versionId = recipe.versionId;
  useEffect(() => {
    if (!shell || !versionId || recipe.logo || !recipe.hasDisplayLogo) return;
    let active = true;
    void shell.request({type: 'displayLogo', versionId}).then(result => {
      if (active) setLoaded({versionId, logo: result.logo});
    }).catch(() => {});
    return () => {active = false;};
  }, [shell, versionId, recipe.hasDisplayLogo, recipe.logo]);
  return recipe.logo ?? (loaded?.versionId === versionId ? loaded?.logo : undefined);
}

export function CopyButton({value, label = '复制链接'}: {value: string; label?: string}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <><Button variant="ghost" onClick={() => {void Promise.resolve().then(() => navigator.clipboard.writeText(value)).then(() => setState('copied'), () => setState('failed'));}}>{state === 'copied' ? <><Check size={14}/>已复制</> : <><Copy size={14}/>{label}</>}</Button>
    {state === 'failed' && <label className="community-copy-fallback">未能复制，请手动复制<input aria-label="手动复制" readOnly value={value} onFocus={event => event.target.select()}/></label>}</>;
}

function RecipeDocumentLink({href, children}: {href: string; children: string}) {
  const shell = useShellCapabilities();
  const [failed, setFailed] = useState(false);
  return <><a href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (!shell?.openExternal) return;
    event.preventDefault(); setFailed(false);
    void openExternalUrl(href, 'recipe-document', shell).catch(() => setFailed(true));
  }}>{children}</a>{failed && <span role="alert">（未能打开，请重试或复制链接）</span>}</>;
}
function inline(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2,-2)}</strong>;
    if (part.startsWith('`')) return <code key={i}>{part.slice(1,-1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    const href = link && allowedExternalUrl(link[2]!, 'recipe-document');
    return href ? <RecipeDocumentLink key={i} href={href}>{link![1]!}</RecipeDocumentLink> : part;
  });
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

export function RecipeVersion({version, revision, draft}: {version: string; revision?: number; draft?: boolean}) {
  const label = version || (draft ? '待填写' : '未指定');
  return <span className="recipe-version-inline"><span className="recipe-version-value" title={label}>{label}</span>{draft && revision ? <small className="recipe-version-revision">草稿修订 {revision}</small> : null}</span>;
}
export function RecipeMetadata({meta, revision, draft, author}: {author?:ReactNode;draft?:boolean;meta: RecipePublic | RecipeSummary['public']; revision?: number}) {
  return <dl className="community-metadata">
    {draft && <div><dt>可见范围</dt><dd>仅自己可见</dd></div>}
    {author && <div><dt>作者</dt><dd>{author}</dd></div>}
    <div className="recipe-version-meta"><dt>版本</dt><dd><RecipeVersion version={meta.version} revision={revision} draft={draft}/></dd></div>
    <div><dt>获取方式</dt><dd>{meta.access === 'coded' ? '凭分享码获取' : '直接获取'}</dd></div>
  </dl>;
}

export function RecipeConfiguration({config, section}: {config: RecipeConfig; section: Section}) {
  if (section === '模型与权限' || section === '沟通方式') return <RecipeSettingsConfiguration settings={[]} section={section}/>;
  if (section === '能力') return <div className="community-config"><h2>角色</h2><RecipeMarkdown text={config.role || '未指定'}/><h3>技能</h3><p className="community-muted">未指定</p></div>;
  if (section === '任务') return <RecipeTaskSummary count={0}/>;
  return null;
}

export type RecipeDisplay = Pick<RecipeDetail, 'public' | 'config' | 'rich' | 'logo'> & Partial<Pick<RecipeDetail, 'format' | 'state' | 'owned' | 'acquired' | 'revision' | 'creator' | 'versionId' | 'hasDisplayLogo'>> & {recipeId?: string | null} & Pick<RecipeBrowseDetail, 'preview' | 'previewUnavailable'>;
export function useCreatorName(creator: RecipeDetail['creator']) {
  const {status} = useAccount();
  return status?.kind === 'signedIn' && creator?.authorId === status.accountId ? status.displayName : creator?.displayName;
}
export function RecipeOverview({recipe, draft, showMetadata = true}: {recipe: RecipeDisplay; draft?: boolean; showMetadata?: boolean}) {
  const notes = recipe.rich?.content.setup ?? recipe.config?.setup?.steps ?? [];
  const author = useCreatorName(recipe.creator);
  return <>{showMetadata && <RecipeMetadata meta={recipe.public} revision={draft ? undefined : recipe.revision} author={recipe.creator && !draft ? <RecipeAuthor creator={recipe.creator}/> : author}/>}
    <SettingsGroup label="配方介绍"><div className="recipe-reading-surface">{recipe.public.overview?.trim()
      ? <RecipeMarkdown text={recipe.public.overview}/>
      : <p className="community-muted">{draft ? '暂未填写配方介绍，可在私聊中补充。' : '作者暂未填写配方介绍。'}</p>}</div></SettingsGroup>
    {notes.length > 0 && <details className="community-additional-notes"><summary>补充说明</summary>{notes.map((note, index) => <article key={index}><h3>{note.title || `说明 ${index + 1}`}</h3><RecipeMarkdown text={note.instructions}/>{note.check && <p>核对方式：{note.check}</p>}</article>)}</details>}
  </>;
}

export function RecipeDetails({recipe, action, management, share, draft, heading, overview, overviewFooter, sidebar, section: selectedSection, onSectionChange}: {draft?:boolean;recipe: RecipeDisplay; action?: ReactNode; management?: ReactNode; share?: ReactNode; heading?: ReactNode; overview?: ReactNode; overviewFooter?: ReactNode; sidebar?: ReactNode; section?: RecipeSection; onSectionChange?: (section: RecipeSection) => void}) {
  const logo = useRecipeLogo(recipe);
  const [localSection, setLocalSection] = useState<Section>('概览');
  const section = selectedSection ?? localSection;
  const setSection = (value: RecipeSection) => {setLocalSection(value); onSectionChange?.(value);};
  const allowed = Boolean(recipe.preview || recipe.config || recipe.rich);
  const published = !draft && !heading && Boolean(action);
  const hasSidebar = published || Boolean(sidebar);
  const reading = useRecipeCardAlignment(hasSidebar ? '.ss-section > .ss-group' : undefined);
  const name = draft ? recipe.public.name || '未命名配方' : recipe.public.name;
  return <article className={hasSidebar ? "community-detail community-published" : "community-detail"}>
    {heading ?? <header className="community-detail-heading">
      <RecipeMark name={name} logo={logo}/>
      <div><h1>{name}</h1>{(!draft || recipe.public.summary) && <p>{recipe.public.summary}</p>}</div>
      {!draft && !published && <div className="community-actions">{share}{action}</div>}
    </header>}
    <div className="community-detail-layout"><nav aria-label="配方详细信息">{recipeSections.filter(item => allowed || item === '概览').map(item => <button type="button" key={item} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{item}</button>)}</nav>
      <div className="community-detail-columns"><div className="community-detail-content" ref={reading}>{section === '概览' ? <>{overview ?? <RecipeOverview recipe={recipe} draft={draft} showMetadata={!hasSidebar}/>}{overviewFooter}{!allowed && <p className="community-access-note">{recipe.previewUnavailable ? '配置概览暂不可用，请稍后重新打开。' : '获取此版本后，可查看配方配置概览并交给自己的 Bot 使用。'}</p>}{!published && management}</> : <RecipeGroupConfiguration recipe={recipe} section={section} draft={draft}/>}</div>
    {sidebar}{published && <aside className="community-detail-sidebar" aria-label="获取与使用配方"><h2>这份配方</h2><RecipeMetadata meta={recipe.public} author={recipe.creator && <RecipeAuthor creator={recipe.creator}/>}/><div className="community-side-actions">{action}{share}{management}</div></aside>}</div></div>
  </article>;
}

function RecipeAuthor({creator}: {creator: NonNullable<RecipeSummary['creator']>}) {
  const community = useCommunity();
  const name = useCreatorName(creator);
  return community ? <button type="button" className="community-author-link" onClick={() => community.open({kind: 'author', authorId: creator.authorId})}>{name}</button> : <>{name}</>;
}

export function RecipeCard({recipe, hero, heroKind, onOpen, context = 'catalog', children}: {children?: ReactNode; recipe: RecipeSummary; hero?: boolean;heroKind?: 'featured'|'latest'|null; context?: 'catalog' | 'library'; onOpen: () => void}) {
  const author = useCreatorName(recipe.creator);
  const logo = useRecipeLogo(recipe);
  if (hero) return <div className="community-card-entry"><button type="button" className="community-card community-card--hero" aria-label={`${heroKind === 'featured' ? '场景精选' : '最新配方'}：${recipe.public.name}`} onClick={onOpen}>
    <div className="community-hero-copy"><h2>{recipe.public.name}</h2><p>{recipe.public.summary}</p><span className="community-hero-cta">查看「{recipe.public.name}」<ArrowRight size={15}/></span></div>
    <div className="community-recipe-cover" aria-hidden="true"><span className="community-recipe-stamp"><RecipeMark name={recipe.public.name} logo={logo}/></span><div className="community-recipe-paper"><strong>{recipe.public.name}</strong><div className="community-cover-meta"><span>{author}</span><span>{recipe.public.version}</span></div></div></div>
  </button>{recipe.creator && <div className="community-card-author">作者 <RecipeAuthor creator={recipe.creator}/></div>}</div>;
  return <article className={'community-card-entry community-tile' + (context === 'library' ? ' community-library-entry' : '')}><button type="button" className="community-card" onClick={onOpen}>
    <div className="community-card-top"><RecipeMark name={recipe.public.name} logo={logo}/>{context === 'catalog' && recipe.public.access === 'coded' && <span className="community-card-access"><KeyRound size={13}/>需分享码</span>}</div>
    <div className="community-card-copy"><h2>{recipe.public.name}</h2><p>{recipe.public.summary}</p></div><div className="community-card-footer"><small>{recipe.public.version}</small><ArrowUpRight size={15}/></div>
  </button>
    {(recipe.creator || children) && <div className="community-tile-meta">
      {recipe.creator && <div className="community-card-author">作者 <RecipeAuthor creator={recipe.creator}/></div>}
      {children}
    </div>}
  </article>;
}
