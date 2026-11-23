import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import type {RecipeBrowseDetail, RecipeDetail} from '../../../packages/protocol/src/index';
import {useEffect, useState} from 'react';
import {RecipeConfiguration, RecipeMarkdown, RecipeVersion, recipeTabs} from '../../../packages/ui/src/community/RecipeContent';
import {RecipeBrowseConfiguration, RichConfiguration} from '../../../packages/ui/src/community/RichConfiguration';
import {useRecipeCardAlignment} from '../../../packages/ui/src/community/use-recipe-card-alignment';
import './viewer.css';
import {recipeHandoffUrl} from '../public/app-links.mjs';

type RecipeReadView = RecipeDetail & Pick<RecipeBrowseDetail, 'preview' | 'previewUnavailable'>;
type DetailOrigin = 'catalog' | 'library' | 'library-all' | 'published' | 'author' | 'creator';
function WebRecipe({recipe, acquire, origin}: {recipe: RecipeReadView; acquire: (button: HTMLButtonElement) => void; origin: DetailOrigin}) {
  const allowed = Boolean(recipe.preview || recipe.rich || recipe.config);
  const [failedLogo, setFailedLogo] = useState(false);
  const logo = recipe.logo ?? (recipe.hasDisplayLogo && !failedLogo ? '/media/versions/' + recipe.versionId + '/logo.webp' : undefined);
  const available = allowed ? recipeTabs : recipeTabs.slice(0, 1);
  const hashSection = () => available.find(item => '#' + item.id === window.location.hash)?.id || 'overview';
  const [active, setActive] = useState(hashSection);
  const reading = useRecipeCardAlignment(active === 'overview' ? undefined : '#' + active + ' :is(.recipe-configuration-card, .recipe-skills)');
  useEffect(() => {
    const update = () => setActive(hashSection());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [allowed]);
  const notes = recipe.rich?.content.setup ?? recipe.config?.setup?.steps ?? [];
  const saved = recipe.owned || recipe.acquired;
  const handoffUrl = recipeHandoffUrl(document.documentElement.dataset.desktopChannel, recipe.recipeId, recipe.versionId);
  return <article className="web-recipe-view">
    <nav className="web-breadcrumb" aria-label="当前位置">
      <a href={origin === 'library-all' ? '/library?state=all' : origin === 'creator' || origin === 'published' ? '/library?state=published' : origin === 'library' ? '/library?state=acquired' : origin === 'author' && recipe.creator ? '/authors/' + encodeURIComponent(recipe.creator.authorId) : '/'}>{origin === 'creator' || origin === 'library' || origin === 'library-all' || origin === 'published' ? '我的配方' : origin === 'author' ? '作者的配方' : '配方社区'}</a><span aria-hidden="true">/</span><span>配方详情</span><small className="readonly-label">只读配置</small>
    </nav>
    <header className="web-recipe-heading">
      {logo ? <img className="web-recipe-logo" src={logo} alt="" onError={() => setFailedLogo(true)}/> : <span className="web-recipe-logo web-recipe-monogram" aria-hidden="true">{Array.from(recipe.public.name)[0]}</span>}
      <div><h1>{recipe.public.name}</h1><p className="web-recipe-summary">{recipe.public.summary}</p></div>
    </header>
    <nav className="web-contents" aria-label="配方详细信息">{available.map(section => <a key={section.id} href={'#' + section.id} aria-current={active === section.id ? 'page' : undefined} onClick={event => {if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); history.replaceState(history.state,'','#'+section.id); setActive(section.id);}}>{section.label}</a>)}</nav>
    <div className="web-recipe-layout">
      <div className="web-recipe-reading" ref={reading}>
        <section hidden={active !== 'overview'} id="overview" className="web-recipe-section" aria-labelledby="overview-title">
          <h2 className="sr-only" id="overview-title">概览</h2>
          {recipe.public.overview ? <RecipeMarkdown text={recipe.public.overview}/> : <p className="muted">作者暂未添加详细介绍。</p>}
          {notes.length > 0 && <details className="web-recipe-notes"><summary>补充说明</summary>{notes.map((note, index) => <article key={index}>
            <h3>{note.title || `说明 ${index + 1}`}</h3><RecipeMarkdown text={note.instructions}/>{note.check && <p>核对方式：{note.check}</p>}
          </article>)}</details>}
          {!allowed && recipe.state !== 'deleted' && recipe.state !== 'withdrawn' && <div className="web-locked"><h3>{recipe.previewUnavailable ? '配置概览暂不可用' : '获取后查看配置概览'}</h3><p>{recipe.previewUnavailable ? '请稍后重新打开，已获取的使用权会保留。' : '获取此版本后，可查看技能说明、模型与权限等配置概览，并交给自己的 Bot 使用。'}</p></div>}
        </section>
        {allowed && available.slice(1).map(section => <section hidden={active !== section.id} id={section.id} className="web-recipe-section" aria-label={section.label} key={section.id}>
          {recipe.preview ? <RecipeBrowseConfiguration preview={recipe.preview} section={section.label}/> : recipe.rich ? <RichConfiguration view={recipe.rich} section={section.label}/> : recipe.config && <RecipeConfiguration config={recipe.config} section={section.label}/>}
        </section>)}
      </div>
      <aside className="web-recipe-sidebar" aria-label="获取与使用配方">
        <div className="web-acquire-panel">
          <p className="eyebrow">这份配方</p>
          <dl className="web-recipe-facts">
            <div><dt>作者</dt><dd>{recipe.creator ? <a className="author-link" href={'/authors/' + encodeURIComponent(recipe.creator.authorId)}>{recipe.creator.displayName}</a> : '未设置公开署名'}</dd></div>
            <div><dt>版本</dt><dd><RecipeVersion version={recipe.public.version} revision={recipe.revision}/></dd></div>
            <div><dt>获取方式</dt><dd>{recipe.public.access === 'coded' ? '凭分享码获取' : '直接获取'}</dd></div>
          </dl>
          {recipe.state === 'withdrawn' || recipe.state === 'deleted' ? <p role="status">{recipe.state === 'deleted' ? '已删除' : '已下架'}。已部署到群聊的配置会保留。</p> : saved ? <div className="web-recipe-actions">
            <p className="web-saved" role="status">{recipe.owned ? '我的作品' : '已获取此版本'}</p>
            {handoffUrl && <a className="button" href={handoffUrl} data-handoff-recipe data-recipe-id={recipe.recipeId} data-version-id={recipe.versionId}>在 App 中交给 Bot</a>}
            <a className="secondary" href={'/library?state=' + (recipe.owned ? 'published' : 'acquired') + '#recipe=' + recipe.recipeId + '&version=' + recipe.versionId}>去我的配方查看</a>
          </div> : <><button className="button" type="button" onClick={event => acquire(event.currentTarget)}>获取配方</button>
            {recipe.public.access === 'coded' && <p className="fine">需要作者提供的分享码。</p>}</>}
        </div>
      </aside>
    </div>
    <div className="web-recipe-end"><a href="/">继续浏览社区 →</a></div>
  </article>;
}

let root: Root | undefined;
export function renderRecipe(host: HTMLElement, recipe: RecipeReadView, acquire: (button: HTMLButtonElement) => void, origin: DetailOrigin = 'catalog') {
  root?.unmount();
  host.replaceChildren();
  const next = createRoot(host); root = next;
  flushSync(() => next.render(<WebRecipe recipe={recipe} acquire={acquire} origin={origin}/>));
}
