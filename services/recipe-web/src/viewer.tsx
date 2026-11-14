import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import type {RecipeDetail} from '../../../packages/protocol/src/index';
import {RecipeDetails, CopyButton} from '../../../packages/ui/src/community/RecipeContent';
import {BackButton} from '../../../packages/ui/src/BackButton';
import {GlowButton} from '../../../packages/ui/src/GlowButton';
import '../../../packages/ui/src/community/community.css';
import '../../../packages/ui/src/reference/styles/components.css';
import './viewer.css';

let root: Root | undefined;
export function renderRecipe(host: HTMLElement, recipe: RecipeDetail, acquire: (button: HTMLButtonElement) => void) {
  root?.unmount();
  host.replaceChildren();
  const next = createRoot(host); root = next;
  flushSync(() => next.render(<div className="community-page web-recipe-view">
    <BackButton label="返回 Bot 配方" onClick={() => {location.href = '/';}}/>
    <RecipeDetails recipe={recipe} share={<CopyButton value={location.origin + location.pathname}/>}
      action={recipe.owned || recipe.acquired ? <span className="community-muted">{recipe.owned ? '我的作品' : '已获取'}</span> :
        <GlowButton variant="dark" onClick={event => acquire(event.currentTarget)}>获取配方</GlowButton>}/>
    {(recipe.owned || recipe.acquired) && <p className="community-access-note">配方已保存在当前账号。在 Vonvon Bot App 登录同一账号后，可将它添加到群聊。</p>}
  </div>));
}
