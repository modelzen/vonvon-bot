import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import type {RecipeBrowseDetail, RecipeDetail} from '../../../packages/protocol/src/index';
import {useState} from 'react';
import {RecipeMarkdown} from '../../../packages/ui/src/community/RecipeContent';
import {RecipeBrowseConfiguration, RichConfiguration} from '../../../packages/ui/src/community/RichConfiguration';
import './viewer.css';

const sections = [
  {id: 'overview', label: '概览'}, {id: 'models', label: '模型与权限'},
  {id: 'abilities', label: '能力'}, {id: 'communication', label: '沟通方式'}, {id: 'tasks', label: '任务'},
];

function ShareLink() {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const url = location.origin + location.pathname;
  return <div className="web-share">
    <button className="secondary" type="button" onClick={() => {
      void Promise.resolve().then(() => navigator.clipboard.writeText(url)).then(() => setState('copied'), () => setState('manual'));
    }}>{state === 'copied' ? '已复制链接' : '复制链接'}</button>
    {state === 'manual' && <label>请手动复制链接<input aria-label="手动复制" readOnly value={url} onFocus={event => event.target.select()}/></label>}
  </div>;
}

type RecipeReadView = RecipeDetail & Pick<RecipeBrowseDetail, 'preview' | 'previewUnavailable'>;
function WebRecipe({recipe, acquire, origin}: {recipe: RecipeReadView; acquire: (button: HTMLButtonElement) => void; origin: 'catalog' | 'library' | 'published' | 'author'}) {
  const allowed = Boolean(recipe.preview || recipe.rich || recipe.config);
  const [failedLogo, setFailedLogo] = useState(false);
  const logo = recipe.logo ?? (recipe.hasDisplayLogo && !failedLogo ? '/media/versions/' + recipe.versionId + '/logo.webp' : undefined);
  const available = allowed ? sections : sections.slice(0, 1);
  const notes = recipe.rich?.content.setup ?? recipe.config?.setup?.steps ?? [];
  const saved = recipe.owned || recipe.acquired;
  const createUrl = document.documentElement.dataset.recipeCreateUrl;
  const creationHref = createUrl === 'vonvon://recipes/create' || createUrl === 'vonvon-preview://recipes/create' ? createUrl : '/studio';
  return <article className="web-recipe-view">
    <nav className="web-breadcrumb" aria-label="当前位置">
      <a href={origin === 'library' ? '/library' : origin === 'published' ? '/publications' : origin === 'author' && recipe.creator ? '/authors/' + encodeURIComponent(recipe.creator.authorId) : '/'}>{origin === 'library' ? '已获取' : origin === 'published' ? '我发布的' : origin === 'author' ? '作者的配方' : '配方社区'}</a><span aria-hidden="true">/</span><span>配方详情</span>
    </nav>
    <header className="web-recipe-heading">
      {logo ? <img className="web-recipe-logo" src={logo} alt="" onError={() => setFailedLogo(true)}/> : <span className="web-recipe-logo web-recipe-monogram" aria-hidden="true">{Array.from(recipe.public.name)[0]}</span>}
      <div><p className="eyebrow">社区配方 · {recipe.public.version}</p><h1>{recipe.public.name}</h1><p className="web-recipe-summary">{recipe.public.summary}</p></div>
    </header>
    <div className="web-recipe-layout">
      <aside className="web-recipe-sidebar" aria-label="获取与使用配方">
        <div className="web-acquire-panel">
          <p className="eyebrow">这份配方</p>
          <dl className="web-recipe-facts">
            <div><dt>作者</dt><dd>{recipe.creator ? <a className="author-link" href={'/?q=' + encodeURIComponent(recipe.creator.displayName)}>{recipe.creator.displayName}</a> : '未设置公开署名'}</dd></div>
            <div><dt>版本</dt><dd>{recipe.public.version}<small>第 {recipe.revision} 次发布</small></dd></div>
            <div><dt>获取方式</dt><dd>{recipe.public.access === 'coded' ? '凭分享码获取' : '直接获取'}</dd></div>
          </dl>
          {saved ? <p className="web-saved" role="status">{recipe.owned ? '我的作品' : '已获取此版本'}</p> : <button className="button" type="button" onClick={event => acquire(event.currentTarget)}>获取配方</button>}
          <p className="fine">{saved ? '配方已保存在当前账号。在 App 登录同一账号后即可使用。' : recipe.public.access === 'coded' ? '需要作者提供的分享码。获取后保存在你的账号中。' : '获取后保存在你的账号中，可在 App 中使用。'}</p>
          <ShareLink/>
        </div>
        <section className="web-use-guide" aria-labelledby="use-title"><h2 id="use-title">在自己的 Bot 中使用</h2><ol>
          <li>获取配方，保存到自己的账号。</li><li>在 Vonvon Bot App 登录同一账号。</li><li>将配方交给 Bot，在私聊中说明如何调整配置。</li>
        </ol><a href="https://vonvon.cc/docs/">阅读使用文档 ↗</a></section>
      </aside>
      <div className="web-recipe-reading">
        <nav className="web-contents" aria-label="配方详细信息">{available.map(section => <a key={section.id} href={'#' + section.id}>{section.label}</a>)}</nav>
        <section id="overview" className="web-recipe-section" aria-labelledby="overview-title">
          <h2 id="overview-title">概览</h2>
          {recipe.public.overview ? <RecipeMarkdown text={recipe.public.overview}/> : <p className="muted">作者暂未添加详细介绍。</p>}
          {notes.length > 0 && <details className="web-recipe-notes"><summary>补充说明</summary>{notes.map((note, index) => <article key={index}>
            <h3>{note.title || `说明 ${index + 1}`}</h3><RecipeMarkdown text={note.instructions}/>{note.check && <p>核对方式：{note.check}</p>}
          </article>)}</details>}
          {!allowed && <div className="web-locked"><h3>{recipe.previewUnavailable ? '配置概览暂不可用' : '获取后查看配置概览'}</h3><p>{recipe.previewUnavailable ? '请稍后重新打开，已获取的使用权会保留。' : '获取此版本后，可查看技能说明、模型与权限等配置概览，并交给自己的 Bot 使用。'}</p></div>}
        </section>
        {allowed && available.slice(1).map(section => <section id={section.id} className="web-recipe-section" aria-label={section.label} key={section.id}>
          {recipe.preview ? <RecipeBrowseConfiguration preview={recipe.preview} section={section.label}/> : recipe.rich ? <RichConfiguration view={recipe.rich} section={section.label}/> : <><h2>{section.label}</h2><p>{section.id === 'abilities' ? recipe.config?.role || '未指定' : '未指定'}</p></>}
        </section>)}
      </div>
    </div>
    <div className="web-recipe-end"><a href="/">继续浏览社区 →</a><a href={creationHref} data-create-recipe="">分享我的配方 →</a></div>
  </article>;
}

let root: Root | undefined;
export function renderRecipe(host: HTMLElement, recipe: RecipeReadView, acquire: (button: HTMLButtonElement) => void, origin: 'catalog' | 'library' | 'published' | 'author' = 'catalog') {
  root?.unmount();
  host.replaceChildren();
  const next = createRoot(host); root = next;
  flushSync(() => next.render(<WebRecipe recipe={recipe} acquire={acquire} origin={origin}/>));
}
